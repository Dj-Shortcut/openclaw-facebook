import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchExternalSourceImageForIngress,
  setSourceImageDnsLookupForTests,
} from "./_core/image-generation/sourceImageFetcher";

function toUrlString(url: string | URL): string {
  return typeof url === "string" ? url : url.toString();
}

describe("source image fetcher", () => {
  afterEach(() => {
    delete process.env.SOURCE_IMAGE_ALLOWED_HOSTS;
    setSourceImageDnsLookupForTests(null);
    vi.unstubAllGlobals();
  });

  it("allows regional Meta scontent hosts when the Meta CDN pattern is configured", async () => {
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = "scontent.xx.fbcdn.net";
    setSourceImageDnsLookupForTests(async () => [
      { address: "31.13.84.36", family: 4 },
    ]);
    const fixture = Buffer.alloc(7000, 9);
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(toUrlString(url)).toBe(
        "https://scontent-atl3-3.xx.fbcdn.net/v/t39.30808-6/photo.jpg?stp=dst-jpg"
      );
      return new Response(fixture, {
        status: 200,
        headers: new Headers({ "content-type": "image/jpeg" }),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const downloaded = await fetchExternalSourceImageForIngress({
      sourceImageUrl:
        "https://scontent-atl3-3.xx.fbcdn.net/v/t39.30808-6/photo.jpg?stp=dst-jpg",
      reqId: "req-meta-scontent",
    });

    expect(downloaded.buffer).toEqual(fixture);
    expect(downloaded.contentType).toBe("image/jpeg");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
