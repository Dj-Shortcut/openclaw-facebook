import express from "express";
import helmet from "helmet";
import rateLimit, { ipKeyGenerator, type Store } from "express-rate-limit";
import { Redis } from "ioredis";
import { RedisStore, type RedisReply } from "rate-limit-redis";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import {
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

type StorageProxyAppConfig = {
  forgeApiKey: string;
  publicBaseUrl: string;
  r2Bucket: string;
  r2Endpoint: string;
  r2AccessKeyId: string;
  r2SecretAccessKey: string;
  port: number;
  maxUploadBytes: number;
  storageOperationTimeoutMs: number;
  allowLegacyBearerAuth: boolean;
  allowLegacyObjectKeys: boolean;
  rateLimitRedisUrl: string;
  rateLimitKeySecret: string;
  trustFlyClientIp: boolean;
};

type R2LifecyclePreflightConfig = {
  r2Bucket: string;
  r2Endpoint: string;
  r2ObjectAccessKeyId: string;
  r2LifecycleAccessKeyId: string;
  r2LifecycleSecretAccessKey: string;
  storageOperationTimeoutMs: number;
};

type StorageProxyStartupConfig = Readonly<{
  appConfig: StorageProxyAppConfig;
  lifecycleConfig: R2LifecyclePreflightConfig;
}>;

const DEFAULT_MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const DEFAULT_STORAGE_OPERATION_TIMEOUT_MS = 60_000;
const MAX_STORAGE_OPERATION_TIMEOUT_MS = 5 * 60_000;
const STORAGE_RATE_LIMIT_WINDOW_MS = 60_000;
const STORAGE_AUTH_RATE_LIMIT_MAX_REQUESTS = 600;
const STORAGE_UPLOAD_RATE_LIMIT_MAX_REQUESTS = 60;
const STORAGE_READ_RATE_LIMIT_MAX_REQUESTS = 600;
const STORAGE_DELETE_RATE_LIMIT_MAX_REQUESTS = 600;
const STORAGE_RATE_LIMIT_REDIS_TIMEOUT_MS = 2_000;
const STORAGE_RATE_LIMIT_EDGE_PREFIX = "leaderbot:storage-proxy:edge:v1:";
const STORAGE_RATE_LIMIT_SCOPE_PREFIX = "leaderbot:storage-proxy:scope:v1:";
const REQUIRED_LIFECYCLE_RULES = [
  {
    id: "expire-inbound-source-after-30-days",
    prefix: "inbound-source/",
    expirationDays: 30,
  },
  {
    id: "expire-generated-images-after-30-days",
    prefix: "generated/images/",
    expirationDays: 30,
  },
  {
    id: "expire-generated-videos-after-30-days",
    prefix: "generated/videos/",
    expirationDays: 30,
  },
] as const;
const STORAGE_SIGNATURE_MAX_FUTURE_SECONDS = 120;
const STORAGE_SIGNATURE_CLOCK_SKEW_SECONDS = 5;
const LEGACY_STORAGE_SCOPE = "legacy-v1";
const LEGACY_OBJECT_KEY_PATTERN =
  /^(?:inbound-source|generated\/images|generated\/videos)\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/u;
const SCOPED_OBJECT_KEY_PATTERN =
  /^(inbound-source|generated\/images|generated\/videos)\/v1\/workspace-([1-9]\d*)\/connection-([1-9]\d*)\/binding-([1-9]\d*)\/privacy-([1-9]\d*)\/user-([a-f0-9]{64})\/([^/]+)$/u;
const IMAGE_FILE_PATTERN =
  /^[1-9]\d{9,15}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp)$/u;
const VIDEO_FILE_PATTERN =
  /^[1-9]\d{9,15}-[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.mp4$/u;

class PayloadTooLargeError extends Error {
  constructor(readonly maxBytes: number) {
    super("payload_too_large");
    this.name = "PayloadTooLargeError";
  }
}

export class StorageOperationTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`storage_operation_timed_out_after_${timeoutMs}ms`);
    this.name = "StorageOperationTimeoutError";
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
      (value.startsWith('"') && value.endsWith('"')) ||
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
  "R2_LIFECYCLE_ACCESS_KEY_ID",
  "R2_LIFECYCLE_SECRET_ACCESS_KEY",
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

