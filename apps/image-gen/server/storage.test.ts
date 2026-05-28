import { afterEach, describe, expect, it, vi } from "vitest";
import { storageGet, storageKeyFromPublicUrl, storagePut } from "./storage";

describe("storageKeyFromPublicUrl", () => {
  const originalPublicBaseUrl = process.env.PUBLIC_BASE_URL;
  const originalForgeApiUrl = process.env.BUILT_IN_FORGE_API_URL;
  const originalForgeApiKey = process.env.BUILT_IN_FORGE_API_KEY;
  const originalStorageErrorBodyMaxChars =
    process.env.STORAGE_ERROR_BODY_MAX_CHARS;

  afterEach(() => {
    vi.unstubAllGlobals();
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
  });

  it("extracts object keys from bare public URLs", () => {
    delete process.env.PUBLIC_BASE_URL;

    expect(
      storageKeyFromPublicUrl(
        "https://assets.example/inbound-source/photo.jpg?signature=abc"
      )
    ).toBe("inbound-source/photo.jpg");
  });

  it("strips the configured public base path prefix", () => {
    process.env.PUBLIC_BASE_URL = "https://cdn.example/assets";

    expect(
      storageKeyFromPublicUrl(
        "https://cdn.example/assets/inbound-source/photo.jpg?signature=abc"
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
      storagePut("generated/test.png", Buffer.from("png"))
    ).rejects.toThrow(/Storage upload failed \(502/);
    await expect(
      storagePut("generated/test.png", Buffer.from("png"))
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

    await expect(storageGet("generated/test.png")).rejects.toThrow(
      /Storage downloadUrl failed \(503/
    );
    await expect(storageGet("generated/test.png")).rejects.toThrow(
      "download-error-bodydownl...<truncated>"
    );
  });
});
