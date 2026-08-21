import { describe, expect, it } from "vitest";
import { resolveSourceImageFetchConfig } from "./_core/image-generation/sourceImageFetchConfig";

describe("source image fetch config", () => {
  it("normalizes a tenant-independent host allowlist and timeout", () => {
    expect(
      resolveSourceImageFetchConfig({
        SOURCE_IMAGE_ALLOWED_HOSTS:
          " SCONTENT.XX.FBCDN.NET, assets.example.test ",
        FB_IMAGE_FETCH_TIMEOUT_MS: "2500",
      })
    ).toEqual({
      allowedHosts: ["scontent.xx.fbcdn.net", "assets.example.test"],
      retryLimit: 1,
      timeoutMs: 2_500,
    });
  });

  it("fails closed on the allowlist and uses a bounded timeout default", () => {
    expect(resolveSourceImageFetchConfig({})).toEqual({
      allowedHosts: [],
      retryLimit: 1,
      timeoutMs: 10_000,
    });
    expect(
      resolveSourceImageFetchConfig({ FB_IMAGE_FETCH_TIMEOUT_MS: "invalid" })
        .timeoutMs
    ).toBe(10_000);
  });
});
