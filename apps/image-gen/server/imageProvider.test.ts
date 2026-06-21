import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createImageGenerator,
  getGeneratorStartupConfig,
  OpenAiImageGenerator,
} from "./_core/imageService";
import { readCostLedgerPeriod } from "./_core/costLedger";
import { clearStateStore } from "./_core/stateStore";

const GENERATED_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=";
const originalImageProvider = process.env.IMAGE_PROVIDER;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalAppBaseUrl = process.env.APP_BASE_URL;
const originalOpenAiImageMaxRetries = process.env.OPENAI_IMAGE_MAX_RETRIES;
const originalOpenAiImageRetryBaseMs = process.env.OPENAI_IMAGE_RETRY_BASE_MS;
const originalOpenAiImageModel = process.env.OPENAI_IMAGE_MODEL;
const originalOpenAiImageEstimatedCostUsd =
  process.env.OPENAI_IMAGE_ESTIMATED_COST_USD;
const originalOpenAiImageSize = process.env.OPENAI_IMAGE_SIZE;
const originalOpenAiImageQuality = process.env.OPENAI_IMAGE_QUALITY;
const originalOpenAiImageInputFidelity =
  process.env.OPENAI_IMAGE_INPUT_FIDELITY;
const originalMessengerMaxImageJobs = process.env.MESSENGER_MAX_IMAGE_JOBS;
const originalMessengerGlobalImageLockTtlMs =
  process.env.MESSENGER_GLOBAL_IMAGE_LOCK_TTL_MS;
const originalMessengerGenerationQueueEnabled =
  process.env.MESSENGER_GENERATION_QUEUE_ENABLED;
const originalMessengerGenerationWorker =
  process.env.MESSENGER_GENERATION_WORKER;
const originalMessengerGenerationWorkerOnly =
  process.env.MESSENGER_GENERATION_WORKER_ONLY;
const originalMessengerGenerationInlineFallback =
  process.env.MESSENGER_GENERATION_INLINE_FALLBACK;
