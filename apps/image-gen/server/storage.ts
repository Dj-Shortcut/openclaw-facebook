// Preconfigured storage helpers for Manus WebDev templates
// Uses the Biz-provided storage proxy (Authorization: Bearer <token>)

import { getForgeApiBaseUrlOrThrow } from "./_core/env";

type StorageConfig = { baseUrl: string; apiKey: string };

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
    const message = await response.text().catch(() => response.statusText);
    throw new Error(
      `Storage upload failed (${response.status} ${response.statusText}): ${message}`
    );
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
    const message = await response.text().catch(() => response.statusText);
    throw new Error(
      `Storage delete failed (${response.status} ${response.statusText}): ${message}`
    );
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
