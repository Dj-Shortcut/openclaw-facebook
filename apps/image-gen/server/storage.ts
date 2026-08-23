// Preconfigured storage helpers for Manus WebDev templates
// Uses the Biz-provided storage proxy (Authorization: Bearer <token>)

import { getForgeApiBaseUrlOrThrow } from "./_core/env";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  formatMessengerStorageScope,
  isLegacyMessengerStorageObjectKey,
  isMessengerStorageLegacyBridgeEnabled,
  parseMessengerStorageObjectKey,
} from "./_core/messengerStorageObject";

type StorageConfig = { baseUrl: string; apiKey: string };

const DEFAULT_MAX_STORAGE_ERROR_BODY_CHARS = 2048;
const DEFAULT_STORAGE_REQUEST_TIMEOUT_MS = 30_000;
const MAX_STORAGE_REQUEST_TIMEOUT_MS = 120_000;
const STORAGE_SIGNATURE_TTL_SECONDS = 60;
const LEGACY_STORAGE_SCOPE = "legacy-v1";

class StorageRequestTimeoutError extends Error {
  constructor(operation: string, timeoutMs: number) {
    super(`Storage ${operation} timed out after ${timeoutMs}ms`);
    this.name = "StorageRequestTimeoutError";
  }
}

function getStorageRequestTimeoutMs(): number {
  const configured = Number(process.env.STORAGE_REQUEST_TIMEOUT_MS);
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_STORAGE_REQUEST_TIMEOUT_MS;
  }
  return Math.min(Math.floor(configured), MAX_STORAGE_REQUEST_TIMEOUT_MS);
}