const originalMessengerGlobalDailyImageCap =
  process.env.MESSENGER_GLOBAL_DAILY_IMAGE_CAP;

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

  if (typeof body === "string") {
    const payload = JSON.parse(body) as {
      input?: string | Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };
    if (typeof payload.input === "string") {
      return payload.input;
    }
    return (
      payload.input?.[0]?.content?.find(part => part.type === "input_text")
        ?.text ?? ""
    );
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
    json: async () => ({
      output: [
        {
          type: "image_generation_call",
          result: GENERATED_IMAGE_BASE64,
        },
      ],
    }),
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
    restoreEnv(
      "OPENAI_IMAGE_ESTIMATED_COST_USD",
      originalOpenAiImageEstimatedCostUsd
    );
    restoreEnv("OPENAI_IMAGE_SIZE", originalOpenAiImageSize);
    restoreEnv("OPENAI_IMAGE_QUALITY", originalOpenAiImageQuality);
    restoreEnv("OPENAI_IMAGE_INPUT_FIDELITY", originalOpenAiImageInputFidelity);
    restoreEnv("MESSENGER_MAX_IMAGE_JOBS", originalMessengerMaxImageJobs);
    restoreEnv(
      "MESSENGER_GLOBAL_IMAGE_LOCK_TTL_MS",
      originalMessengerGlobalImageLockTtlMs
    );
    restoreEnv(
      "MESSENGER_GENERATION_QUEUE_ENABLED",
      originalMessengerGenerationQueueEnabled
    );
    restoreEnv("MESSENGER_GENERATION_WORKER", originalMessengerGenerationWorker);
    restoreEnv(
      "MESSENGER_GENERATION_WORKER_ONLY",
      originalMessengerGenerationWorkerOnly
    );
    restoreEnv(
      "MESSENGER_GENERATION_INLINE_FALLBACK",
      originalMessengerGenerationInlineFallback
    );
    restoreEnv(
      "MESSENGER_GLOBAL_DAILY_IMAGE_CAP",
      originalMessengerGlobalDailyImageCap
    );
    clearStateStore();
  });

  it("defaults to the current OpenAI Images provider", () => {
    delete process.env.IMAGE_PROVIDER;

    const result = createImageGenerator();

    expect(result.mode).toBe("openai-images");
    expect(result.generator).toBeInstanceOf(OpenAiImageGenerator);
    expect(getGeneratorStartupConfig()).toEqual(
      expect.objectContaining({
        mode: "openai-images",
        messengerGenerationGlobalLimit: {
          redisBacked: false,
          max: 3,
          lockTtlMs: 240000,
        },
        messengerGenerationDailyBudget: {
          enabled: false,
          cap: null,
        },
        messengerGenerationRuntime: {
          queueEnabled: false,
          workerMode: false,
          workerOnlyMode: false,
          inlineFallbackEnabled: true,
        },
      })
    );
  });

  it("includes Messenger generation runtime mode in startup config", () => {
    delete process.env.MESSENGER_GENERATION_QUEUE_ENABLED;
    delete process.env.MESSENGER_MAX_IMAGE_JOBS;
    delete process.env.MESSENGER_GLOBAL_IMAGE_LOCK_TTL_MS;
    process.env.MESSENGER_GENERATION_WORKER = "1";
    process.env.MESSENGER_GENERATION_WORKER_ONLY = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";

    expect(getGeneratorStartupConfig()).toEqual(
      expect.objectContaining({
        messengerGenerationRuntime: {
          queueEnabled: false,
          workerMode: true,
          workerOnlyMode: true,
          inlineFallbackEnabled: false,
        },
      })
    );
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
      expect(toUrlString(url)).toBe("https://api.openai.com/v1/responses");

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
    const onProviderAttempt = vi.fn(async () => undefined);
    const result = await generateWithSourceImageData(generator, {
      userKey: "user-1",
      reqId: "req-provider-log",
      onProviderAttempt,
    });

    const providerLogs = logSpy.mock.calls
      .map(([payload]) =>
        typeof payload === "string" ? JSON.parse(payload) : payload
      )
      .filter(payload => payload?.msg === "image_provider_used");

    expect(result.imageUrl).toMatch(
      /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.png$/
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onProviderAttempt).toHaveBeenCalledTimes(2);
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

  it("does not burn the global image cap when user quota rejects before fetch", async () => {
    configureOpenAiImagesEnv();
    process.env.MESSENGER_GLOBAL_DAILY_IMAGE_CAP = "1";

    const fetchMock = vi.fn(async () => createGeneratedImageResponse());
    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await expect(
      generator.generate({
        userKey: "user-quota-rejected",
        reqId: "req-user-quota-rejected",
        onProviderAttempt: async () => {
          throw new Error("user quota exhausted");
        },
      })
    ).rejects.toThrow("user quota exhausted");

    expect(fetchMock).not.toHaveBeenCalled();

    await expect(
      generator.generate({
        userKey: "user-cap-still-available",
        reqId: "req-cap-still-available",
        onProviderAttempt: async () => undefined,
      })
    ).resolves.toEqual(
      expect.objectContaining({
        imageUrl: expect.stringMatching(
          /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.png$/
        ),
      })
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses prompt-first source-image edits when stale style jobs have no director mode", async () => {
    configureOpenAiImagesEnv();

    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const prompt = await promptFromRequest(init);
      expect(prompt).toContain("Edit the uploaded/source image according to the user's request.");
      expect(prompt).toContain("not as a preset style catalog");
      expect(prompt).toContain("User request: more glitter in the background");
      expect(prompt).not.toContain("glamorous disco-era hero shot");

      return createGeneratedImageResponse();
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await generateWithSourceImageData(generator, {
      promptHint: "more glitter in the background",
      userKey: "user-1",
      reqId: "req-style-prompt",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses gpt-5 as the default OpenAI Responses model", async () => {
    configureOpenAiImagesEnv();
    delete process.env.OPENAI_IMAGE_MODEL;

    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = requestJson(init) as { model?: string };
      expect(body.model).toBe("gpt-5");

      return createGeneratedImageResponse();
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await generator.generate({
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
      userKey: "user-configured-model",
      reqId: "req-configured-model",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("logs image cost estimate metadata without prompt content", async () => {
    configureOpenAiImagesEnv("gpt-image-2");
    process.env.OPENAI_IMAGE_ESTIMATED_COST_USD = "0.025";
    process.env.OPENAI_IMAGE_SIZE = "1024x1536";
    process.env.OPENAI_IMAGE_QUALITY = "medium";
    const privatePrompt = "private tester prompt for a neon train station";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const fetchMock = vi.fn(async () => createGeneratedImageResponse());
    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await generator.generate({
      generationKind: "text_to_image",
      promptHint: privatePrompt,
      userKey: "testuser",
      reqId: "req-cost-estimate",
    });

    const parsedLogs = logSpy.mock.calls.map(([payload]) =>
      typeof payload === "string" ? JSON.parse(payload) : payload
    );
    const serializedLogs = JSON.stringify(parsedLogs);
    const costLogs = parsedLogs.filter(
      payload => payload?.event === "image_generation_cost_estimate"
    );

    expect(costLogs).toEqual([
      {
        level: "info",
        event: "image_generation_cost_estimate",
        reqId: "req-cost-estimate",
        user: "testuser",
        provider: "openai-images",
        model: "gpt-image-2",
        pricingModel: "gpt-image-1",
        generationKind: "text_to_image",
        hasSourceImage: false,
        size: "1024x1536",
        quality: "medium",
        inputFidelity: null,
        estimatedCostUsd: 0.025,
        estimatedOutputCostUsd: null,
        costEstimateComplete: true,
        unpricedCostComponents: [],
        estimateSource: "env_override",
        status: "provider_response_received",
      },
    ]);
    const ledger = await readCostLedgerPeriod(new Date().toISOString().slice(0, 10));
    expect(ledger).toEqual([
      expect.objectContaining({
        channel: "facebook_messenger",
        operation: "image_generation",
        provider: "openai-images",
        model: "gpt-image-2",
        pricingModel: "gpt-image-1",
        userKey: "testuser",
        reqId: "req-cost-estimate",
        generationKind: "text_to_image",
        status: "provider_attempt_started",
        estimatedCostUsd: 0.025,
        estimatedOutputCostUsd: null,
        finalCostUsd: null,
        costEstimateComplete: true,
        estimateSource: "env_override",
        unpricedCostComponents: [],
      }),
    ]);
    expect(serializedLogs).not.toContain(privatePrompt);
    expect(JSON.stringify(ledger)).not.toContain(privatePrompt);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("marks source-image edit cost estimates as partial input-unpriced metadata", async () => {
    configureOpenAiImagesEnv("gpt-5");
    process.env.OPENAI_IMAGE_SIZE = "1024x1024";
    process.env.OPENAI_IMAGE_QUALITY = "medium";
    process.env.OPENAI_IMAGE_INPUT_FIDELITY = "high";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const fetchMock = vi.fn(async () => createGeneratedImageResponse());
    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await generateWithSourceImageData(generator, {
      generationKind: "source_image_edit",
      promptHint: "make the product shot brighter",
      userKey: "source-edit-user",
      reqId: "req-source-edit-cost-estimate",
    });

    const costLogs = logSpy.mock.calls
      .map(([payload]) =>
        typeof payload === "string" ? JSON.parse(payload) : payload
      )
      .filter(payload => payload?.event === "image_generation_cost_estimate");

    expect(costLogs).toEqual([
      {
        level: "info",
        event: "image_generation_cost_estimate",
        reqId: "req-source-edit-cost-estimate",
        user: "source-e",
        provider: "openai-images",
        model: "gpt-5",
        pricingModel: "gpt-image-1",
        generationKind: "source_image_edit",
        hasSourceImage: true,
        size: "1024x1024",
        quality: "medium",
        inputFidelity: "high",
        estimatedCostUsd: null,
        estimatedOutputCostUsd: 0.042,
        costEstimateComplete: false,
        unpricedCostComponents: ["source_image_input"],
        estimateSource: "partial_source_image_input_unpriced",
        status: "provider_response_received",
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks the OpenAI request when the host daily image cap is reached", async () => {
    configureOpenAiImagesEnv("gpt-image-2");
    process.env.MESSENGER_GLOBAL_DAILY_IMAGE_CAP = "1";
    const fetchMock = vi.fn(async () => createGeneratedImageResponse());
    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await expect(
      generator.generate({
        userKey: "user-budget-cap",
        reqId: "req-budget-cap",
      })
    ).resolves.toBeDefined();

    process.env.MESSENGER_GLOBAL_DAILY_IMAGE_CAP = "1";
    const onProviderAttempt = vi.fn(async () => undefined);
    await expect(
      generator.generate({
        userKey: "user-budget-cap",
        reqId: "req-budget-over-cap",
        onProviderAttempt,
      })
    ).rejects.toThrow("Messenger daily image budget reached");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onProviderAttempt).not.toHaveBeenCalled();
  });

  it("uses OPENAI_IMAGE_MODEL and image_generation tool when source image data is provided", async () => {
    configureOpenAiImagesEnv("gpt-image-2");

    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = requestJson(init) as {
        model?: string;
        input?: Array<{ content?: Array<{ type?: string; image_url?: string }> }>;
        tools?: Array<{ type?: string; output_format?: string }>;
        tool_choice?: { type?: string };
      };
      expect(body.model).toBe("gpt-image-2");
      expect(body.tools).toEqual([
        expect.objectContaining({
          type: "image_generation",
          output_format: "png",
        }),
      ]);
      expect(body.tool_choice).toEqual({ type: "image_generation" });
      expect(body.input?.[0]?.content?.find(part => part.type === "input_image")?.image_url).toMatch(
        /^data:image\/jpeg;base64,/
      );

      return createGeneratedImageResponse();
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await generateWithSourceImageData(generator, {
      userKey: "user-form-data-model",
      reqId: "req-form-data-model",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps source edits prompt-first without director template terms", async () => {
    configureOpenAiImagesEnv();

    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const prompt = await promptFromRequest(init);
      expect(prompt).toContain("Edit the uploaded/source image");
      expect(prompt).toContain("User request: make it feel like a late-night event poster");
      expect(prompt).not.toContain("Berlin Underground");
      expect(prompt).not.toContain("raw techno-club energy");
      expect(prompt).not.toContain("Photo analysis:");

      return createGeneratedImageResponse();
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await generateWithSourceImageData(generator, {
      promptHint: "make it feel like a late-night event poster",
      userKey: "user-1",
      reqId: "req-director-prompt",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not include director photo analysis in prompt-first source edits", async () => {
    configureOpenAiImagesEnv();

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const resolved = toUrlString(url);
      expect(resolved).toBe("https://api.openai.com/v1/responses");

      const prompt = await promptFromRequest(init);
      expect(prompt).toContain("Edit the uploaded/source image");
      expect(prompt).not.toContain("Single subject, flat indoor lighting");
      expect(prompt).not.toContain("Vogue Editorial");
      return createGeneratedImageResponse();
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await generateWithSourceImageData(generator, {
      promptHint: "make it cleaner and more editorial",
      userKey: "user-1",
      reqId: "req-director-analysis",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not call a director analysis path for source edits", async () => {
    configureOpenAiImagesEnv();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const resolved = toUrlString(url);
      expect(resolved).toBe("https://api.openai.com/v1/responses");

      const prompt = await promptFromRequest(init);
      expect(prompt).toContain("Edit the uploaded/source image");
      expect(prompt).not.toContain("No photo analysis provided");
      expect(prompt).not.toContain("Old Money");
      return createGeneratedImageResponse();
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await generateWithSourceImageData(generator, {
      promptHint: "make it feel more premium but natural",
      userKey: "user-1",
      reqId: "req-director-analysis-fail",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses prompt-first source-image edits without the cinematic preset prompt", async () => {
    configureOpenAiImagesEnv();

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const resolved = toUrlString(url);
      if (resolved === "https://api.openai.com/v1/responses") {
        const prompt = await promptFromRequest(init);
        expect(prompt).toContain("Edit the uploaded/source image");
        expect(prompt).toContain("User request: Kan je me een samurai maken");
        expect(prompt).not.toContain("prestige-film still");
        expect(prompt).not.toContain("teal-and-amber");
        return createGeneratedImageResponse();
      }
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await generateWithSourceImageData(generator, {
      generationKind: "source_image_edit",
      promptHint: "Kan je me een samurai maken",
      userKey: "user-1",
      reqId: "req-source-image-edit",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
