import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createImageGenerator,
  getGeneratorStartupConfig,
  OpenAiImageGenerator,
} from "./_core/imageService";
import { buildDirectorPrompt } from "./_core/image-generation/director/directorPromptBuilder";
import { buildStylePrompt } from "./_core/image-generation/promptBuilder";

const GENERATED_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=";
const originalImageProvider = process.env.IMAGE_PROVIDER;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalAppBaseUrl = process.env.APP_BASE_URL;
const originalOpenAiImageMaxRetries = process.env.OPENAI_IMAGE_MAX_RETRIES;
const originalOpenAiImageRetryBaseMs = process.env.OPENAI_IMAGE_RETRY_BASE_MS;
const originalOpenAiImageModel = process.env.OPENAI_IMAGE_MODEL;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

function toUrlString(url: string | URL): string {
  return typeof url === "string" ? url : url.toString();
}

async function promptFromRequest(init: RequestInit | undefined): Promise<string> {
  const body = init?.body;

  if (body instanceof FormData) {
    const prompt = body.get("prompt");
    return typeof prompt === "string" ? prompt : "";
  }

  if (typeof body === "string") {
    return (JSON.parse(body) as { prompt?: string }).prompt ?? "";
  }

  return "";
}

function requestJson(init: RequestInit | undefined): unknown {
  return typeof init?.body === "string" ? JSON.parse(init.body) : null;
}

function configureOpenAiImagesEnv(imageModel?: string): void {
  process.env.OPENAI_API_KEY = "dummy-key";
  process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";

  if (imageModel) {
    process.env.OPENAI_IMAGE_MODEL = imageModel;
  }
}

function createGeneratedImageResponse(): Response {
  return {
    ok: true,
    json: async () => ({ data: [{ b64_json: GENERATED_IMAGE_BASE64 }] }),
  } as Response;
}

function generateWithSourceImageData(
  generator: OpenAiImageGenerator,
  input: Omit<
    Parameters<OpenAiImageGenerator["generate"]>[0],
    "sourceImageData"
  >
) {
  return generator.generate({
    ...input,
    sourceImageData: {
      buffer: Buffer.alloc(7000, 8),
      contentType: "image/jpeg",
    },
  });
}