function readBoundedPositiveIntegerEnv(
  name: string,
  fallback: number,
  maximum: number
): number {
  const value = readPositiveIntegerEnv(name, fallback);
  if (value > maximum) {
    throw new Error(`${name} must be at most ${maximum}`);
  }
  return value;
}

function readBooleanEnv(name: string): boolean {
  const value = readEnv(name).trim();
  if (!value) return false;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false`);
}

function readRateLimitKeySecret(): string {
  const secret = getEnv("STORAGE_RATE_LIMIT_KEY_SECRET");
  if (Buffer.byteLength(secret, "utf8") < 32) {
    throw new Error("STORAGE_RATE_LIMIT_KEY_SECRET must be at least 32 bytes");
  }
  return secret;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function buildR2Endpoint(accountId: string): string {
  return `https://${accountId}.r2.cloudflarestorage.com`;
}

function loadConfig(): StorageProxyStartupConfig {
  logEnvPresence();

  const configuredEndpoint = readEnv("R2_ENDPOINT").trim();

  const publicBaseUrl = getEnv("PUBLIC_BASE_URL");
  const parsedPublicBaseUrl = new URL(publicBaseUrl);
  if (
    (process.env.NODE_ENV === "production" &&
      parsedPublicBaseUrl.protocol !== "https:") ||
    (parsedPublicBaseUrl.protocol !== "https:" &&
      parsedPublicBaseUrl.protocol !== "http:") ||
    parsedPublicBaseUrl.username ||
    parsedPublicBaseUrl.password ||
    parsedPublicBaseUrl.search ||
    parsedPublicBaseUrl.hash
  ) {
    throw new Error("PUBLIC_BASE_URL must be a trusted HTTPS origin/base path");
  }

  const r2Bucket = getEnv("R2_BUCKET");
  const r2Endpoint =
    configuredEndpoint || buildR2Endpoint(getEnv("R2_ACCOUNT_ID"));
  const r2AccessKeyId = getEnv("R2_ACCESS_KEY_ID");
  const storageOperationTimeoutMs = readBoundedPositiveIntegerEnv(
    "STORAGE_OPERATION_TIMEOUT_MS",
    DEFAULT_STORAGE_OPERATION_TIMEOUT_MS,
    MAX_STORAGE_OPERATION_TIMEOUT_MS
  );
  const appConfig: StorageProxyAppConfig = {
    forgeApiKey: getEnv("FORGE_API_KEY"),
    publicBaseUrl: publicBaseUrl.replace(/\/+$/, ""),
    r2Bucket,
    r2Endpoint,
    r2AccessKeyId,
    r2SecretAccessKey: getEnv("R2_SECRET_ACCESS_KEY"),
    port: Number.parseInt(process.env.PORT ?? "8787", 10) || 8787,
    maxUploadBytes: readPositiveIntegerEnv(
      "MAX_UPLOAD_BYTES",
      DEFAULT_MAX_UPLOAD_BYTES
    ),
    storageOperationTimeoutMs,
    allowLegacyBearerAuth: readBooleanEnv("STORAGE_ALLOW_LEGACY_BEARER_AUTH"),
    allowLegacyObjectKeys: readBooleanEnv("STORAGE_ALLOW_LEGACY_KEYS"),
    rateLimitRedisUrl: getEnv("STORAGE_RATE_LIMIT_REDIS_URL"),
    rateLimitKeySecret: readRateLimitKeySecret(),
    trustFlyClientIp: readBooleanEnv("STORAGE_TRUST_FLY_CLIENT_IP"),
  };
  const lifecycleConfig: R2LifecyclePreflightConfig = {
    r2Bucket,
    r2Endpoint,
    r2ObjectAccessKeyId: r2AccessKeyId,
    r2LifecycleAccessKeyId: getEnv("R2_LIFECYCLE_ACCESS_KEY_ID"),
    r2LifecycleSecretAccessKey: getEnv("R2_LIFECYCLE_SECRET_ACCESS_KEY"),
    storageOperationTimeoutMs,
  };
  assertR2LifecycleCredentialIsolation(lifecycleConfig);
  return { appConfig, lifecycleConfig };
}

