import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildOpenAiRequest,
  fetchOpenAiImageResponse,
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
] as const;
const originalEnv = Object.fromEntries(
  ENV_NAMES.map(name => [name, process.env[name]])
);

afterEach(() => {
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
    expect(request.imageCostOptions).toEqual({
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
    expect(request.imageCostOptions).toEqual({
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
