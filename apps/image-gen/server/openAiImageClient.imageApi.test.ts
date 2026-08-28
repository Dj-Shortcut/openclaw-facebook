import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildOpenAiRequest,
  fetchOpenAiImageResponse,
  getGenerationMetrics,
  OpenAiBudgetExceededError,
  parseOpenAiImageResponse,
} from "./_core/image-generation/openAiImageClient";

const GENERATED_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=";

const ENV_NAMES = [
  "OPENAI_API_KEY",
  "OPENAI_IMAGE_ACTION",
  "OPENAI_IMAGE_BACKGROUND",
  "OPENAI_IMAGE_INPUT_FIDELITY",
  "OPENAI_IMAGE_MAX_RETRIES",
  "OPENAI_IMAGE_OUTPUT_COMPRESSION",
  "OPENAI_IMAGE_OUTPUT_FORMAT",
  "OPENAI_IMAGE_QUALITY",
  "OPENAI_IMAGE_RETRY_BASE_MS",
  "OPENAI_IMAGE_SIZE",
  "OPENAI_IMAGE_TIMEOUT_MS",
] as const;
const originalEnv = Object.fromEntries(
  ENV_NAMES.map(name => [name, process.env[name]])
);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const name of ENV_NAMES) {
    const value = originalEnv[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function requestHeaders(init: RequestInit): Headers {
  return new Headers(init.headers);
}

describe("gpt-image-2 Image API requests", () => {
  it("uses JSON generations with validated high-quality output options", () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_IMAGE_SIZE = "1024x1536";
    process.env.OPENAI_IMAGE_OUTPUT_FORMAT = "jpeg";
    process.env.OPENAI_IMAGE_OUTPUT_COMPRESSION = "72";
    process.env.OPENAI_IMAGE_BACKGROUND = "opaque";
    process.env.OPENAI_IMAGE_INPUT_FIDELITY = "high";
    process.env.OPENAI_IMAGE_ACTION = "generate";

    const request = buildOpenAiRequest({
      model: "gpt-image-2",
      quality: "high",
      prompt: "private prompt",
      sourceImage: { buffer: Buffer.alloc(0), contentType: "image/png" },
      hasSourceImage: false,
      previousResponseId: "resp_ignored_by_image_api",
    });

    expect(request.endpoint.toString()).toBe(
      "https://api.openai.com/v1/images/generations"
    );
    expect(request.model).toBe("gpt-image-2");
    expect(request.imageRequestOptions).toEqual({
      size: "1024x1536",
      quality: "high",
    });
    expect(requestHeaders(request.requestInit).get("authorization")).toBe(
      "Bearer test-key"
    );
    expect(requestHeaders(request.requestInit).get("content-type")).toBe(
      "application/json"
    );
    expect(JSON.parse(String(request.requestInit.body))).toEqual({
      model: "gpt-image-2",
      prompt: "private prompt",
      size: "1024x1536",
      output_format: "jpeg",
      quality: "high",
      background: "opaque",
      output_compression: 72,
    });
  });

  it("uses multipart edits without overriding FormData content type", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_IMAGE_SIZE = "1536x1024";
    process.env.OPENAI_IMAGE_OUTPUT_FORMAT = "webp";
    process.env.OPENAI_IMAGE_OUTPUT_COMPRESSION = "61";
    process.env.OPENAI_IMAGE_BACKGROUND = "transparent";
    process.env.OPENAI_IMAGE_INPUT_FIDELITY = "low";
    const sourceImage = Buffer.from("source-image-bytes");

    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const request = buildOpenAiRequest({
      model: "gpt-image-2",
      quality: "high",
      prompt: "private edit prompt",
      sourceImage: { buffer: sourceImage, contentType: "image/jpeg" },
      hasSourceImage: true,
    });

    expect(request.endpoint.toString()).toBe(
      "https://api.openai.com/v1/images/edits"
    );
    expect(requestHeaders(request.requestInit).get("authorization")).toBe(
      "Bearer test-key"
    );
    expect(requestHeaders(request.requestInit).has("content-type")).toBe(false);
    expect(request.imageRequestOptions).toEqual({
      size: "1536x1024",
      quality: "high",
    });
    expect(request.requestInit.body).toBeUndefined();

    const formData = request.createRequestInit?.().body as FormData;
    expect(formData).toBeInstanceOf(FormData);
    expect(formData.get("model")).toBe("gpt-image-2");
    expect(formData.get("prompt")).toBe("private edit prompt");
    expect(formData.get("size")).toBe("1536x1024");
    expect(formData.get("quality")).toBe("high");
    expect(formData.get("output_format")).toBe("webp");
    expect(formData.get("output_compression")).toBe("61");
    expect(formData.get("background")).toBeNull();
    expect(formData.get("input_fidelity")).toBeNull();
    const image = formData.get("image[]") as File;
    expect(image.type).toBe("image/jpeg");
    expect(Buffer.from(await image.arrayBuffer())).toEqual(sourceImage);
  });

  it("sends every source photo as a separate image part for composition", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const sourceImages = [
      { buffer: Buffer.from("first-source-image"), contentType: "image/jpeg" },
      { buffer: Buffer.from("second-source-image"), contentType: "image/png" },
    ];
    const request = buildOpenAiRequest({
      model: "gpt-image-2",
      prompt: "combine both people into one portrait",
      sourceImage: sourceImages[0],
      sourceImages,
      hasSourceImage: true,
    });

    const formData = request.createRequestInit?.().body as FormData;
    const images = formData.getAll("image[]") as File[];
    expect(images).toHaveLength(2);
    expect(Buffer.from(await images[0]!.arrayBuffer())).toEqual(
      sourceImages[0]!.buffer
    );
    expect(Buffer.from(await images[1]!.arrayBuffer())).toEqual(
      sourceImages[1]!.buffer
    );
  });

  it("keeps non-gpt-image-2 requests on the Responses API", () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_IMAGE_INPUT_FIDELITY = "high";

    const request = buildOpenAiRequest({
      model: "gpt-5",
      quality: "medium",
      prompt: "private prompt",
      sourceImage: { buffer: Buffer.alloc(0), contentType: "image/png" },
      hasSourceImage: false,
      previousResponseId: "resp_123",
    });
    const body = JSON.parse(String(request.requestInit.body));

    expect(request.endpoint.toString()).toBe(
      "https://api.openai.com/v1/responses"
    );
    expect(body).toEqual(
      expect.objectContaining({
        model: "gpt-5",
        input: "private prompt",
        previous_response_id: "resp_123",
        tool_choice: { type: "image_generation" },
      })
    );
    expect(body.tools[0]).toEqual(
      expect.objectContaining({
        type: "image_generation",
        quality: "medium",
        input_fidelity: "high",
      })
    );
  });

  it("creates a fresh multipart body for every retry", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_IMAGE_MAX_RETRIES = "1";
    process.env.OPENAI_IMAGE_RETRY_BASE_MS = "1";
    const sourceImage = Buffer.from("retryable-source-image");
    const request = buildOpenAiRequest({
      model: "gpt-image-2",
      quality: "high",
      prompt: "private edit prompt",
      sourceImage: { buffer: sourceImage, contentType: "image/png" },
      hasSourceImage: true,
    });
    const requestBodies: BodyInit[] = [];
    const fetchMock = vi.fn(async (_url: URL, init?: RequestInit) => {
      requestBodies.push(init?.body as BodyInit);
      if (requestBodies.length === 1) {
        return {
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          text: async () => "temporary provider failure",
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ b64_json: GENERATED_IMAGE_BASE64 }] }),
      } as Response;
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    await fetchOpenAiImageResponse(request, {
      reqId: "request-id",
      startedAt: Date.now(),
      partialMetrics: {},
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requestBodies[0]).toBeInstanceOf(FormData);
    expect(requestBodies[1]).toBeInstanceOf(FormData);
    expect(requestBodies[1]).not.toBe(requestBodies[0]);
    for (const body of requestBodies as FormData[]) {
      const image = body.get("image[]") as File;
      expect(Buffer.from(await image.arrayBuffer())).toEqual(sourceImage);
    }
  });
});