async function runStorageRequest<T>(
  operation: string,
  request: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const timeoutMs = getStorageRequestTimeoutMs();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new StorageRequestTimeoutError(operation, timeoutMs);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([request(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getMaxStorageErrorBodyChars(): number {
  const parsed = Number(process.env.STORAGE_ERROR_BODY_MAX_CHARS);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MAX_STORAGE_ERROR_BODY_CHARS;
  }

  return Math.min(Math.floor(parsed), 16_384);
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const maxChars = getMaxStorageErrorBodyChars();
  if (!response.body) {
    return response
      .text()
      .then(text =>
        text.length > maxChars
          ? `${text.slice(0, maxChars)}...<truncated>`
          : text
      );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let truncated = false;

  try {
    while (text.length < maxChars) {
      const { done, value } = await reader.read();
      if (done) {
        text += decoder.decode();
        break;
      }

      text += decoder.decode(value, { stream: true });
      if (text.length > maxChars) {
        text = text.slice(0, maxChars);
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    if (!truncated && text.length === maxChars) {
      const probe = await reader.read();
      if (!probe.done) {
        truncated = true;
        await reader.cancel().catch(() => undefined);
      } else {
        text += decoder.decode();
      }
    }
  } finally {
    reader.releaseLock();
  }

  return truncated ? `${text}...<truncated>` : text;
}

async function buildStorageErrorMessage(
  operation: string,
  response: Response
): Promise<string> {
  const message = await readBoundedResponseText(response).catch(
    () => response.statusText
  );
  return `Storage ${operation} failed (${response.status} ${response.statusText}): ${message}`;
}

function extractUrl(value: unknown): string {
  if (typeof value === "object" && value !== null && "url" in value) {
    const url = (value as { url?: unknown }).url;
    if (typeof url === "string") {
      return url;
    }
  }

  throw new Error("Storage response missing url");
}

function getStorageConfig(): StorageConfig {
  const baseUrl = process.env.BUILT_IN_FORGE_API_URL?.trim() ?? "";
  const apiKey = process.env.BUILT_IN_FORGE_API_KEY?.trim() ?? "";

  if (!baseUrl || !apiKey) {
    throw new Error(
      "Storage proxy credentials missing: set BUILT_IN_FORGE_API_URL and BUILT_IN_FORGE_API_KEY"
    );
  }

  return { baseUrl: getForgeApiBaseUrlOrThrow().replace(/\/+$/, ""), apiKey };
}

function buildUploadUrl(baseUrl: string, relKey: string): URL {
  const url = new URL("v1/storage/upload", ensureTrailingSlash(baseUrl));
  url.searchParams.set("path", normalizeKey(relKey));
  return url;
}

function buildDeleteUrl(baseUrl: string, relKey: string): URL {
  const url = new URL("v1/storage/object", ensureTrailingSlash(baseUrl));
  url.searchParams.set("path", normalizeKey(relKey));
  return url;
}

async function buildDownloadUrl(
  baseUrl: string,
  relKey: string,
  apiKey: string,
  signal: AbortSignal
): Promise<string> {
  const downloadApiUrl = new URL(
    "v1/storage/downloadUrl",
    ensureTrailingSlash(baseUrl)
  );
  downloadApiUrl.searchParams.set("path", normalizeKey(relKey));
  const response = await fetch(downloadApiUrl, {
    method: "GET",
    headers: buildAuthHeaders(apiKey, "GET", relKey),
    signal,
  });
  if (!response.ok) {
    throw new Error(await buildStorageErrorMessage("downloadUrl", response));
  }
  const payload: unknown = await response.json();
  const url = extractUrl(payload);
  assertStorageResponseUrlMatchesKey(url, relKey);
  return url;
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizeKey(relKey: string): string {
  const key = relKey.trim();
  if (key !== relKey || key.startsWith("/") || key.includes("\\")) {
    throw new Error("Invalid storage object key");
  }
  if (parseMessengerStorageObjectKey(key)) return key;
  if (
    isMessengerStorageLegacyBridgeEnabled() &&
    isLegacyMessengerStorageObjectKey(key)
  ) {
    return key;
  }
  throw new Error("Storage object key is outside an allowed tenant namespace");
}

function toFormData(
  data: Buffer | Uint8Array | string,
  contentType: string,
  fileName: string
): FormData {
  const blob =
    typeof data === "string"
      ? new Blob([data], { type: contentType })
      : new Blob([new Uint8Array(data)], { type: contentType });
  const form = new FormData();
  form.append("file", blob, fileName || "file");
  return form;
}

function resolveStorageAuthorizationScope(objectKey: string): string {
  const parsed = parseMessengerStorageObjectKey(objectKey);
  if (parsed) return formatMessengerStorageScope(parsed.scope);
  if (
    isMessengerStorageLegacyBridgeEnabled() &&
    isLegacyMessengerStorageObjectKey(objectKey)
  ) {
    return LEGACY_STORAGE_SCOPE;
  }
  throw new Error("Storage authorization scope is invalid");
}

export function buildStorageRequestSignature(input: {
  apiKey: string;
  method: "GET" | "POST" | "DELETE";
  objectKey: string;
  scope: string;
  expiresAt: number;
}): string {
  const canonical = [
    "leaderbot-storage-v1",
    input.method,
    input.objectKey,
    input.scope,
    String(input.expiresAt),
  ].join("\n");
  return createHmac("sha256", input.apiKey).update(canonical).digest("hex");
}

function buildAuthHeaders(
  apiKey: string,
  method: "GET" | "POST" | "DELETE",
  objectKey: string,
  now = Date.now()
): HeadersInit {
  const scope = resolveStorageAuthorizationScope(objectKey);
  const expiresAt = Math.floor(now / 1_000) + STORAGE_SIGNATURE_TTL_SECONDS;
  const signature = buildStorageRequestSignature({
    apiKey,
    method,
    objectKey,
    scope,
    expiresAt,
  });
  return {
    Authorization: `Bearer ${apiKey}`,
    "X-Leaderbot-Storage-Scope": scope,
    "X-Leaderbot-Storage-Expires": String(expiresAt),
    "X-Leaderbot-Storage-Signature": `v1=${signature}`,
  };
}

export async function storagePut(
  relKey: string,
  data: Buffer | Uint8Array | string,
  contentType = "application/octet-stream"
): Promise<{ key: string; url: string }> {
  const { baseUrl, apiKey } = getStorageConfig();
  const key = normalizeKey(relKey);
  const uploadUrl = buildUploadUrl(baseUrl, key);
  const formData = toFormData(data, contentType, key.split("/").pop() ?? key);
  return await runStorageRequest("upload", async signal => {
    const response = await fetch(uploadUrl, {
      method: "POST",
      headers: buildAuthHeaders(apiKey, "POST", key),
      body: formData,
      signal,
    });

    if (!response.ok) {
      throw new Error(await buildStorageErrorMessage("upload", response));
    }
    const payload: unknown = await response.json();
    const url = extractUrl(payload);
    assertStorageResponseUrlMatchesKey(url, key);
    return { key, url };
  });
}

export async function storageDelete(relKey: string): Promise<void> {
  const { baseUrl, apiKey } = getStorageConfig();
  const deleteUrl = buildDeleteUrl(baseUrl, relKey);
  await runStorageRequest("delete", async signal => {
    const response = await fetch(deleteUrl, {
      method: "DELETE",
      headers: buildAuthHeaders(apiKey, "DELETE", normalizeKey(relKey)),
      signal,
    });

    if (!response.ok && response.status !== 404) {
      throw new Error(await buildStorageErrorMessage("delete", response));
    }
  });
}

export function storageKeyFromPublicUrl(publicUrl: string): string | null {
  try {
    const parsed = new URL(publicUrl);
    if (parsed.username || parsed.password) return null;
    for (const base of getTrustedStoragePublicBases()) {
      if (parsed.origin !== base.origin) continue;
      const basePath = base.pathname.replace(/\/+$/u, "");
      if (
        basePath &&
        basePath !== "/" &&
        !parsed.pathname.startsWith(`${basePath}/`)
      ) {
        continue;
      }
      const relativePath =
        basePath && basePath !== "/"
          ? parsed.pathname.slice(basePath.length)
          : parsed.pathname;
      const key = decodeURIComponent(relativePath.replace(/^\/+/, ""));
      if (
        !key ||
        key.length > 512 ||
        key.includes("\\") ||
        key.includes("\0") ||
        key.includes("%") ||
        key
          .split("/")
          .some(segment => !segment || segment === "." || segment === "..")
      ) {
        return null;
      }
      return normalizeKey(key);
    }
    return null;
  } catch {
    return null;
  }
}

type TrustedStoragePublicBase = Readonly<{
  origin: string;
  pathname: string;
}>;

function getTrustedStoragePublicBases(): TrustedStoragePublicBase[] {
  const configured = [
    ...(process.env.STORAGE_PUBLIC_BASE_URLS ?? "").split(","),
    process.env.PUBLIC_BASE_URL ?? "",
  ];
  const bases: TrustedStoragePublicBase[] = [];
  for (const candidate of configured) {
    const value = candidate.trim();
    if (!value) continue;
    try {
      const parsed = new URL(value);
      if (
        (process.env.NODE_ENV === "production" &&
          parsed.protocol !== "https:") ||
        (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
        parsed.username ||
        parsed.password ||
        parsed.search ||
        parsed.hash
      ) {
        continue;
      }
      const entry = {
        origin: parsed.origin,
        pathname: parsed.pathname.replace(/\/+$/u, "") || "/",
      };
      if (
        !bases.some(
          base =>
            base.origin === entry.origin && base.pathname === entry.pathname
        )
      ) {
        bases.push(entry);
      }
    } catch {
      // Invalid configured origins never broaden trust.
    }
  }
  return bases.sort(
    (left, right) => right.pathname.length - left.pathname.length
  );
}

function assertStorageResponseUrlMatchesKey(url: string, key: string): void {
  const returnedKey = storageKeyFromPublicUrl(url);
  const expected = Buffer.from(key);
  const returned = Buffer.from(returnedKey ?? "");
  if (
    expected.length !== returned.length ||
    !timingSafeEqual(expected, returned)
  ) {
    throw new Error("Storage response URL is outside the trusted object scope");
  }
}

export async function storageGet(
  relKey: string
): Promise<{ key: string; url: string }> {
  const { baseUrl, apiKey } = getStorageConfig();
  const key = normalizeKey(relKey);
  return await runStorageRequest("downloadUrl", async signal => ({
    key,
    url: await buildDownloadUrl(baseUrl, key, apiKey, signal),
  }));
}
