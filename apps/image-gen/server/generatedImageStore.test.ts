import { describe, expect, it } from "vitest";

import {
  buildGeneratedImageUrl,
  getGeneratedImage,
  hashGeneratedImageToken,
  isLocalGeneratedImageUrl,
  putGeneratedImage,
} from "./_core/generatedImageStore";

describe("generatedImageStore", () => {
  it("stores generated images in memory and retrieves them by token", () => {
    const token = putGeneratedImage(Buffer.from([1, 2, 3]), "image/jpeg");
    const stored = getGeneratedImage(token);

    expect(stored).not.toBeNull();
    expect(stored?.contentType).toBe("image/jpeg");
    expect(stored?.buffer).toEqual(Buffer.from([1, 2, 3]));
  });

  it("returns null after TTL expires", async () => {
    process.env.GENERATED_IMAGE_TTL_MS = "5";
    const token = putGeneratedImage(Buffer.from([9]), "image/jpeg");

    await new Promise(resolve => setTimeout(resolve, 10));

    expect(getGeneratedImage(token)).toBeNull();
    delete process.env.GENERATED_IMAGE_TTL_MS;
  });

  it("builds generated URL with token", () => {
    const url = buildGeneratedImageUrl("https://example.com", "abc-123");
    expect(url).toBe("https://example.com/generated/abc-123.png");
  });

  it("trusts only live process-owned fallback URLs outside production", () => {
    const originalAppBaseUrl = process.env.APP_BASE_URL;
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.APP_BASE_URL = "https://example.com";
    process.env.NODE_ENV = "test";
    try {
      const token = putGeneratedImage(Buffer.from([4, 5, 6]), "image/jpeg");
      const storedUrl = buildGeneratedImageUrl(
        "https://example.com",
        token,
        "jpg"
      );

      expect(isLocalGeneratedImageUrl(storedUrl)).toBe(true);
      expect(
        isLocalGeneratedImageUrl(
          "https://example.com/generated/00000000-0000-4000-8000-000000000000.jpg"
        )
      ).toBe(false);
      expect(
        isLocalGeneratedImageUrl(
          buildGeneratedImageUrl("https://attacker.example", token, "jpg")
        )
      ).toBe(false);

      process.env.NODE_ENV = "production";
      expect(isLocalGeneratedImageUrl(storedUrl)).toBe(false);
    } finally {
      if (originalAppBaseUrl === undefined) delete process.env.APP_BASE_URL;
      else process.env.APP_BASE_URL = originalAppBaseUrl;
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it("hashes generated image tokens for logs without exposing the token", () => {
    const token = "temporary-generated-image-token";
    const tokenHash = hashGeneratedImageToken(token);

    expect(tokenHash).toMatch(/^[a-f0-9]{12}$/);
    expect(tokenHash).not.toContain(token);
  });
});
