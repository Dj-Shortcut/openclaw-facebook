import { describe, expect, it } from "vitest";

import { buildGeneratedImageUrl, getGeneratedImage, putGeneratedImage } from "./_core/generatedImageStore";

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
    expect(url).toBe("https://example.com/generated/abc-123.jpg");
  });
});
