import express from "express";
import { existsSync, readFileSync } from "node:fs";
import {
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

type ProxyEnv = {
  forgeApiKey: string;
  publicBaseUrl: string;
  r2Bucket: string;
  r2Endpoint: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  port: number;
};

function loadDotEnvFromDisk(): void {
  const envPath = ".env";
  if (!existsSync(envPath)) {
    return;
  }

  const source = readFileSync(envPath, "utf8");
  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) {
      continue;
    }

    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

loadDotEnvFromDisk();

const REQUIRED_ENV_KEYS = [
  "FORGE_API_KEY",
  "PUBLIC_BASE_URL",
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
] as const;

function readEnv(name: string): string {
  return typeof process.env[name] === "string" ? process.env[name]! : "";
}

function hasEnv(name: string): boolean {
  return readEnv(name).trim().length > 0;
}

function logEnvPresence(): void {
  console.log(
    "ENV DEBUG:",
    JSON.stringify({
      R2_BUCKET: readEnv("R2_BUCKET"),
    })
  );
  console.log(
    "ENV KEYS PRESENT:",
    JSON.stringify(
      Object.fromEntries(REQUIRED_ENV_KEYS.map(key => [key, hasEnv(key)]))
    )
  );
}

function getEnv(name: string): string {
  const rawValue = readEnv(name);
  const value = rawValue.trim();
  if (!value) {
    console.error(
      JSON.stringify({
        level: "error",
        msg: "storage_proxy_env_missing",
        name,
        hasKey: Object.prototype.hasOwnProperty.call(process.env, name),
      })
    );
    throw new Error(`${name} is missing`);
  }
  return value;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizeObjectKey(value: string): string {
  return value.replace(/^\/+/, "").trim();
}

function buildR2Endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

function loadConfig(): ProxyEnv {
  logEnvPresence();

  const configuredEndpoint = readEnv("R2_ENDPOINT").trim();

  const publicBaseUrl = getEnv("PUBLIC_BASE_URL");
  new URL(publicBaseUrl);

  return {
    forgeApiKey: getEnv("FORGE_API_KEY"),
    publicBaseUrl: publicBaseUrl.replace(/\/+$/, ""),
    r2Bucket: getEnv("R2_BUCKET"),
    r2Endpoint: configuredEndpoint || buildR2Endpoint(getEnv("R2_ACCOUNT_ID")),
    r2AccessKeyId: getEnv("R2_ACCESS_KEY_ID"),
    r2SecretAccessKey: getEnv("R2_SECRET_ACCESS_KEY"),
    port: Number.parseInt(process.env.PORT ?? "8787", 10) || 8787,
  };
}

function createS3Client(config: ProxyEnv): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: config.r2Endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
    },
  });
}

function buildPublicUrl(config: ProxyEnv, objectKey: string): string {
  return new URL(normalizeObjectKey(objectKey), ensureTrailingSlash(config.publicBaseUrl)).toString();
}

function getBearerToken(authorization: string | undefined): string | null {
  if (!authorization) {
    return null;
  }

  const trimmed = authorization.trim();
  if (trimmed.length < 8 || trimmed.slice(0, 7).toLowerCase() !== "bearer ") {
    return null;
  }

  const token = trimmed.slice(7).trim();
  return token || null;
}

function readRawBody(req: express.Request): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", chunk => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

async function readMultipartFile(req: express.Request): Promise<{
  buffer: Buffer;
  contentType: string;
  fileName: string;
}> {
  const rawBody = await readRawBody(req);
  const request = new Request("http://storage-proxy.local/upload", {
    method: "POST",
    headers: req.headers as HeadersInit,
    body: rawBody,
  });
  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    throw new Error("multipart form field 'file' is required");
  }

  return {
    buffer: Buffer.from(await file.arrayBuffer()),
    contentType: file.type || "application/octet-stream",
    fileName: file.name || "file",
  };
}

function logJson(level: "info" | "warn" | "error", payload: Record<string, unknown>): void {
  const serialized = JSON.stringify({ level, ...payload });
  if (level === "error") {
    console.error(serialized);
    return;
  }
  if (level === "warn") {
    console.warn(serialized);
    return;
  }
  console.info(serialized);
}

export function createStorageProxyApp(config: ProxyEnv): express.Express {
  const app = express();
  const s3 = createS3Client(config);

  app.get("/healthz", (_req, res) => {
    res.status(200).send("ok");
  });

  app.use((req, res, next) => {
    const token = getBearerToken(req.header("authorization"));
    if (token !== config.forgeApiKey) {
      logJson("warn", {
        msg: "storage_proxy_auth_failed",
        method: req.method,
        path: req.path,
      });
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  });

  app.post("/v1/storage/upload", async (req, res) => {
    const objectKey = normalizeObjectKey(String(req.query.path ?? ""));
    if (!objectKey) {
      res.status(400).json({ error: "Query param 'path' is required" });
      return;
    }

    try {
      const file = await readMultipartFile(req);
      await s3.send(
        new PutObjectCommand({
          Bucket: config.r2Bucket,
          Key: objectKey,
          Body: file.buffer,
          ContentType: file.contentType,
        })
      );

      const publicUrl = buildPublicUrl(config, objectKey);
      logJson("info", {
        msg: "storage_proxy_upload_success",
        objectKey,
        contentType: file.contentType,
        fileName: file.fileName,
        publicUrl,
      });
      res.status(200).json({ url: publicUrl });
    } catch (error) {
      logJson("error", {
        msg: "storage_proxy_upload_failed",
        objectKey,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({ error: "Upload failed" });
    }
  });

  app.get("/v1/storage/downloadUrl", async (req, res) => {
    const objectKey = normalizeObjectKey(String(req.query.path ?? ""));
    if (!objectKey) {
      res.status(400).json({ error: "Query param 'path' is required" });
      return;
    }

    try {
      await s3.send(
        new HeadObjectCommand({
          Bucket: config.r2Bucket,
          Key: objectKey,
        })
      );

      const publicUrl = buildPublicUrl(config, objectKey);
      logJson("info", {
        msg: "storage_proxy_download_url",
        objectKey,
        publicUrl,
      });
      res.status(200).json({ url: publicUrl });
    } catch (error) {
      logJson("error", {
        msg: "storage_proxy_download_url_failed",
        objectKey,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(404).json({ error: "Object not found" });
    }
  });

  app.delete("/v1/storage/object", async (req, res) => {
    const objectKey = normalizeObjectKey(String(req.query.path ?? ""));
    if (!objectKey) {
      res.status(400).json({ error: "Query param 'path' is required" });
      return;
    }

    try {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: config.r2Bucket,
          Key: objectKey,
        })
      );

      logJson("info", {
        msg: "storage_proxy_delete_success",
        objectKey,
      });
      res.status(204).send();
    } catch (error) {
      logJson("error", {
        msg: "storage_proxy_delete_failed",
        objectKey,
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(502).json({ error: "Delete failed" });
    }
  });

  return app;
}

export function startStorageProxy(): void {
  const config = loadConfig();
  const app = createStorageProxyApp(config);
  const host = "0.0.0.0";

  app.listen(config.port, host, () => {
    logJson("info", {
      msg: "storage_proxy_started",
      host,
      port: config.port,
      bind: `${host}:${config.port}`,
      publicBaseUrl: config.publicBaseUrl,
      r2Bucket: config.r2Bucket,
      r2Endpoint: config.r2Endpoint,
    });
  });
}

const entryScript = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (/\/index\.(?:ts|js|cjs)$/u.test(entryScript)) {
  startStorageProxy();
}
