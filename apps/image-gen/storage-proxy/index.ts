import express from "express";
import { createHash } from "node:crypto";
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
  maxUploadBytes: number;
};

const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

class PayloadTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super("payload_too_large");
    this.name = "PayloadTooLargeError";
  }
}

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

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const rawValue = readEnv(name).trim();
  if (!rawValue) {
    return fallback;
  }

  const value = Number.parseInt(rawValue, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
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
    maxUploadBytes: readPositiveIntegerEnv(
      "MAX_UPLOAD_BYTES",
      DEFAULT_MAX_UPLOAD_BYTES
    ),
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

function getRequestContentLength(req: express.Request): number | null {
  const value = req.header("content-length");
  if (!value) {
    return null;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function readRawBody(req: express.Request, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const contentLength = getRequestContentLength(req);
    if (contentLength !== null && contentLength > maxBytes) {
      reject(new PayloadTooLargeError(maxBytes));
      req.destroy();
      return;
    }

    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const rejectOnce = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
      req.destroy(error);
    };

    req.on("data", chunk => {
      if (settled) {
        return;
      }

      const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += piece.length;
      if (totalBytes > maxBytes) {
        rejectOnce(new PayloadTooLargeError(maxBytes));
        return;
      }

      chunks.push(piece);
    });
    req.on("end", () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(Buffer.concat(chunks));
    });
    req.on("error", error => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    });
  });
}

async function readMultipartFile(
  req: express.Request,
  maxBytes: number
): Promise<{
  buffer: Buffer;
  contentType: string;
  fileName: string;
}> {
  const rawBody = await readRawBody(req, maxBytes);
  const request = new Request("http://storage-proxy.local/upload", {
    method: "POST",
    headers: req.headers as HeadersInit,
    body: new Uint8Array(rawBody),
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

function hashForLog(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function objectKeyLogFields(objectKey: string): Record<string, unknown> {
  return {
    objectKeyHash: hashForLog(objectKey),
  };
}

function fileNameLogFields(fileName: string): Record<string, unknown> {
  return {
    fileNameHash: hashForLog(fileName),
  };
}

function storageErrorLogFields(error: unknown): Record<string, unknown> {
  return {
    errorName: error instanceof Error ? error.name : typeof error,
    statusCode: getStorageErrorStatusCode(error),
  };
}

function getStorageErrorStatusCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("$metadata" in error)) {
    return undefined;
  }

  const metadata = (error as { $metadata?: { httpStatusCode?: unknown } })
    .$metadata;
  return typeof metadata?.httpStatusCode === "number"
    ? metadata.httpStatusCode
    : undefined;
}

function isMissingStorageObjectError(error: unknown): boolean {
  const statusCode = getStorageErrorStatusCode(error);
  if (statusCode === 404) {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "NotFound" || error.name === "NoSuchKey";
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
      const file = await readMultipartFile(req, config.maxUploadBytes);
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
        ...objectKeyLogFields(objectKey),
        contentType: file.contentType,
        ...fileNameLogFields(file.fileName),
        sizeBytes: file.buffer.byteLength,
      });
      res.status(200).json({ url: publicUrl });
    } catch (error) {
      if (error instanceof PayloadTooLargeError) {
        logJson("warn", {
          msg: "storage_proxy_upload_rejected",
          ...objectKeyLogFields(objectKey),
          reason: "payload_too_large",
          maxUploadBytes: error.maxBytes,
        });
        res.status(413).json({ error: "Payload too large" });
        return;
      }

      logJson("error", {
        msg: "storage_proxy_upload_failed",
        ...objectKeyLogFields(objectKey),
        ...storageErrorLogFields(error),
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
        ...objectKeyLogFields(objectKey),
      });
      res.status(200).json({ url: publicUrl });
    } catch (error) {
      logJson("error", {
        msg: "storage_proxy_download_url_failed",
        ...objectKeyLogFields(objectKey),
        ...storageErrorLogFields(error),
      });
      if (isMissingStorageObjectError(error)) {
        res.status(404).json({ error: "Object not found" });
        return;
      }
      res.status(502).json({ error: "Download URL lookup failed" });
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
        ...objectKeyLogFields(objectKey),
      });
      res.status(204).send();
    } catch (error) {
      logJson("error", {
        msg: "storage_proxy_delete_failed",
        ...objectKeyLogFields(objectKey),
        ...storageErrorLogFields(error),
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