export function assertR2LifecycleCredentialIsolation(
  config: Pick<
    R2LifecyclePreflightConfig,
    | "r2ObjectAccessKeyId"
    | "r2LifecycleAccessKeyId"
    | "r2LifecycleSecretAccessKey"
  >
): void {
  if (!config.r2ObjectAccessKeyId.trim()) {
    throw new Error("R2 object access key ID is missing");
  }
  if (!config.r2LifecycleAccessKeyId.trim()) {
    throw new Error("R2 lifecycle access key ID is missing");
  }
  if (!config.r2LifecycleSecretAccessKey.trim()) {
    throw new Error("R2 lifecycle secret access key is missing");
  }
  if (
    config.r2LifecycleAccessKeyId.trim() ===
    config.r2ObjectAccessKeyId.trim()
  ) {
    throw new Error(
      "R2 lifecycle inspection requires a separate read-only credential ID"
    );
  }
}

function createObjectS3Client(
  config: Pick<
    StorageProxyAppConfig,
    "r2Endpoint" | "r2AccessKeyId" | "r2SecretAccessKey"
  >
): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: config.r2Endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.r2AccessKeyId,
      secretAccessKey: config.r2SecretAccessKey,
    },
    // One bounded attempt keeps the worst-case operation window far below the
    // Messenger privacy-fence cooldown. Application-level retries use a new,
    // independently inventoried operation instead of hidden SDK retries.
    maxAttempts: 1,
  });
}

function createLifecycleS3Client(
  config: R2LifecyclePreflightConfig
): S3Client {
  assertR2LifecycleCredentialIsolation(config);
  return new S3Client({
    region: "auto",
    endpoint: config.r2Endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: config.r2LifecycleAccessKeyId,
      secretAccessKey: config.r2LifecycleSecretAccessKey,
    },
    maxAttempts: 1,
  });
}

export async function runStorageOperationWithDeadline<T>(
  operation: (abortSignal: AbortSignal) => Promise<T>,
  timeoutMs: number
): Promise<T> {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_STORAGE_OPERATION_TIMEOUT_MS
  ) {
    throw new Error("Storage operation timeout is outside the safe range");
  }
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new StorageOperationTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type R2LifecycleRule = {
  ID?: string;
  Status?: string;
  Prefix?: string;
  Filter?: { Prefix?: string };
  Expiration?: { Days?: number };
};

export function assertRequiredR2LifecycleRules(
  rules: readonly R2LifecycleRule[]
): void {
  for (const required of REQUIRED_LIFECYCLE_RULES) {
    const matchingRule = rules.find(rule => rule.ID === required.id);
    const prefix = matchingRule?.Filter?.Prefix ?? matchingRule?.Prefix;
    if (
      matchingRule?.Status !== "Enabled" ||
      prefix !== required.prefix ||
      matchingRule.Expiration?.Days !== required.expirationDays
    ) {
      throw new Error(
        `Required R2 lifecycle rule is missing or unsafe: ${required.id}`
      );
    }
  }
}

export async function verifyRequiredR2LifecycleConfig(
  config: R2LifecyclePreflightConfig
): Promise<void> {
  const s3 = createLifecycleS3Client(config);
  try {
    const lifecycle = await runStorageOperationWithDeadline(
      abortSignal =>
        s3.send(
          new GetBucketLifecycleConfigurationCommand({
            Bucket: config.r2Bucket,
          }),
          { abortSignal }
        ),
      config.storageOperationTimeoutMs
    );
    assertRequiredR2LifecycleRules(lifecycle.Rules ?? []);
  } finally {
    s3.destroy();
  }
}

function buildPublicUrl(
  config: StorageProxyAppConfig,
  objectKey: string
): string {
  return new URL(
    objectKey,
    ensureTrailingSlash(config.publicBaseUrl)
  ).toString();
}

type ParsedStorageObjectKey = Readonly<{
  objectKey: string;
  authorizationScope: string;
  rateLimitScope: string;
  legacy: boolean;
}>;

function isSafePositiveInteger(value: string): boolean {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0;
}

