// Preconfigured storage helpers for Manus WebDev templates
// Uses the Biz-provided storage proxy (Authorization: Bearer <token>)

import { getForgeApiBaseUrlOrThrow } from "./_core/env";

type StorageConfig = { baseUrl: string; apiKey: string };

const DEFAULT_MAX_STORAGE_ERROR_BODY_CHARS = 2048;

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
    return response.text().then(text =>
      text.length > maxChars ? `${text.slice(0, maxChars)}...<truncated>` : text
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
  apiKey: string
): Promise<string> {
  const downloadApiUrl = new URL(
    "v1/storage/downloadUrl",
    ensureTrailingSlash(baseUrl)
  );
  downloadApiUrl.searchParams.set("path", normalizeKey(relKey));
  const response = await fetch(downloadApiUrl, {
    method: "GET",
    headers: buildAuthHeaders(apiKey),
  });
  if (!response.ok) {
    throw new Error(await buildStorageErrorMessage("downloadUrl", response));
  }
  const payload: unknown = await response.json();
  return extractUrl(payload);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizeKey(relKey: string): string {
  return relKey.replace(/^\/+/, "");
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

function buildAuthHeaders(apiKey: string): HeadersInit {
  return { Authorization: `Bearer ${apiKey}` };
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
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: buildAuthHeaders(apiKey),
    body: formData,
  });

  if (!response.ok) {
    throw new Error(await buildStorageErrorMessage("upload", response));
  }
  const payload: unknown = await response.json();
  const url = extractUrl(payload);
  return { key, url };
}

export async function storageDelete(relKey: string): Promise<void> {
  const { baseUrl, apiKey } = getStorageConfig();
  const deleteUrl = buildDeleteUrl(baseUrl, relKey);
  const response = await fetch(deleteUrl, {
    method: "DELETE",
    headers: buildAuthHeaders(apiKey),
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(await buildStorageErrorMessage("delete", response));
  }
}

export function storageKeyFromPublicUrl(publicUrl: string): string | null {
  try {
    const parsed = new URL(publicUrl);
    let pathname = parsed.pathname;
    const configuredPublicBaseUrl = process.env.PUBLIC_BASE_URL?.trim();
    if (configuredPublicBaseUrl) {
      try {
        const basePath = new URL(configuredPublicBaseUrl).pathname.replace(
          /\/+$/,
          ""
        );
        if (basePath && basePath !== "/" && pathname.startsWith(`${basePath}/`)) {
          pathname = pathname.slice(basePath.length);
        }
      } catch {
        // Ignore invalid local config and fall back to the raw public URL path.
      }
    }
    const key = decodeURIComponent(pathname.replace(/^\/+/, ""));
    return key || null;
  } catch {
    return null;
  }
}

export async function storageGet(relKey: string): Promise<{ key: string; url: string; }> {
  const { baseUrl, apiKey } = getStorageConfig();
  const key = normalizeKey(relKey);
  return {
    key,
    url: await buildDownloadUrl(baseUrl, key, apiKey),
  };
}
