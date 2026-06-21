import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClientRequest, IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import {
  InvalidSourceImageUrlError,
  fetchExternalSourceImageForIngress,
  setSourceImageDnsLookupForTests,
} from "./_core/image-generation/sourceImageFetcher";

const { mockHttpsRequest } = vi.hoisted(() => ({
  mockHttpsRequest: vi.fn(),
}));

vi.mock("node:https", async importOriginal => {
  const actual = await importOriginal<typeof import("node:https")>();
  return {
    ...actual,
    request: mockHttpsRequest,
  };
});

function createHttpResponse(options: {
  statusCode: number;
  statusMessage: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
}): IncomingMessage {
  const response = new PassThrough() as IncomingMessage;
  Object.assign(response, {
    statusCode: options.statusCode,
    statusMessage: options.statusMessage,
    headers: options.headers ?? {},
  });
  if (options.body) {
    response.end(options.body);
  } else {
    response.end();
  }
  return response;
}

describe("source image fetcher", () => {
  afterEach(() => {
    mockHttpsRequest.mockReset();
    delete process.env.SOURCE_IMAGE_ALLOWED_HOSTS;
    setSourceImageDnsLookupForTests(null);
    vi.restoreAllMocks();
  });

  it("pins the outbound request to a validated public DNS address", async () => {
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = "scontent.xx.fbcdn.net";
    setSourceImageDnsLookupForTests(async () => [{ address: "31.13.84.36", family: 4 }]);

    const fixture = Buffer.alloc(7000, 9);
    const sourceImageUrl =
      "https://scontent-atl3-3.xx.fbcdn.net/v/t39.30808-6/photo.jpg?stp=dst-jpg";

    mockHttpsRequest.mockImplementation((input: unknown, callback?: (res: IncomingMessage) => void) => {
      const requestOptions = input as {
        hostname?: string;
        servername?: string;
        headers?: Record<string, string>;
      };
      callback?.(
        createHttpResponse({
          statusCode: 200,
          statusMessage: "OK",
          headers: { "content-type": "image/jpeg" },
          body: fixture,
        })
      );
      expect(requestOptions.headers?.host).toBe("scontent-atl3-3.xx.fbcdn.net");
      return new PassThrough() as ClientRequest;
    });

    const downloaded = await fetchExternalSourceImageForIngress({
      sourceImageUrl,
      reqId: "req-meta-scontent-pinned",
    });

    expect(downloaded.buffer).toEqual(fixture);
    expect(downloaded.contentType).toBe("image/jpeg");
    expect(mockHttpsRequest).toHaveBeenCalledTimes(1);
    expect(mockHttpsRequest.mock.calls[0]?.[0]).toMatchObject({
      hostname: "31.13.84.36",
      servername: "scontent-atl3-3.xx.fbcdn.net",
    });
  });

  it("blocks source-image fetches when DNS resolves to private addresses", async () => {
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = "scontent.xx.fbcdn.net";
    setSourceImageDnsLookupForTests(async () => [{ address: "10.0.0.1", family: 4 }]);

    await expect(
      fetchExternalSourceImageForIngress({
        sourceImageUrl:
          "https://scontent-atl3-3.xx.fbcdn.net/v/t39.30808-6/photo.jpg?stp=dst-jpg",
        reqId: "req-source-private-dns",
      })
    ).rejects.toBeInstanceOf(InvalidSourceImageUrlError);

    expect(mockHttpsRequest).not.toHaveBeenCalled();
  });

  it("keeps redirects blocked for source-image fetches", async () => {
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = "scontent.xx.fbcdn.net";
    setSourceImageDnsLookupForTests(async () => [{ address: "31.13.84.36", family: 4 }]);

    mockHttpsRequest.mockImplementation((_: unknown, callback?: (res: IncomingMessage) => void) => {
      callback?.(
        createHttpResponse({
          statusCode: 301,
          statusMessage: "Moved Permanently",
          headers: { location: "https://malicious.example/redirected" },
        })
      );
      return new PassThrough() as ClientRequest;
    });

    await expect(
      fetchExternalSourceImageForIngress({
        sourceImageUrl:
          "https://scontent-atl3-3.xx.fbcdn.net/v/t39.30808-6/photo.jpg?stp=dst-jpg",
        reqId: "req-source-redirect",
      })
    ).rejects.toBeInstanceOf(InvalidSourceImageUrlError);
  });

  it("allows regional Meta scontent hosts when the Meta CDN pattern is configured", async () => {
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = "scontent.xx.fbcdn.net";
    setSourceImageDnsLookupForTests(async () => [{ address: "31.13.84.36", family: 4 }]);
    const fixture = Buffer.alloc(7000, 9);

    mockHttpsRequest.mockImplementation((_: unknown, callback?: (res: IncomingMessage) => void) => {
      callback?.(
        createHttpResponse({
          statusCode: 200,
          statusMessage: "OK",
          headers: { "content-type": "image/jpeg" },
          body: fixture,
        })
      );
      return new PassThrough() as ClientRequest;
    });

    const downloaded = await fetchExternalSourceImageForIngress({
      sourceImageUrl:
        "https://scontent-atl3-3.xx.fbcdn.net/v/t39.30808-6/photo.jpg?stp=dst-jpg",
      reqId: "req-meta-scontent",
    });

    expect(downloaded.buffer).toEqual(fixture);
    expect(downloaded.contentType).toBe("image/jpeg");
  });
});