export function parseStorageObjectKey(
  objectKey: string,
  allowLegacyObjectKeys = false
): ParsedStorageObjectKey | null {
  if (
    !objectKey ||
    objectKey.trim() !== objectKey ||
    objectKey.startsWith("/") ||
    objectKey.includes("\\") ||
    objectKey.includes("\0") ||
    objectKey.includes("%") ||
    objectKey.length > 512
  ) {
    return null;
  }
  const match = SCOPED_OBJECT_KEY_PATTERN.exec(objectKey);
  if (match) {
    if (
      !isSafePositiveInteger(match[2]) ||
      !isSafePositiveInteger(match[3]) ||
      !isSafePositiveInteger(match[4]) ||
      !isSafePositiveInteger(match[5])
    ) {
      return null;
    }
    const isVideo = match[1] === "generated/videos";
    if (
      !(isVideo
        ? VIDEO_FILE_PATTERN.test(match[7])
        : IMAGE_FILE_PATTERN.test(match[7]))
    ) {
      return null;
    }
    return {
      objectKey,
      authorizationScope: [
        "v1",
        `workspace-${match[2]}`,
        `connection-${match[3]}`,
        `binding-${match[4]}`,
        `privacy-${match[5]}`,
        `user-${match[6]}`,
      ].join("/"),
      rateLimitScope: `workspace-${match[2]}/connection-${match[3]}`,
      legacy: false,
    };
  }
  if (allowLegacyObjectKeys && LEGACY_OBJECT_KEY_PATTERN.test(objectKey)) {
    return {
      objectKey,
      authorizationScope: LEGACY_STORAGE_SCOPE,
      rateLimitScope: LEGACY_STORAGE_SCOPE,
      legacy: true,
    };
  }
  return null;
}

export function buildStorageRequestSignature(input: {
  apiKey: string;
  method: string;
  objectKey: string;
  scope: string;
  expiresAt: number;
}): string {
  return createHmac("sha256", input.apiKey)
    .update(
      [
        "leaderbot-storage-v1",
        input.method.toUpperCase(),
        input.objectKey,
        input.scope,
        String(input.expiresAt),
      ].join("\n")
    )
    .digest("hex");
}

function constantTimeTextEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export function verifyStorageRequestAuthorization(input: {
  apiKey: string;
  method: string;
  parsedKey: ParsedStorageObjectKey;
  scopeHeader?: string;
  expiresHeader?: string;
  signatureHeader?: string;
  nowSeconds?: number;
}): boolean {
  const scope = input.scopeHeader?.trim() ?? "";
  const expiresRaw = input.expiresHeader?.trim() ?? "";
  const signatureMatch = /^v1=([a-f0-9]{64})$/u.exec(
    input.signatureHeader?.trim() ?? ""
  );
  if (
    !constantTimeTextEqual(scope, input.parsedKey.authorizationScope) ||
    !/^[1-9]\d{9,11}$/u.test(expiresRaw) ||
    !signatureMatch
  ) {
    return false;
  }
  const expiresAt = Number(expiresRaw);
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < nowSeconds - STORAGE_SIGNATURE_CLOCK_SKEW_SECONDS ||
    expiresAt > nowSeconds + STORAGE_SIGNATURE_MAX_FUTURE_SECONDS
  ) {
    return false;
  }
  const expected = buildStorageRequestSignature({
    apiKey: input.apiKey,
    method: input.method,
    objectKey: input.parsedKey.objectKey,
    scope,
    expiresAt,
  });
  return constantTimeTextEqual(expected, signatureMatch[1]);
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

