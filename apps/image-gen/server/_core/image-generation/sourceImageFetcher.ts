import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { lookup } from "node:dns/promises";
import * as https from "node:https";
import net from "node:net";
import os from "node:os";
import { Readable } from "node:stream";
import fs from "fs/promises";
import path from "path";
import { safeLen, sha256 } from "../imageProof";
import { safeLog } from "../logger";

export class MissingInputImageError extends Error {}
export class InvalidSourceImageUrlError extends Error {}

type SourceImageData = {
  buffer: Buffer;
  contentType: string;
};

export type DownloadedSourceImage = SourceImageData & {
  incomingLen: number;
  incomingSha256: string;
  fbImageFetchMs: number;
};

type SourceImageFetchAttemptResult = {
  response: Response;
  contentType: string;
};

type SourceImageDownloadOptions = {
  trustedSourceImageUrl?: boolean;
  sourceImageProvenance?: "storeInbound";
  skipDebugImageProof?: boolean;
};

type ValidatedSourceImageRequest = {
  url: URL;
};

type SourceImageDnsLookup = (
  hostname: string,
  options: { all: true; verbatim: true }
) => Promise<Array<{ address: string; family: 4 | 6 }>>;

type SourceImageResolveInput = {
  sourceImageUrl?: string;
  trustedSourceImageUrl?: boolean;
  sourceImageProvenance?: "storeInbound";
  sourceImageData?: SourceImageData;
  reqId: string;
};

const MIN_INPUT_IMAGE_BYTES = 5 * 1024;
const MAX_INBOUND_IMAGE_BYTES = 20 * 1024 * 1024;
const FB_IMAGE_FETCH_RETRY_LIMIT = 1;
let dnsLookup: SourceImageDnsLookup = lookup as SourceImageDnsLookup;

function getSourceUrlDiagnostics(sourceImageUrl: string): {
  hostname?: string;
  protocol?: string;
} {
  try {
    const parsed = new URL(sourceImageUrl);
    return {
      hostname: parsed.hostname.toLowerCase(),
      protocol: parsed.protocol,
    };
  } catch {
    return {};
  }
}

function getInboundImageTimeoutMs(): number {
  // TODO: inject source-image fetch config instead of reading process.env directly.
  const raw = Number.parseInt(process.env.FB_IMAGE_FETCH_TIMEOUT_MS ?? "", 10);
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }

  return 10_000;
}

function isRetryableResponseStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return error.name === "AbortError" || error instanceof TypeError;
}

function parseAllowedHostsFromEnv(): string[] {
  // TODO: move host allowlist config behind a typed config dependency.
  return (process.env.SOURCE_IMAGE_ALLOWED_HOSTS ?? "")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(x => Number(x));
  if (
    parts.length !== 4 ||
    parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return true;
  }

  const [a, b] = parts;

  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;

  return false;
}

function isBlockedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  if (normalized === "::" || normalized === "::1") {
    return true;
  }

  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true;
  }

  if (normalized.startsWith("fe8") || normalized.startsWith("fe9")) {
    return true;
  }

  if (normalized.startsWith("fea") || normalized.startsWith("feb")) {
    return true;
  }

  return false;
}

function isBlockedIpAddress(ip: string): boolean {
  const ipType = net.isIP(ip);

  if (ipType === 4) {
    return isPrivateIPv4(ip);
  }

  if (ipType === 6) {
    return isBlockedIPv6(ip);
  }

  return true;
}

function hostnameMatchesAllowedHost(
  hostname: string,
  allowedHost: string
): boolean {
  if (hostname === allowedHost) {
    return true;
  }

  if (allowedHost === "fbsbx.com") {
    return hostname.endsWith(".fbsbx.com");
  }

  if (allowedHost === "scontent.xx.fbcdn.net") {
    return /^scontent-[a-z0-9-]+\.xx\.fbcdn\.net$/u.test(hostname);
  }

  return false;
}

