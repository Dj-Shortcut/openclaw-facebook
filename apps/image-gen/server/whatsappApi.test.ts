import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { downloadWhatsAppMedia } from "./_core/whatsappApi";

describe("whatsappApi media download", () => {
  const originalAccessToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const originalMaxBytes = process.env.WHATSAPP_MEDIA_MAX_BYTES;
  const originalDownloadTimeout = process.env.WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS;

  beforeEach(() => {
    process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
    process.env.WHATSAPP_MEDIA_MAX_BYTES = "10";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalAccessToken === undefined) {
      delete process.env.WHATSAPP_ACCESS_TOKEN;
    } else {
      process.env.WHATSAPP_ACCESS_TOKEN = originalAccessToken;
    }

    if (originalMaxBytes === undefined) {
      delete process.env.WHATSAPP_MEDIA_MAX_BYTES;
    } else {
      process.env.WHATSAPP_MEDIA_MAX_BYTES = originalMaxBytes;
    }

    if (originalDownloadTimeout === undefined) {
      delete process.env.WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS;
    } else {
      process.env.WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS = originalDownloadTimeout;
    }
  });

  it("rejects oversized media before buffering the response body", async () => {
    const arrayBuffer = vi.fn(async () => Buffer.alloc(11).buffer);
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              url: "https://graph.facebook.com/v19.0/media-bytes",
              mime_type: "image/jpeg",
            }),
            { status: 200 }
          )
        )
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          statusText: "OK",
          headers: new Headers({
            "content-type": "image/jpeg",
            "content-length": "11",
          }),
          body: null,
          arrayBuffer,
        } as unknown as Response)
    );

    await expect(downloadWhatsAppMedia("media-id")).rejects.toThrow(
      "WhatsApp media too large"
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("keeps the download timeout active while reading the media body", async () => {
    vi.useFakeTimers();
    process.env.WHATSAPP_MEDIA_MAX_BYTES = "100";
    process.env.WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS = "5";

    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              url: "https://graph.facebook.com/v19.0/slow-media",
              mime_type: "image/jpeg",
            }),
            { status: 200 }
          )
        )
        .mockImplementationOnce(async (_url, init) => {
          const signal = init?.signal as AbortSignal | undefined;
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              signal?.addEventListener("abort", () => {
                controller.error(new DOMException("aborted", "AbortError"));
              });
            },
          });

          return new Response(body, {
            status: 200,
            headers: { "content-type": "image/jpeg" },
          });
        })
    );

    try {
      const download = downloadWhatsAppMedia("media-id");
      const rejection = expect(download).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(5);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