function logJson(
  level: "info" | "warn" | "error",
  payload: Record<string, unknown>
): void {
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

function opaqueRateLimitKey(
  secret: string,
  namespace: string,
  value: string
): string {
  return createHmac("sha256", secret)
    .update(`leaderbot-storage-rate-limit-v1\n${namespace}\n${value}`)
    .digest("hex");
}

function getRateLimitClientAddress(
  req: express.Request,
  config: StorageProxyAppConfig
): string {
  if (config.trustFlyClientIp) {
    const flyClientIp = req.header("fly-client-ip")?.trim() ?? "";
    return isIP(flyClientIp)
      ? ipKeyGenerator(flyClientIp)
      : "invalid-fly-client-ip";
  }
  const directAddress = req.socket.remoteAddress ?? "";
  return isIP(directAddress)
    ? ipKeyGenerator(directAddress)
    : "invalid-direct-client-ip";
}

function getAuthorizedStorageRequest(
  res: express.Response
): ParsedStorageObjectKey {
  const parsedKey: unknown = res.locals.storageAuthorization;
  if (
    typeof parsedKey !== "object" ||
    parsedKey === null ||
    !("objectKey" in parsedKey) ||
    typeof parsedKey.objectKey !== "string" ||
    !("rateLimitScope" in parsedKey) ||
    typeof parsedKey.rateLimitScope !== "string"
  ) {
    throw new Error("storage request reached handler without authorization");
  }
  return parsedKey as ParsedStorageObjectKey;
}

export type StorageRateLimitBackend = Readonly<{
  edgeStore: Store;
  scopeStore: Store;
  assertReady: () => Promise<void>;
  close: () => Promise<void>;
}>;

function toRedisReply(value: unknown): RedisReply {
  if (
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string" ||
    (Array.isArray(value) &&
      value.every(
        item =>
          typeof item === "boolean" ||
          typeof item === "number" ||
          typeof item === "string"
      ))
  ) {
    return value;
  }
  throw new Error("storage rate limiter returned an invalid Redis reply");
}

async function withRateLimitRedisDeadline<T>(
  operation: Promise<T>
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("storage rate limiter Redis operation timed out")),
      STORAGE_RATE_LIMIT_REDIS_TIMEOUT_MS
    );
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function createSharedStorageRateLimitBackend(
  redisUrl: string
): Promise<StorageRateLimitBackend> {
  const parsedRedisUrl = new URL(redisUrl);
  if (
    (parsedRedisUrl.protocol !== "redis:" &&
      parsedRedisUrl.protocol !== "rediss:") ||
    parsedRedisUrl.hash
  ) {
    throw new Error("STORAGE_RATE_LIMIT_REDIS_URL must be a Redis URL");
  }

  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    enableOfflineQueue: false,
    connectTimeout: STORAGE_RATE_LIMIT_REDIS_TIMEOUT_MS,
    commandTimeout: STORAGE_RATE_LIMIT_REDIS_TIMEOUT_MS,
    maxRetriesPerRequest: 0,
    retryStrategy: (retries: number) => Math.min(retries * 100, 1_000),
  });
  redis.on("error", () => {
    // The request and readiness paths report metadata-only failure responses.
  });
  try {
    await withRateLimitRedisDeadline(redis.connect());
  } catch (error) {
    redis.disconnect(false);
    throw error;
  }

  const callRedis = redis.call.bind(redis) as (
    ...args: string[]
  ) => Promise<unknown>;
  const sendCommand = async (...args: string[]): Promise<RedisReply> =>
    toRedisReply(await withRateLimitRedisDeadline(callRedis(...args)));
  const edgeStore = new RedisStore({
    prefix: STORAGE_RATE_LIMIT_EDGE_PREFIX,
    sendCommand,
  });
  const scopeStore = new RedisStore({
    prefix: STORAGE_RATE_LIMIT_SCOPE_PREFIX,
    sendCommand,
  });
  let closed = false;

  return {
    edgeStore,
    scopeStore,
    async assertReady(): Promise<void> {
      for (const [name, store] of [
        ["edge", edgeStore],
        ["scope", scopeStore],
      ] as const) {
        const probeKey = `readiness-contract-${name}`;
        const result = await withRateLimitRedisDeadline(
          store.increment(probeKey)
        );
        try {
          if (
            !Number.isSafeInteger(result.totalHits) ||
            result.totalHits < 1 ||
            !(result.resetTime instanceof Date)
          ) {
            throw new Error("storage rate limiter readiness contract failed");
          }
        } finally {
          await withRateLimitRedisDeadline(store.resetKey(probeKey));
        }
      }
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      try {
        await withRateLimitRedisDeadline(redis.quit());
      } finally {
        redis.disconnect(false);
      }
    },
  };
}