function extractRawPathname(sourceImageUrl: string): string {
  const match = sourceImageUrl.match(/^[a-z][a-z0-9+.-]*:\/\/[^/]+([^?#]*)/i);
  return match?.[1] || "/";
}

function hasBlockedPathTraversalSegment(rawPathname: string): boolean {
  const segments = rawPathname.split("/");

  for (const segment of segments) {
    if (!segment) {
      continue;
    }

    let decodedSegment = segment;
    try {
      decodedSegment = decodeURIComponent(segment);
    } catch {
      // Keep the raw segment if decoding fails; malformed encodings are handled elsewhere.
    }

    if (decodedSegment === "." || decodedSegment === "..") {
      return true;
    }
  }

  return false;
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status <= 399 && status !== 304;
}

function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();

  if (h === "localhost" || h.endsWith(".localhost")) return true;

  if (net.isIP(h)) return isBlockedIpAddress(h);

  return false;
}

function blockSourceImageUrl(
  reqId: string | undefined,
  reason: string,
  details: Record<string, unknown> = {}
): never {
  safeLog("source_image_url_blocked", {
    level: "warn",
    reqId,
    reason,
    ...details,
  });
  throw new InvalidSourceImageUrlError("sourceImageUrl is not allowed");
}

function validateSourceImageUrlOrThrow(
  sourceImageUrl: string,
  reqId?: string,
  options?: SourceImageDownloadOptions
): ValidatedSourceImageRequest {
  let parsedUrl: URL;

  try {
    parsedUrl = new URL(sourceImageUrl);
  } catch {
    return blockSourceImageUrl(reqId, "invalid_url");
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  if (parsedUrl.protocol !== "https:") {
    return blockSourceImageUrl(reqId, "non_https", {
      protocol: parsedUrl.protocol,
    });
  }

  if (parsedUrl.username || parsedUrl.password) {
    return blockSourceImageUrl(reqId, "credentials_in_url");
  }

  if (parsedUrl.port && parsedUrl.port !== "443") {
    return blockSourceImageUrl(reqId, "non_standard_port", {
      port: parsedUrl.port,
    });
  }

  const rawPathname = extractRawPathname(sourceImageUrl);
  if (hasBlockedPathTraversalSegment(rawPathname)) {
    return blockSourceImageUrl(reqId, "path_traversal_segment", {
      pathname: rawPathname,
    });
  }

  if (isBlockedHostname(hostname)) {
    return blockSourceImageUrl(reqId, "blocked_hostname", {
      hostname,
    });
  }

  const allowedHosts = parseAllowedHostsFromEnv();
  if (allowedHosts.length === 0) {
    return blockSourceImageUrl(reqId, "allowlist_not_configured");
  }

  const matchedAllowedHost = allowedHosts.find(allowedHost =>
    hostnameMatchesAllowedHost(hostname, allowedHost)
  );
  if (!matchedAllowedHost) {
    return blockSourceImageUrl(reqId, "host_not_allowed", {
      hostname,
    });
  }

  return { url: parsedUrl };
}

async function fetchSourceImageAttempt(
  sourceImageUrl: URL,
  resolvedIpAddresses: string[],
  timeoutMs: number,
  reqId: string
): Promise<SourceImageFetchAttemptResult> {
  const resolvedIpAddress = resolvedIpAddresses[0];
  if (!resolvedIpAddress) {
    return blockSourceImageUrl(reqId, "dns_lookup_empty", {
      hostname: sourceImageUrl.hostname,
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  const contentPath = `${sourceImageUrl.pathname}${sourceImageUrl.search}`;
  try {
    const response = await new Promise<IncomingMessage>((resolve, reject) => {
      const request = https.request(
        {
          protocol: "https:",
          method: "GET",
          hostname: resolvedIpAddress,
          port: sourceImageUrl.port || "443",
          path: contentPath || "/",
          headers: {
            host: sourceImageUrl.host,
          },
          servername: sourceImageUrl.hostname,
          signal: controller.signal,
        },
        responseMessage => {
          resolve(responseMessage);
        }
      );

      request.on("error", error => {
        reject(error);
      });

      request.end();
    });
    const responseHeaders = new Headers();
    for (const [key, rawValue] of Object.entries(response.headers)) {
      if (Array.isArray(rawValue)) {
        for (const headerValue of rawValue) {
          responseHeaders.append(key, headerValue);
        }
      } else if (typeof rawValue === "string") {
        responseHeaders.append(key, rawValue);
      }
    }

    return {
      response: new Response(Readable.toWeb(response) as unknown as BodyInit, {
        status: response.statusCode ?? 502,
        statusText: response.statusMessage ?? "",
        headers: responseHeaders,
      }),
      contentType: responseHeaders.get("content-type") ?? "application/octet-stream",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function assertHostnameResolvesToPublicIpOrThrow(
  sourceImageUrl: URL,
  reqId: string
): Promise<string[]> {
  const hostname = sourceImageUrl.hostname.toLowerCase();

  if (net.isIP(hostname)) {
    return [hostname];
  }

  let addresses: Array<{ address: string; family: 4 | 6 }>;
  try {
    addresses = await dnsLookup(hostname, { all: true, verbatim: true });
  } catch {
    return blockSourceImageUrl(reqId, "dns_lookup_failed", {
      hostname,
    });
  }

  if (!Array.isArray(addresses) || addresses.length === 0) {
    return blockSourceImageUrl(reqId, "dns_lookup_empty", {
      hostname,
    });
  }

  const blockedAddress = addresses.find(result =>
    isBlockedIpAddress(result.address)
  );
  if (blockedAddress) {
    return blockSourceImageUrl(reqId, "dns_resolved_private_ip", {
      hostname,
      address: blockedAddress.address,
      family: blockedAddress.family,
    });
  }

  return addresses.map(address => address.address);
}

export function setSourceImageDnsLookupForTests(
  override: SourceImageDnsLookup | null
): void {
  dnsLookup = override ?? (lookup as SourceImageDnsLookup);
}

function assertNoRedirectResponse(response: Response, reqId: string): void {
  if (!isRedirectStatus(response.status)) {
    return;
  }

  blockSourceImageUrl(reqId, "redirect_not_allowed", {
    status: response.status,
    location: response.headers.get("location") ?? undefined,
  });
}

function shouldRetrySourceImageStatus(
  attempt: number,
  response: Response,
  reqId: string
): boolean {
  if (
    attempt < FB_IMAGE_FETCH_RETRY_LIMIT &&
    isRetryableResponseStatus(response.status)
  ) {
    safeLog("fb_image_fetch_retry", {
      level: "debug",
      reqId,
      attempt: attempt + 1,
      status: response.status,
    });
    return true;
  }

  return false;
}

function throwMissingInputDownloadFailed(reqId: string, status: number): never {
  safeLog("missing_input_image", {
    level: "error",
    reqId,
    reason: "download_failed",
    status,
  });
  throw new MissingInputImageError(
    `Failed to download source image (${status})`
  );
}

async function maybeWriteDebugImageProof(
  reqId: string,
  contentType: string,
  imageBuffer: Buffer
): Promise<void> {
  if (process.env.DEBUG_IMAGE_PROOF !== "1") {
    return;
  }

  if (process.env.NODE_ENV === "production") {
    safeLog("debug_image_proof_ignored_in_production", {
      level: "warn",
      reqId,
    });
    return;
  }

  const ext = contentType.includes("png") ? "png" : "jpg";
  const debugDir = path.join(os.tmpdir(), "leaderbot-debug");
  const safeReqId = reqId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "req";
  const savedPath = path.join(
    debugDir,
    `leaderbot_incoming_${safeReqId}_${Date.now()}_${randomUUID()}.${ext}`
  );
  try {
    await fs.mkdir(debugDir, { recursive: true });
    await fs.writeFile(savedPath, imageBuffer);
    safeLog("debug_image_proof_written", { reqId, saved_path: savedPath });
  } catch (error) {
    safeLog("debug_image_proof_write_failed", {
      level: "warn",
      reqId,
      error,
    });
  }
}

function assertSourceImageSizeOrThrow(
  reqId: string,
  incomingByteLen: number
): void {
  if (incomingByteLen >= MIN_INPUT_IMAGE_BYTES) {
    return;
  }

  safeLog("missing_input_image", {
    level: "error",
    reqId,
    reason: "too_small",
    byte_len: incomingByteLen,
  });
  throw new MissingInputImageError(
    `Source image too small (${incomingByteLen} bytes)`
  );
}

function assertInboundImageWithinLimit(
  reqId: string,
  incomingByteLen: number
): void {
  if (incomingByteLen <= MAX_INBOUND_IMAGE_BYTES) {
    return;
  }

  safeLog("missing_input_image", {
    level: "error",
    reqId,
    reason: "too_large",
    byte_len: incomingByteLen,
    max_byte_len: MAX_INBOUND_IMAGE_BYTES,
  });
  throw new MissingInputImageError(
    `Source image too large (${incomingByteLen} bytes)`
  );
}

async function readResponseBufferWithinLimit(
  reqId: string,
  response: Response
): Promise<Buffer> {
  const contentLengthHeader = response.headers.get("content-length");
  const contentLength = Number.parseInt(contentLengthHeader ?? "", 10);
  if (Number.isFinite(contentLength) && contentLength > 0) {
    try {
      assertInboundImageWithinLimit(reqId, contentLength);
    } catch (error) {
      await response.body?.cancel();
      throw error;
    }
  }

  if (!response.body) {
    const imageBuffer = Buffer.from(await response.arrayBuffer());
    assertInboundImageWithinLimit(reqId, safeLen(imageBuffer));
    return imageBuffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    if (!value) {
      continue;
    }

    totalBytes += value.byteLength;
    try {
      assertInboundImageWithinLimit(reqId, totalBytes);
    } catch (error) {
      await reader.cancel();
      throw error;
    }
    chunks.push(value);
  }

  return Buffer.concat(
    chunks.map(chunk =>
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    )
  );
}

async function buildDownloadedSourceImage(
  reqId: string,
  contentType: string,
  response: Response,
  totalFetchMs: number,
  options?: SourceImageDownloadOptions
): Promise<DownloadedSourceImage> {
  const imageBuffer = await readResponseBufferWithinLimit(reqId, response);
  const incomingByteLen = safeLen(imageBuffer);
  const incomingHash = sha256(imageBuffer);

  if (!options?.skipDebugImageProof) {
    await maybeWriteDebugImageProof(reqId, contentType, imageBuffer);
  }

  assertSourceImageSizeOrThrow(reqId, incomingByteLen);
  safeLog("source_image_downloaded", {
    reqId,
    contentType,
    byteLength: incomingByteLen,
    durationMs: totalFetchMs,
  });

  return {
    buffer: imageBuffer,
    contentType,
    incomingLen: incomingByteLen,
    incomingSha256: incomingHash,
    fbImageFetchMs: totalFetchMs,
  };
}

function shouldRetrySourceImageError(
  attempt: number,
  error: unknown,
  reqId: string
): boolean {
  if (attempt < FB_IMAGE_FETCH_RETRY_LIMIT && isTransientNetworkError(error)) {
    safeLog("fb_image_fetch_retry", {
      level: "debug",
      reqId,
      attempt: attempt + 1,
      reason: error instanceof Error ? error.name : "UnknownError",
    });
    return true;
  }

  return false;
}

function rethrowSourceImageError(error: unknown, reqId: string): never {
  if (
    error instanceof MissingInputImageError ||
    error instanceof InvalidSourceImageUrlError
  ) {
    throw error;
  }

  if (isTransientNetworkError(error)) {
    safeLog("missing_input_image", {
      level: "error",
      reqId,
      reason:
        error instanceof Error && error.name === "AbortError"
          ? "download_timeout"
          : "download_network_error",
    });
    throw new MissingInputImageError("Failed to download source image");
  }

  throw error;
}

async function downloadSourceImageOrThrow(
  sourceImageUrl: string,
  reqId: string,
  options?: SourceImageDownloadOptions
): Promise<DownloadedSourceImage> {
  const validatedSourceImageUrl = validateSourceImageUrlOrThrow(
    sourceImageUrl,
    reqId,
    options
  );
  const timeoutMs = getInboundImageTimeoutMs();
  let totalFetchMs = 0;

  // TODO: unify this retry loop with openAiImageClient retries once both paths can depend on the same typed retry helper.
  for (let attempt = 0; attempt <= FB_IMAGE_FETCH_RETRY_LIMIT; attempt += 1) {
    const attemptStartedAt = Date.now();

    try {
    const resolvedIpAddresses = await assertHostnameResolvesToPublicIpOrThrow(
      validatedSourceImageUrl.url,
      reqId
    );
      const { response, contentType } = await fetchSourceImageAttempt(
        validatedSourceImageUrl.url,
        resolvedIpAddresses,
        timeoutMs,
        reqId
      );
      assertNoRedirectResponse(response, reqId);

      if (!response.ok) {
        totalFetchMs += Date.now() - attemptStartedAt;
        if (shouldRetrySourceImageStatus(attempt, response, reqId)) {
          continue;
        }
        throwMissingInputDownloadFailed(reqId, response.status);
      }

      totalFetchMs += Date.now() - attemptStartedAt;
      return buildDownloadedSourceImage(
        reqId,
        contentType,
        response,
        totalFetchMs,
        options
      );
    } catch (error) {
      totalFetchMs += Date.now() - attemptStartedAt;
      if (shouldRetrySourceImageError(attempt, error, reqId)) {
        continue;
      }
      rethrowSourceImageError(error, reqId);
    }
  }

  throw new MissingInputImageError("Failed to download source image");
}

function normalizeProvidedSourceImage(
  sourceImageData: SourceImageData
): DownloadedSourceImage {
  return {
    buffer: sourceImageData.buffer,
    contentType: sourceImageData.contentType,
    incomingLen: safeLen(sourceImageData.buffer),
    incomingSha256: sha256(sourceImageData.buffer),
    fbImageFetchMs: 0,
  };
}

export function logSourceImageFetchStart(input: SourceImageResolveInput): void {
  if (!input.sourceImageUrl) {
    return;
  }

  safeLog("source_image_fetch_start", {
    reqId: input.reqId,
    trustedSourceImageUrl: Boolean(input.trustedSourceImageUrl),
    sourceImageProvenance: input.sourceImageProvenance,
    ...getSourceUrlDiagnostics(input.sourceImageUrl),
  });
}

export async function fetchExternalSourceImageForIngress(
  input: Pick<SourceImageResolveInput, "sourceImageUrl" | "reqId"> & {
    skipDebugImageProof?: boolean;
  }
): Promise<DownloadedSourceImage> {
  if (!input.sourceImageUrl) {
    throw new MissingInputImageError("Missing source image");
  }

  return downloadSourceImageOrThrow(input.sourceImageUrl, input.reqId, {
    skipDebugImageProof: input.skipDebugImageProof,
  });
}

export async function resolveStoredSourceImage(
  input: SourceImageResolveInput
): Promise<DownloadedSourceImage> {
  // TODO: combine this with logSourceImageFetchStart into a single fetcher entrypoint once ImageService is thinned further.
  if (input.sourceImageData) {
    return normalizeProvidedSourceImage(input.sourceImageData);
  }

  if (!input.sourceImageUrl) {
    return normalizeProvidedSourceImage({
      buffer: Buffer.from([]),
      contentType: "image/jpeg",
    });
  }

  if (!input.trustedSourceImageUrl || input.sourceImageProvenance !== "storeInbound") {
    throw new InvalidSourceImageUrlError(
      "Only stored source images are allowed in generation"
    );
  }

  return downloadSourceImageOrThrow(input.sourceImageUrl, input.reqId, {
    trustedSourceImageUrl: input.trustedSourceImageUrl,
    sourceImageProvenance: input.sourceImageProvenance,
  });
}
