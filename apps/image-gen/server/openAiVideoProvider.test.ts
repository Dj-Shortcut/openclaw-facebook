import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAiVideoProvider } from "./_core/video-generation/openAiVideoProvider";

describe("OpenAiVideoProvider", () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalRetries = process.env.OPENAI_VIDEO_MAX_RETRIES;
  const originalRetryBase = process.env.OPENAI_VIDEO_RETRY_BASE_MS;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-openai-key";
    process.env.OPENAI_VIDEO_MAX_RETRIES = "1";
    process.env.OPENAI_VIDEO_RETRY_BASE_MS = "1";
  });

  afterEach(() => {
    global.fetch = originalFetch;
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
    if (originalRetries === undefined) {
      delete process.env.OPENAI_VIDEO_MAX_RETRIES;
    } else {
      process.env.OPENAI_VIDEO_MAX_RETRIES = originalRetries;
    }
    if (originalRetryBase === undefined) {
      delete process.env.OPENAI_VIDEO_RETRY_BASE_MS;
    } else {
      process.env.OPENAI_VIDEO_RETRY_BASE_MS = originalRetryBase;
    }
  });

  it("retries a retryable create failure and downloads completed video bytes", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(new Uint8Array([9, 8, 7]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        })
      )
      .mockResolvedValueOnce(new Response("server error", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([9, 8, 7]), {
          status: 200,
          headers: { "content-type": "image/jpeg" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "video_1", status: "completed" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        })
      );
    global.fetch = fetchMock;

    const onProviderAttempt = vi.fn(async () => undefined);
    const result = await new OpenAiVideoProvider().generateVideo({
      prompt: "make it dance",
      sourceImageUrl: "https://img.example/source.jpg",
      reqId: "req-openai-video-retry",
      userKey: "user-key",
      timeoutMs: 10_000,
      onProviderAttempt,
    });

    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(onProviderAttempt).toHaveBeenCalledTimes(2);
    const [, createRequest] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(createRequest.body).toBeInstanceOf(FormData);
    expect((createRequest.body as FormData).get("input_reference")).toBeInstanceOf(
      File
    );
    expect(result).toMatchObject({
      kind: "success",
      provider: "openai",
      providerJobId: "video_1",
      contentType: "video/mp4",
    });
    expect(result.kind === "success" ? Array.from(result.videoBytes) : []).toEqual([
      1,
      2,
      3,
    ]);
  });

  it("does not report a provider attempt when OpenAI preflight fails", async () => {
    delete process.env.OPENAI_API_KEY;
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(new Uint8Array([9, 8, 7]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      })
    );
    global.fetch = fetchMock;
    const onProviderAttempt = vi.fn(async () => undefined);

    const result = await new OpenAiVideoProvider().generateVideo({
      prompt: "make it dance",
      sourceImageUrl: "https://img.example/source.jpg",
      reqId: "req-openai-video-missing-key",
      userKey: "user-key",
      timeoutMs: 10_000,
      onProviderAttempt,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onProviderAttempt).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      kind: "failure",
      provider: "openai",
      errorClass: "unknown",
    });
  });
});