function storageRateLimitHandler(
  req: express.Request,
  res: express.Response
): void {
  logJson("warn", {
    msg: "storage_proxy_rate_limited",
    method: req.method,
    path: req.path,
  });
  res.status(429).json({ error: "Too many storage requests" });
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

function readObjectKeyQuery(req: express.Request): string | null {
  const value = req.query.path;
  return typeof value === "string" ? value : null;
}

function authorizeObjectRequest(
  req: express.Request,
  res: express.Response,
  config: StorageProxyAppConfig
): ParsedStorageObjectKey | null {
  const rawObjectKey = readObjectKeyQuery(req);
  const parsedKey = rawObjectKey
    ? parseStorageObjectKey(rawObjectKey, config.allowLegacyObjectKeys)
    : null;
  if (!parsedKey) {
    res.status(400).json({ error: "Invalid storage object path" });
    return null;
  }
  if (res.locals.legacyStorageBearerAuthorized === true) {
    return parsedKey;
  }
  const authorized = verifyStorageRequestAuthorization({
    apiKey: config.forgeApiKey,
    method: req.method,
    parsedKey,
    scopeHeader: req.header("x-leaderbot-storage-scope"),
    expiresHeader: req.header("x-leaderbot-storage-expires"),
    signatureHeader: req.header("x-leaderbot-storage-signature"),
  });
  if (!authorized) {
    logJson("warn", {
      msg: "storage_proxy_signature_failed",
      method: req.method,
      ...objectKeyLogFields(parsedKey.objectKey),
    });
    res.status(403).json({ error: "Invalid storage request signature" });
    return null;
  }
  return parsedKey;
}

function createStorageAuthorizationMiddleware(
  config: StorageProxyAppConfig
): express.RequestHandler {
  return (req, res, next) => {
    const parsedKey = authorizeObjectRequest(req, res, config);
    if (!parsedKey) return;
    res.locals.storageAuthorization = parsedKey;
    next();
  };
}

export function createStorageProxyApp(
  config: StorageProxyAppConfig,
  rateLimitOverrides: Readonly<{
    windowMs?: number;
    authMaxRequests?: number;
    operationMaxRequests?: number;
    backend?: StorageRateLimitBackend;
  }> = {}
): express.Express {
  const windowMs = rateLimitOverrides.windowMs ?? STORAGE_RATE_LIMIT_WINDOW_MS;
  const backend = rateLimitOverrides.backend;
  if (process.env.NODE_ENV === "production" && !backend) {
    throw new Error(
      "production storage proxy requires shared Redis rate limiting"
    );
  }
  const app = express();
  app.use(helmet());
  const s3 = createObjectS3Client(config);

  const authRateLimiter = rateLimit({
    windowMs,
    limit:
      rateLimitOverrides.authMaxRequests ??
      STORAGE_AUTH_RATE_LIMIT_MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: req =>
      opaqueRateLimitKey(
        config.rateLimitKeySecret,
        "edge",
        getRateLimitClientAddress(req, config)
      ),
    ...(backend ? { store: backend.edgeStore } : {}),
    passOnStoreError: false,
    handler: storageRateLimitHandler,
  });
  const storageOperationRateLimiter = rateLimit({
    windowMs,
    limit: req => {
      if (rateLimitOverrides.operationMaxRequests !== undefined) {
        return rateLimitOverrides.operationMaxRequests;
      }
      if (req.method === "POST") return STORAGE_UPLOAD_RATE_LIMIT_MAX_REQUESTS;
      if (req.method === "DELETE")
        return STORAGE_DELETE_RATE_LIMIT_MAX_REQUESTS;
      return STORAGE_READ_RATE_LIMIT_MAX_REQUESTS;
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (_req, res) => {
      const parsedKey = getAuthorizedStorageRequest(res);
      return opaqueRateLimitKey(
        config.rateLimitKeySecret,
        "scope",
        `${_req.method}\n${parsedKey.rateLimitScope}`
      );
    },
    ...(backend ? { store: backend.scopeStore } : {}),
    passOnStoreError: false,
    handler: storageRateLimitHandler,
  });

  app.get("/healthz", (_req, res) => {
    res.status(200).send("ok");
  });

  app.get("/readyz", (_req, res) => {
    if (!backend) {
      res.status(process.env.NODE_ENV === "production" ? 503 : 200).json({
        ok: process.env.NODE_ENV !== "production",
        rateLimiter: "in_memory_test_only",
      });
      return;
    }
    void backend
      .assertReady()
      .then(() =>
        res.status(200).json({ ok: true, rateLimiter: "shared_redis" })
      )
      .catch(() =>
        res.status(503).json({ ok: false, rateLimiter: "unavailable" })
      );
  });

  app.use("/v1/storage", authRateLimiter);

  app.use("/v1/storage", (req, res, next) => {
    const token = getBearerToken(req.header("authorization"));
    if (!token || !constantTimeTextEqual(token, config.forgeApiKey)) {
      logJson("warn", {
        msg: "storage_proxy_auth_failed",
        method: req.method,
        path: req.path,
      });
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const hasSignatureHeaders = [
      "x-leaderbot-storage-scope",
      "x-leaderbot-storage-expires",
      "x-leaderbot-storage-signature",
    ].some(header => Boolean(req.header(header)));
    if (!hasSignatureHeaders) {
      if (!config.allowLegacyBearerAuth) {
        res.status(401).json({ error: "Signed storage request required" });
        return;
      }
      res.locals.legacyStorageBearerAuthorized = true;
    }
    next();
  });

  app.use("/v1/storage", createStorageAuthorizationMiddleware(config));
  app.use("/v1/storage", storageOperationRateLimiter);

  app.post("/v1/storage/upload", async (req, res) => {
    const { objectKey } = getAuthorizedStorageRequest(res);

    try {
      const file = await readMultipartFile(req, config.maxUploadBytes);
      await runStorageOperationWithDeadline(
        abortSignal =>
          s3.send(
            new PutObjectCommand({
              Bucket: config.r2Bucket,
              Key: objectKey,
              Body: file.buffer,
              ContentType: file.contentType,
            }),
            { abortSignal }
          ),
        config.storageOperationTimeoutMs
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
    const { objectKey } = getAuthorizedStorageRequest(res);

    try {
      await runStorageOperationWithDeadline(
        abortSignal =>
          s3.send(
            new HeadObjectCommand({
              Bucket: config.r2Bucket,
              Key: objectKey,
            }),
            { abortSignal }
          ),
        config.storageOperationTimeoutMs
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
    const { objectKey } = getAuthorizedStorageRequest(res);

    try {
      await runStorageOperationWithDeadline(
        abortSignal =>
          s3.send(
            new DeleteObjectCommand({
              Bucket: config.r2Bucket,
              Key: objectKey,
            }),
            { abortSignal }
          ),
        config.storageOperationTimeoutMs
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

  app.use(
    (
      error: unknown,
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => {
      void next;
      logJson("error", {
        msg: "storage_proxy_request_failed_closed",
        method: req.method,
        path: req.path,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      res
        .status(503)
        .json({ error: "Storage service temporarily unavailable" });
    }
  );

  return app;
}

export async function startStorageProxy(): Promise<void> {
  const { appConfig, lifecycleConfig } = loadConfig();
  const rateLimitBackend = await createSharedStorageRateLimitBackend(
    appConfig.rateLimitRedisUrl
  );
  try {
    // express-rate-limit initializes each RedisStore while constructing the
    // middleware. Readiness must run after that initialization, otherwise
    // rate-limit-redis has no windowMs and throws before issuing a Redis call.
    const app = createStorageProxyApp(appConfig, {
      backend: rateLimitBackend,
    });
    await rateLimitBackend.assertReady();
    await verifyRequiredR2LifecycleConfig(lifecycleConfig);
    if (appConfig.allowLegacyBearerAuth || appConfig.allowLegacyObjectKeys) {
      logJson("warn", {
        msg: "storage_proxy_legacy_bridge_enabled",
        allowLegacyBearerAuth: appConfig.allowLegacyBearerAuth,
        allowLegacyObjectKeys: appConfig.allowLegacyObjectKeys,
      });
    }
    const host = "0.0.0.0";

    app.listen(appConfig.port, host, () => {
      logJson("info", {
        msg: "storage_proxy_started",
        host,
        port: appConfig.port,
        bind: `${host}:${appConfig.port}`,
        publicBaseUrl: appConfig.publicBaseUrl,
        r2Bucket: appConfig.r2Bucket,
        r2Endpoint: appConfig.r2Endpoint,
        storageOperationTimeoutMs: appConfig.storageOperationTimeoutMs,
        rateLimiter: "shared_redis",
        allowLegacyBearerAuth: appConfig.allowLegacyBearerAuth,
        allowLegacyObjectKeys: appConfig.allowLegacyObjectKeys,
      });
    });
  } catch (error) {
    await rateLimitBackend.close().catch(() => undefined);
    throw error;
  }
}

const entryScript = process.argv[1]?.replace(/\\/g, "/") ?? "";
if (/\/index\.(?:ts|js|cjs)$/u.test(entryScript)) {
  startStorageProxy().catch(error => {
    logJson("error", {
      msg: "storage_proxy_startup_refused",
      ...storageErrorLogFields(error),
    });
    process.exitCode = 1;
  });
}