describe("OpenAI image response parsing", () => {
  it("parses Image API base64 data", async () => {
    const response = {
      json: async () => ({ data: [{ b64_json: GENERATED_IMAGE_BASE64 }] }),
    } as Response;

    await expect(parseOpenAiImageResponse(response)).resolves.toEqual(
      Buffer.from(GENERATED_IMAGE_BASE64, "base64")
    );
  });

  it("continues to parse Responses image generation output", async () => {
    const response = {
      json: async () => ({
        output: [
          { type: "image_generation_call", result: GENERATED_IMAGE_BASE64 },
        ],
      }),
    } as Response;

    await expect(parseOpenAiImageResponse(response)).resolves.toEqual(
      Buffer.from(GENERATED_IMAGE_BASE64, "base64")
    );
  });
});

describe("OpenAI image provider errors", () => {
  function createRequest() {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.OPENAI_IMAGE_MAX_RETRIES = "0";
    return buildOpenAiRequest({
      model: "gpt-image-2",
      prompt: "private prompt",
      sourceImage: { buffer: Buffer.alloc(0), contentType: "image/png" },
      hasSourceImage: false,
    });
  }

  function createHangingBodyResponse(status: number, statusText: string) {
    const pull = vi.fn(() => new Promise<void>(() => undefined));
    const cancel = vi.fn(() => undefined);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(status < 400 ? '{"data":[' : '{"error":')
          );
        },
        pull,
        cancel,
      }),
      { status, statusText }
    );
    return { response, pull, cancel };
  }

  it.each([
    ["code", "insufficient_quota"],
    ["type", "billing_hard_limit_reached"],
  ] as const)(
    "classifies structured OpenAI error %s=%s as a hard budget limit",
    async (field, value) => {
      const onProviderAttempt = vi.fn(async () => undefined);
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(JSON.stringify({ error: { [field]: value } }), {
              status: 429,
              statusText: "Too Many Requests",
            })
        )
      );

      await expect(
        fetchOpenAiImageResponse(createRequest(), {
          reqId: "request-hard-limit",
          startedAt: Date.now(),
          partialMetrics: {},
          onProviderAttempt,
        })
      ).rejects.toBeInstanceOf(OpenAiBudgetExceededError);
      expect(onProviderAttempt).toHaveBeenCalledOnce();
    }
  );

  it("records a failed response attempt duration exactly once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        vi.setSystemTime(1_050);
        return new Response(JSON.stringify({ error: { type: "invalid" } }), {
          status: 400,
          statusText: "Bad Request",
        });
      })
    );

    const error = await fetchOpenAiImageResponse(createRequest(), {
      reqId: "request-metrics-once",
      startedAt: 1_000,
      partialMetrics: {},
    }).catch(caught => caught);

    expect(error).toBeInstanceOf(Error);
    expect(getGenerationMetrics(error)?.openAiMs).toBe(50);
  });

  it("reports an exact non-retryable 4xx once before returning the failure", async () => {
    process.env.OPENAI_IMAGE_MAX_RETRIES = "1";
    const onProviderRejected = vi.fn(async () => undefined);
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { type: "invalid_request" } }), {
          status: 400,
          statusText: "Bad Request",
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchOpenAiImageResponse(createRequest(), {
        reqId: "request-known-rejected",
        startedAt: Date.now(),
        partialMetrics: {},
        onProviderRejected,
      })
    ).rejects.toThrow("OpenAI request failed");

    expect(onProviderRejected).toHaveBeenCalledOnce();
    expect(onProviderRejected).toHaveBeenCalledWith(400);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not report retryable 5xx as a known rejection", async () => {
    process.env.OPENAI_IMAGE_MAX_RETRIES = "0";
    const onProviderRejected = vi.fn(async () => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("temporary", {
            status: 500,
            statusText: "Internal Server Error",
          })
      )
    );

    await expect(
      fetchOpenAiImageResponse(createRequest(), {
        reqId: "request-ambiguous-5xx",
        startedAt: Date.now(),
        partialMetrics: {},
        onProviderRejected,
      })
    ).rejects.toThrow("OpenAI request failed");

    expect(onProviderRejected).not.toHaveBeenCalled();
  });

  it.each([400, 403])(
    "settles a hard budget rejection %s before failing",
    async status => {
      const onProviderRejected = vi.fn(async () => undefined);
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({ error: { code: "insufficient_quota" } }),
              { status, statusText: "Rejected" }
            )
        )
      );

      await expect(
        fetchOpenAiImageResponse(createRequest(), {
          reqId: `request-budget-${status}`,
          startedAt: Date.now(),
          partialMetrics: {},
          onProviderRejected,
        })
      ).rejects.toBeInstanceOf(OpenAiBudgetExceededError);
      expect(onProviderRejected).toHaveBeenCalledWith(status);
    }
  );

  it("never retries when known-rejection settlement fails", async () => {
    process.env.OPENAI_IMAGE_MAX_RETRIES = "1";
    const settlementError = new TypeError("wallet unavailable");
    const fetchMock = vi.fn(
      async () => new Response("invalid", { status: 400 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchOpenAiImageResponse(createRequest(), {
        reqId: "request-rejected-settlement-failure",
        startedAt: Date.now(),
        partialMetrics: {},
        onProviderRejected: async () => {
          throw settlementError;
        },
      })
    ).rejects.toBe(settlementError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("records provider success before parsing a malformed 2xx body", async () => {
    const request = createRequest();
    process.env.OPENAI_IMAGE_MAX_RETRIES = "1";
    const onProviderSuccess = vi.fn(async () => undefined);
    const fetchMock = vi.fn(
      async () => new Response("not-json", { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchOpenAiImageResponse(request, {
        reqId: "request-malformed-success",
        startedAt: Date.now(),
        partialMetrics: {},
        onProviderSuccess,
      })
    ).rejects.toBeInstanceOf(SyntaxError);

    expect(onProviderSuccess).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("never retries after provider 2xx when success persistence fails", async () => {
    const request = createRequest();
    process.env.OPENAI_IMAGE_MAX_RETRIES = "1";
    const persistenceError = new TypeError("durable success unavailable");
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ data: [{ b64_json: GENERATED_IMAGE_BASE64 }] }),
          { status: 200 }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchOpenAiImageResponse(request, {
        reqId: "request-success-persistence-failure",
        startedAt: Date.now(),
        partialMetrics: {},
        onProviderSuccess: async () => {
          throw persistenceError;
        },
      })
    ).rejects.toBe(persistenceError);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([
    JSON.stringify({
      error: {
        type: "rate_limit_error",
        message: "Temporary quota pressure; try again later",
      },
    }),
    "billing_hard_limit_reached",
    JSON.stringify({ error: { message: "Monthly budget reached" } }),
  ])(
    "does not infer a hard budget limit from ordinary 429 text",
    async body => {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(body, {
              status: 429,
              statusText: "Too Many Requests",
            })
        )
      );

      await expect(
        fetchOpenAiImageResponse(createRequest(), {
          reqId: "request-rate-limit",
          startedAt: Date.now(),
          partialMetrics: {},
        })
      ).rejects.toThrow("OpenAI request failed");
    }
  );

  it("never retries a provider-attempt hook failure as a network error", async () => {
    const request = createRequest();
    process.env.OPENAI_IMAGE_MAX_RETRIES = "1";
    const admissionError = new TypeError("cost ledger unavailable");
    const onProviderAttempt = vi.fn(async () => {
      throw admissionError;
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchOpenAiImageResponse(request, {
        reqId: "request-hook-failure",
        startedAt: Date.now(),
        partialMetrics: {},
        onProviderAttempt,
      })
    ).rejects.toBe(admissionError);
    expect(onProviderAttempt).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps a misconfigured provider timeout below the privacy-fence window", async () => {
    vi.useFakeTimers();
    process.env.OPENAI_IMAGE_TIMEOUT_MS = String(60 * 60_000);
    const fetchMock = vi.fn(
      async (_url: URL, init?: RequestInit) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = fetchOpenAiImageResponse(createRequest(), {
      reqId: "request-timeout-cap",
      startedAt: Date.now(),
      partialMetrics: {},
    });
    const rejection = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    await rejection;
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps the original deadline while a successful response body hangs", async () => {
    vi.useFakeTimers();
    process.env.OPENAI_IMAGE_TIMEOUT_MS = "20";
    const hangingBody = createHangingBodyResponse(200, "OK");
    const fetchMock = vi.fn(
      async () =>
        await new Promise<Response>(resolve => {
          setTimeout(() => {
            resolve(hangingBody.response);
          }, 15);
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = fetchOpenAiImageResponse(createRequest(), {
      reqId: "request-success-body-timeout",
      startedAt: Date.now(),
      partialMetrics: {},
    });
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    const rejection = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });

    await vi.advanceTimersByTimeAsync(15);
    expect(hangingBody.pull).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(4);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(hangingBody.cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps the original deadline while an error response body hangs", async () => {
    vi.useFakeTimers();
    process.env.OPENAI_IMAGE_TIMEOUT_MS = "20";
    const hangingBody = createHangingBodyResponse(429, "Too Many Requests");
    const fetchMock = vi.fn(
      async () =>
        await new Promise<Response>(resolve => {
          setTimeout(() => {
            resolve(hangingBody.response);
          }, 15);
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const pending = fetchOpenAiImageResponse(createRequest(), {
      reqId: "request-error-body-timeout",
      startedAt: Date.now(),
      partialMetrics: {},
    });
    let settled = false;
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    const rejection = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });

    await vi.advanceTimersByTimeAsync(15);
    expect(hangingBody.pull).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(4);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    expect(hangingBody.cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
