import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildStorageRequestSignature,
  storageDelete,
  storageGet,
  storageKeyFromPublicUrl,
  storagePut,
} from "./storage";

describe("storageKeyFromPublicUrl", () => {
  const originalPublicBaseUrl = process.env.PUBLIC_BASE_URL;
  const originalForgeApiUrl = process.env.BUILT_IN_FORGE_API_URL;
  const originalForgeApiKey = process.env.BUILT_IN_FORGE_API_KEY;
  const originalStorageErrorBodyMaxChars =
    process.env.STORAGE_ERROR_BODY_MAX_CHARS;
  const originalStorageRequestTimeoutMs =
    process.env.STORAGE_REQUEST_TIMEOUT_MS;
  const originalStoragePublicBaseUrls = process.env.STORAGE_PUBLIC_BASE_URLS;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalLegacyKeys = process.env.STORAGE_ALLOW_LEGACY_KEYS;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    if (originalPublicBaseUrl === undefined) {
      delete process.env.PUBLIC_BASE_URL;
    } else {
      process.env.PUBLIC_BASE_URL = originalPublicBaseUrl;
    }

    if (originalForgeApiUrl === undefined) {
      delete process.env.BUILT_IN_FORGE_API_URL;
    } else {
      process.env.BUILT_IN_FORGE_API_URL = originalForgeApiUrl;
    }

    if (originalForgeApiKey === undefined) {
      delete process.env.BUILT_IN_FORGE_API_KEY;
    } else {
      process.env.BUILT_IN_FORGE_API_KEY = originalForgeApiKey;
    }

    if (originalStorageErrorBodyMaxChars === undefined) {
      delete process.env.STORAGE_ERROR_BODY_MAX_CHARS;
    } else {
      process.env.STORAGE_ERROR_BODY_MAX_CHARS =
        originalStorageErrorBodyMaxChars;
    }

    if (originalStorageRequestTimeoutMs === undefined) {
      delete process.env.STORAGE_REQUEST_TIMEOUT_MS;
    } else {
      process.env.STORAGE_REQUEST_TIMEOUT_MS = originalStorageRequestTimeoutMs;
    }
    if (originalStoragePublicBaseUrls === undefined) {
      delete process.env.STORAGE_PUBLIC_BASE_URLS;
    } else {
      process.env.STORAGE_PUBLIC_BASE_URLS = originalStoragePublicBaseUrls;
    }
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalLegacyKeys === undefined) {
      delete process.env.STORAGE_ALLOW_LEGACY_KEYS;
    } else {
      process.env.STORAGE_ALLOW_LEGACY_KEYS = originalLegacyKeys;
    }
  });

  it("extracts object keys from bare public URLs", () => {
    process.env.PUBLIC_BASE_URL = "https://assets.example";

    expect(
      storageKeyFromPublicUrl(
        "https://assets.example/inbound-source/photo.jpg?signature=abc"
      )
    ).toBe("inbound-source/photo.jpg");
  });

  it("rejects foreign origins and sibling base paths", () => {
    process.env.PUBLIC_BASE_URL = "https://cdn.example/assets";

    expect(
      storageKeyFromPublicUrl(
        "https://attacker.example/assets/inbound-source/photo.jpg"
      )
    ).toBeNull();
    expect(
      storageKeyFromPublicUrl(
        "https://cdn.example/assets-evil/inbound-source/photo.jpg"
      )
    ).toBeNull();
  });

  it("rejects a trusted URL outside an allowed object namespace in production", () => {
    process.env.NODE_ENV = "production";
    process.env.PUBLIC_BASE_URL = "https://cdn.example/assets";

    expect(
      storageKeyFromPublicUrl(
        "https://cdn.example/assets/another-tenant/private-object.png"
      )
    ).toBeNull();
  });

  it("strips the configured public base path prefix", () => {
    process.env.PUBLIC_BASE_URL = "https://cdn.example/assets";

    expect(
      storageKeyFromPublicUrl(
        "https://cdn.example/assets/inbound-source/photo.jpg?signature=abc"
      )
    ).toBe("inbound-source/photo.jpg");
  });

  it("uses the most specific trusted base path when origins overlap", () => {
    process.env.PUBLIC_BASE_URL = "https://cdn.example/assets";
    process.env.STORAGE_PUBLIC_BASE_URLS = "https://cdn.example";

    expect(
      storageKeyFromPublicUrl(
        "https://cdn.example/assets/inbound-source/photo.jpg"
      )
    ).toBe("inbound-source/photo.jpg");
  });

  it("bounds storage upload error bodies", async () => {
    process.env.BUILT_IN_FORGE_API_URL = "https://forge.example";
    process.env.BUILT_IN_FORGE_API_KEY = "forge-secret";
    process.env.STORAGE_ERROR_BODY_MAX_CHARS = "32";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(4096), { status: 502 }))
    );

    await expect(
      storagePut("generated/images/test.png", Buffer.from("png"))
    ).rejects.toThrow(/Storage upload failed \(502/);
    await expect(
      storagePut("generated/images/test.png", Buffer.from("png"))
    ).rejects.toThrow(`${"x".repeat(32)}...<truncated>`);
  });

  it("bounds storage downloadUrl error bodies", async () => {
    process.env.BUILT_IN_FORGE_API_URL = "https://forge.example";
    process.env.BUILT_IN_FORGE_API_KEY = "forge-secret";
    process.env.STORAGE_ERROR_BODY_MAX_CHARS = "24";
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("download-error-body".repeat(100), { status: 503 })
      )
    );

    await expect(storageGet("generated/images/test.png")).rejects.toThrow(
      /Storage downloadUrl failed \(503/
    );
    await expect(storageGet("generated/images/test.png")).rejects.toThrow(
      "download-error-bodydownl...<truncated>"
    );
  });

  it("marks storage error bodies truncated at the exact configured boundary", async () => {
    process.env.BUILT_IN_FORGE_API_URL = "https://forge.example";
    process.env.BUILT_IN_FORGE_API_KEY = "forge-secret";
    process.env.STORAGE_ERROR_BODY_MAX_CHARS = "8";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("123456789", { status: 502 }))
    );

    await expect(
      storagePut("generated/images/test.png", Buffer.from("png"))
    ).rejects.toThrow("12345678...<truncated>");
  });

  it("signs the method, exact key, scope, and short expiry", async () => {
    process.env.BUILT_IN_FORGE_API_URL = "https://forge.example";
    process.env.BUILT_IN_FORGE_API_KEY = "forge-secret";
    let requestInit: RequestInit | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
        requestInit = init;
        return new Response(null, { status: 204 });
      })
    );

    const scope = `v1/workspace-42/connection-7/binding-3/privacy-5/user-${"a".repeat(64)}`;
    const objectKey = `generated/images/${scope}/1787461200000-123e4567-e89b-42d3-a456-426614174000.png`;
    await storageDelete(objectKey);

    const headers = new Headers(requestInit?.headers);
    const expiresAt = Number(headers.get("x-leaderbot-storage-expires"));
    expect(headers.get("x-leaderbot-storage-scope")).toBe(scope);
    expect(headers.get("x-leaderbot-storage-signature")).toBe(
      `v1=${buildStorageRequestSignature({
        apiKey: "forge-secret",
        method: "DELETE",
        objectKey,
        scope,
        expiresAt,
      })}`
    );
    expect(expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1_000));
  });

  it("rejects an unscoped production key before contacting the proxy", async () => {
    process.env.NODE_ENV = "production";
    process.env.BUILT_IN_FORGE_API_URL = "https://forge.example";
    process.env.BUILT_IN_FORGE_API_KEY = "forge-secret";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(storageDelete("generated/images/legacy.png")).rejects.toThrow(
      /allowed tenant namespace/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [
      "upload",
      () => storagePut("generated/images/test.png", Buffer.from("png")),
    ],
    ["downloadUrl", () => storageGet("generated/images/test.png")],
    ["delete", () => storageDelete("generated/images/test.png")],
  ])("bounds a stalled storage %s operation", async (operation, run) => {
    vi.useFakeTimers();
    process.env.BUILT_IN_FORGE_API_URL = "https://forge.example";
    process.env.BUILT_IN_FORGE_API_KEY = "forge-secret";
    process.env.STORAGE_REQUEST_TIMEOUT_MS = "25";
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return await new Promise<Response>(() => undefined);
      })
    );

    const rejection = expect(run()).rejects.toThrow(
      `Storage ${operation} timed out after 25ms`
    );
    await vi.advanceTimersByTimeAsync(26);
    await rejection;
    expect(requestSignal?.aborted).toBe(true);
  });
});