describe("image provider boundary", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    restoreEnv("IMAGE_PROVIDER", originalImageProvider);
    restoreEnv("OPENAI_API_KEY", originalOpenAiApiKey);
    restoreEnv("APP_BASE_URL", originalAppBaseUrl);
    restoreEnv("OPENAI_IMAGE_MAX_RETRIES", originalOpenAiImageMaxRetries);
    restoreEnv("OPENAI_IMAGE_RETRY_BASE_MS", originalOpenAiImageRetryBaseMs);
    restoreEnv("OPENAI_IMAGE_MODEL", originalOpenAiImageModel);
  });

  it("defaults to the current OpenAI Images provider", () => {
    delete process.env.IMAGE_PROVIDER;

    const result = createImageGenerator();

    expect(result.mode).toBe("openai-images");
    expect(result.generator).toBeInstanceOf(OpenAiImageGenerator);
    expect(getGeneratorStartupConfig().mode).toBe("openai-images");
  });

  it.each(["openai-responses", "openai-responses-image"])(
    "fails fast for unsupported image provider %s",
    provider => {
      process.env.IMAGE_PROVIDER = provider;

      expect(() => createImageGenerator()).toThrow(
        `Unsupported IMAGE_PROVIDER "${provider}". Expected "openai-images".`
      );
    }
  );

  it("logs the active provider once per generation even when OpenAI retries", async () => {
    configureOpenAiImagesEnv();
    process.env.OPENAI_IMAGE_MAX_RETRIES = "1";
    process.env.OPENAI_IMAGE_RETRY_BASE_MS = "1";

    const logSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(toUrlString(url)).toBe("https://api.openai.com/v1/images/edits");

      if (fetchMock.mock.calls.length === 1) {
        return {
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
          text: async () => "temporary failure",
        } as Response;
      }

      return createGeneratedImageResponse();
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    const result = await generateWithSourceImageData(generator, {
      style: "disco",
      userKey: "user-1",
      reqId: "req-provider-log",
    });

    const providerLogs = logSpy.mock.calls
      .map(([payload]) =>
        typeof payload === "string" ? JSON.parse(payload) : payload
      )
      .filter(payload => payload?.msg === "image_provider_used");

    expect(result.imageUrl).toMatch(
      /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.jpg$/
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(providerLogs).toEqual([
      {
        level: "info",
        reqId: "req-provider-log",
        msg: "image_provider_used",
        provider: "openai-images",
        hasSourceImage: true,
      },
    ]);
  });

  it("uses the existing style prompt when no director mode is provided", async () => {
    configureOpenAiImagesEnv();

    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(await promptFromRequest(init)).toBe(
        buildStylePrompt("disco", "more glitter in the background")
      );

      return createGeneratedImageResponse();
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await generateWithSourceImageData(generator, {
      style: "disco",
      promptHint: "more glitter in the background",
      userKey: "user-1",
      reqId: "req-style-prompt",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses gpt-image-1 as the default OpenAI image model", async () => {
    configureOpenAiImagesEnv();
    delete process.env.OPENAI_IMAGE_MODEL;

    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = requestJson(init) as { model?: string };
      expect(body.model).toBe("gpt-image-1");

      return createGeneratedImageResponse();
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await generator.generate({
      style: "disco",
      userKey: "user-default-model",
      reqId: "req-default-model",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses OPENAI_IMAGE_MODEL when configured", async () => {
    configureOpenAiImagesEnv("gpt-image-2");

    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = requestJson(init) as { model?: string };
      expect(body.model).toBe("gpt-image-2");

      return createGeneratedImageResponse();
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await generator.generate({
      style: "storybook-anime",
      userKey: "user-configured-model",
      reqId: "req-configured-model",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses OPENAI_IMAGE_MODEL in OpenAI edits FormData when source image data is provided", async () => {
    configureOpenAiImagesEnv("gpt-image-2");

    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = init?.body;
      expect(body).toBeInstanceOf(FormData);
      expect((body as FormData).get("model")).toBe("gpt-image-2");

      return createGeneratedImageResponse();
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await generateWithSourceImageData(generator, {
      style: "disco",
      userKey: "user-form-data-model",
      reqId: "req-form-data-model",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends a director prompt to OpenAI when director mode is provided", async () => {
    configureOpenAiImagesEnv();

    const directorInput = {
      mode: "berlin_underground" as const,
      userInstruction: "make it feel like a late-night event poster",
      photoAnalysis: "The source photo is a mirror selfie with flat lighting.",
    };

    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      expect(await promptFromRequest(init)).toBe(
        buildDirectorPrompt(directorInput)
      );

      return createGeneratedImageResponse();
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await generateWithSourceImageData(generator, {
      style: "cyberpunk",
      promptHint: "this should not be used for director prompts",
      directorMode: directorInput.mode,
      directorInstruction: directorInput.userInstruction,
      directorPhotoAnalysis: directorInput.photoAnalysis,
      userKey: "user-1",
      reqId: "req-director-prompt",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("analyzes the source photo before building an automatic director prompt", async () => {
    configureOpenAiImagesEnv();

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const resolved = toUrlString(url);

      if (resolved === "https://api.openai.com/v1/responses") {
        const payload = requestJson(init) as {
          input?: Array<{ content?: Array<{ type?: string; image_url?: string }> }>;
        };
        const imagePart = payload.input?.[1]?.content?.find(
          part => part.type === "input_image"
        );
        expect(imagePart?.image_url).toMatch(/^data:image\/jpeg;base64,/);

        return {
          ok: true,
          json: async () => ({
            output_text:
              "Single subject, flat indoor lighting, cluttered background, centered selfie framing.",
          }),
        } as Response;
      }

      expect(resolved).toBe("https://api.openai.com/v1/images/edits");
      expect(await promptFromRequest(init)).toContain(
        "Single subject, flat indoor lighting, cluttered background, centered selfie framing."
      );

      return createGeneratedImageResponse();
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await generateWithSourceImageData(generator, {
      style: "cinematic",
      directorMode: "vogue_editorial",
      userKey: "user-1",
      reqId: "req-director-analysis",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("continues director generation when photo analysis fails", async () => {
    configureOpenAiImagesEnv();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const resolved = toUrlString(url);

      if (resolved === "https://api.openai.com/v1/responses") {
        return {
          ok: false,
          status: 500,
        } as Response;
      }

      expect(resolved).toBe("https://api.openai.com/v1/images/edits");
      expect(await promptFromRequest(init)).toContain("No photo analysis provided");

      return createGeneratedImageResponse();
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await generateWithSourceImageData(generator, {
      style: "cinematic",
      directorMode: "old_money",
      userKey: "user-1",
      reqId: "req-director-analysis-fail",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
