import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  createImageGenerator,
  getGeneratorStartupConfig,
  OpenAiImageGenerator,
} from "./_core/imageService";
import * as costLedger from "./_core/costLedger";
import { readCostLedgerPeriod } from "./_core/costLedger";
import { clearStateStore } from "./_core/stateStore";

const GENERATED_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=";
const originalImageProvider = process.env.IMAGE_PROVIDER;
const originalNodeEnv = process.env.NODE_ENV;
const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalAppBaseUrl = process.env.APP_BASE_URL;
const originalOpenAiImageMaxRetries = process.env.OPENAI_IMAGE_MAX_RETRIES;
const originalOpenAiImageRetryBaseMs = process.env.OPENAI_IMAGE_RETRY_BASE_MS;
const originalOpenAiImageModel = process.env.OPENAI_IMAGE_MODEL;
const originalRemovedOpenAiImageEstimatedCostUsd =
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
const originalMessengerFreeDailyLimit = process.env.MESSENGER_FREE_DAILY_LIMIT;
const originalMessengerFreeMonthlyLimit =
  process.env.MESSENGER_FREE_MONTHLY_LIMIT;
const originalMessengerImageQuotaTimeZone =
  process.env.MESSENGER_IMAGE_QUOTA_TIME_ZONE;
const originalMessengerGlobalDailySpendCapUsd =
  process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD;
const originalMessengerGlobalMonthlySpendCapUsd =
  process.env.MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD;
const originalMessengerUserDailySpendCapUsd =
  process.env.MESSENGER_USER_DAILY_SPEND_CAP_USD;

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

async function promptFromRequest(
  init: RequestInit | undefined
): Promise<string> {
  const body = init?.body;

  if (body instanceof FormData) {
    return String(body.get("prompt") ?? "");
  }

  if (typeof body === "string") {
    const payload = JSON.parse(body) as {
      prompt?: string;
      input?:
        string | Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };
    if (typeof payload.prompt === "string") {
      return payload.prompt;
    }
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

function requestSummaryKey(reqId: string): string {
  return `sha256:${createHash("sha256").update(reqId).digest("hex").slice(0, 12)}`;
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

function createImageApiGeneratedResponse(): Response {
  return {
    ok: true,
    json: async () => ({
      data: [{ b64_json: GENERATED_IMAGE_BASE64 }],
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
    restoreEnv("NODE_ENV", originalNodeEnv);
    restoreEnv("OPENAI_API_KEY", originalOpenAiApiKey);
    restoreEnv("APP_BASE_URL", originalAppBaseUrl);
    restoreEnv("OPENAI_IMAGE_MAX_RETRIES", originalOpenAiImageMaxRetries);
    restoreEnv("OPENAI_IMAGE_RETRY_BASE_MS", originalOpenAiImageRetryBaseMs);
    restoreEnv("OPENAI_IMAGE_MODEL", originalOpenAiImageModel);
    restoreEnv(
      "OPENAI_IMAGE_ESTIMATED_COST_USD",
      originalRemovedOpenAiImageEstimatedCostUsd
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
    restoreEnv(
      "MESSENGER_GENERATION_WORKER",
      originalMessengerGenerationWorker
    );
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
    restoreEnv("MESSENGER_FREE_DAILY_LIMIT", originalMessengerFreeDailyLimit);
    restoreEnv(
      "MESSENGER_FREE_MONTHLY_LIMIT",
      originalMessengerFreeMonthlyLimit
    );
    restoreEnv(
      "MESSENGER_IMAGE_QUOTA_TIME_ZONE",
      originalMessengerImageQuotaTimeZone
    );
    restoreEnv(
      "MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD",
      originalMessengerGlobalDailySpendCapUsd
    );
    restoreEnv(
      "MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD",
      originalMessengerGlobalMonthlySpendCapUsd
    );
    restoreEnv(
      "MESSENGER_USER_DAILY_SPEND_CAP_USD",
      originalMessengerUserDailySpendCapUsd
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
          lockTtlMs: 900000,
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

  it("requires image retries to be explicitly disabled in production", () => {
    process.env.NODE_ENV = "production";
    process.env.MESSENGER_FREE_DAILY_LIMIT = "5";
    process.env.MESSENGER_FREE_MONTHLY_LIMIT = "20";
    process.env.MESSENGER_IMAGE_QUOTA_TIME_ZONE = "Europe/Brussels";
    delete process.env.OPENAI_IMAGE_MAX_RETRIES;

    expect(() => getGeneratorStartupConfig()).toThrow(
      "OPENAI_IMAGE_MAX_RETRIES must be explicitly set to 0 in production"
    );

    process.env.OPENAI_IMAGE_MAX_RETRIES = "1";
    expect(() => getGeneratorStartupConfig()).toThrow(
      "OPENAI_IMAGE_MAX_RETRIES must be explicitly set to 0 in production"
    );

    process.env.OPENAI_IMAGE_MAX_RETRIES = "0";
    expect(() => getGeneratorStartupConfig()).not.toThrow();
  });

  it("requires the simple 5/day and 20/month photo policy in production", () => {
    process.env.NODE_ENV = "production";
    process.env.OPENAI_IMAGE_MAX_RETRIES = "0";
    process.env.MESSENGER_FREE_DAILY_LIMIT = "5";
    process.env.MESSENGER_FREE_MONTHLY_LIMIT = "20";
    process.env.MESSENGER_IMAGE_QUOTA_TIME_ZONE = "Europe/Brussels";

    expect(() => getGeneratorStartupConfig()).not.toThrow();

    process.env.MESSENGER_FREE_MONTHLY_LIMIT = "21";
    expect(() => getGeneratorStartupConfig()).toThrow(
      "MESSENGER_FREE_MONTHLY_LIMIT must be explicitly set to 20 in production"
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

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
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

    const onProviderAttempt = vi.fn(async () => undefined);
    const generator = new OpenAiImageGenerator();
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
    expect(onProviderAttempt).toHaveBeenCalledOnce();
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

  it("does not call the provider when provider-attempt admission rejects", async () => {
    configureOpenAiImagesEnv();

    const fetchMock = vi.fn(async () => createGeneratedImageResponse());
    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await expect(
      generator.generate({
        userKey: "user-admission-rejected",
        reqId: "req-admission-rejected",
        onProviderAttempt: async () => {
          throw new Error("user quota exhausted");
        },
      })
    ).rejects.toThrow("user quota exhausted");

    expect(fetchMock).not.toHaveBeenCalled();
    expect(
      await readCostLedgerPeriod(new Date().toISOString().slice(0, 10))
    ).toEqual([]);

    await expect(
      generator.generate({
        userKey: "user-next-request",
        reqId: "req-next-request",
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

  it("aborts admission without provider transport when the ledger write fails", async () => {
    configureOpenAiImagesEnv();
    const ledgerFailure = new Error("cost ledger unavailable");
    vi.spyOn(costLedger, "appendCostLedgerEntry").mockRejectedValueOnce(
      ledgerFailure
    );
    const fetchMock = vi.fn(async () => createGeneratedImageResponse());
    vi.stubGlobal("fetch", fetchMock);
    const markTransportStarted = vi.fn(async () => undefined);
    const abortBeforeTransport = vi.fn(async () => undefined);
    const generator = new OpenAiImageGenerator();

    await expect(
      generator.generate({
        userKey: "user-ledger-failure",
        reqId: "req-ledger-failure",
        onProviderAttempt: async () => ({
          markTransportStarted,
          abortBeforeTransport,
        }),
      })
    ).rejects.toBe(ledgerFailure);

    expect(abortBeforeTransport).toHaveBeenCalledOnce();
    expect(markTransportStarted).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses a fresh ledger entry when paid admission retries a request", async () => {
    configureOpenAiImagesEnv();
    const fetchMock = vi.fn(async () => createGeneratedImageResponse());
    vi.stubGlobal("fetch", fetchMock);
    const admissionFailure = new Error("paid admission unavailable");
    const abortBeforeTransport = vi.fn(async () => undefined);
    const generator = new OpenAiImageGenerator();

    await expect(
      generator.generate({
        userKey: "paid-admission-retry-user",
        reqId: "req-paid-admission-retry",
        onProviderAttempt: async () => ({
          markTransportStarted: async () => {
            throw admissionFailure;
          },
          abortBeforeTransport,
        }),
      })
    ).rejects.toBe(admissionFailure);

    await expect(
      generator.generate({
        userKey: "paid-admission-retry-user",
        reqId: "req-paid-admission-retry",
        onProviderAttempt: async () => ({
          markTransportStarted: async () => undefined,
          abortBeforeTransport: async () => undefined,
        }),
      })
    ).resolves.toEqual(
      expect.objectContaining({
        imageUrl: expect.stringContaining("/generated/"),
      })
    );

    const ledgerEntries = await readCostLedgerPeriod(
      new Date().toISOString().slice(0, 10)
    );
    expect(ledgerEntries).toHaveLength(2);
    expect(ledgerEntries[0]).toMatchObject({
      id: expect.stringMatching(
        /^req-paid-admission-retry:openai-image:[0-9a-f-]{36}:1$/i
      ),
      status: "provider_attempt_failed",
    });
    expect(ledgerEntries[1]).toMatchObject({
      id: expect.stringMatching(
        /^req-paid-admission-retry:openai-image:[0-9a-f-]{36}:1$/i
      ),
      status: "provider_attempt_succeeded",
    });
    expect(ledgerEntries[0]?.id).not.toBe(ledgerEntries[1]?.id);
    expect(abortBeforeTransport).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses prompt-first source-image edits when stale style jobs have no director mode", async () => {
    configureOpenAiImagesEnv();

    const fetchMock = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const prompt = await promptFromRequest(init);
      expect(prompt).toContain(
        "Edit the uploaded/source image according to the user's request."
      );
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

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = requestJson(init) as {
        model?: string;
        output_format?: string;
      };
      expect(toUrlString(url)).toBe(
        "https://api.openai.com/v1/images/generations"
      );
      expect(body).toEqual(
        expect.objectContaining({
          model: "gpt-image-2",
          output_format: "png",
        })
      );

      return createImageApiGeneratedResponse();
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await generator.generate({
      userKey: "user-configured-model",
      reqId: "req-configured-model",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("records image attempt metadata without prices or prompt content", async () => {
    configureOpenAiImagesEnv("gpt-image-2");
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
      costLedgerChannel: "facebook_messenger",
      costLedgerScope: {
        workspaceId: 42,
        channelConnectionId: 7,
        bindingEpoch: 3,
        privacyEpoch: 5,
        userKey: "testuser",
      },
    });
    const ledgerEntries = await readCostLedgerPeriod(
      new Date().toISOString().slice(0, 10)
    );

    const parsedLogs = logSpy.mock.calls.map(([payload]) =>
      typeof payload === "string" ? JSON.parse(payload) : payload
    );
    const serializedLogs = JSON.stringify(parsedLogs);
    const priceLogs = parsedLogs.filter(
      payload => payload?.event === "image_generation_cost_estimate"
    );

    expect(priceLogs).toEqual([]);
    expect(ledgerEntries).toEqual([
      expect.objectContaining({
        id: "req-cost-estimate:openai-image:1",
        channel: "facebook_messenger",
        operation: "image_generation",
        provider: "openai-images",
        model: "gpt-image-2",
        workspaceId: 42,
        channelConnectionId: 7,
        bindingEpoch: 3,
        privacyEpoch: 5,
        providerUsage: {
          generationKind: "text_to_image",
          hasSourceImage: false,
          size: "1024x1536",
          quality: "medium",
          inputFidelity: null,
        },
        userKey: "testuser",
        reqId: requestSummaryKey("req-cost-estimate"),
        status: "provider_attempt_succeeded",
        estimatedCostUsd: null,
        estimatedOutputCostUsd: null,
        finalCostUsd: null,
        costEstimateComplete: false,
        estimateSource: null,
        unpricedCostComponents: ["image_generation"],
      }),
    ]);
    expect(serializedLogs).not.toContain(privatePrompt);
    expect(JSON.stringify(ledgerEntries)).not.toContain(privatePrompt);
    expect(JSON.stringify(ledgerEntries)).not.toContain("facebook:");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("marks image attempt ledger entries failed when the provider request fails", async () => {
    configureOpenAiImagesEnv("gpt-image-2");
    process.env.OPENAI_IMAGE_MAX_RETRIES = "0";
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { message: "provider unavailable" } }),
          {
            headers: { "content-type": "application/json" },
            status: 500,
            statusText: "Internal Server Error",
          }
        )
    );
    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await expect(
      generator.generate({
        generationKind: "text_to_image",
        promptHint: "private prompt should not be stored",
        userKey: "failed-cost-user",
        reqId: "req-cost-failed",
      })
    ).rejects.toThrow("OpenAI request failed");

    const ledgerEntries = await readCostLedgerPeriod(
      new Date().toISOString().slice(0, 10)
    );
    expect(ledgerEntries).toEqual([
      expect.objectContaining({
        id: "req-cost-failed:openai-image:1",
        userKey: "failed-cost-user",
        reqId: requestSummaryKey("req-cost-failed"),
        status: "provider_attempt_failed",
        estimatedCostUsd: null,
        finalCostUsd: null,
      }),
    ]);
    expect(JSON.stringify(ledgerEntries)).not.toContain("private prompt");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("closes failed image attempt ledger entries before retrying", async () => {
    configureOpenAiImagesEnv("gpt-image-2");
    process.env.OPENAI_IMAGE_MAX_RETRIES = "1";
    process.env.OPENAI_IMAGE_RETRY_BASE_MS = "1";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "try again" } }), {
          headers: { "content-type": "application/json" },
          status: 500,
          statusText: "Internal Server Error",
        })
      )
      .mockResolvedValueOnce(createGeneratedImageResponse());
    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await generator.generate({
      generationKind: "text_to_image",
      promptHint: "private prompt should not be stored",
      userKey: "retry-cost-user",
      reqId: "req-cost-retry",
    });

    const ledgerEntries = await readCostLedgerPeriod(
      new Date().toISOString().slice(0, 10)
    );
    expect(ledgerEntries).toEqual([
      expect.objectContaining({
        id: "req-cost-retry:openai-image:1",
        userKey: "retry-cost-user",
        reqId: requestSummaryKey("req-cost-retry"),
        status: "provider_attempt_failed",
        estimatedCostUsd: null,
        finalCostUsd: null,
      }),
      expect.objectContaining({
        id: "req-cost-retry:openai-image:2",
        userKey: "retry-cost-user",
        reqId: requestSummaryKey("req-cost-retry"),
        status: "provider_attempt_succeeded",
        estimatedCostUsd: null,
        finalCostUsd: null,
      }),
    ]);
    expect(JSON.stringify(ledgerEntries)).not.toContain("private prompt");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("records source-image request metadata without calculating a price", async () => {
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

    const priceLogs = logSpy.mock.calls
      .map(([payload]) =>
        typeof payload === "string" ? JSON.parse(payload) : payload
      )
      .filter(payload => payload?.event === "image_generation_cost_estimate");
    const ledgerEntries = await readCostLedgerPeriod(
      new Date().toISOString().slice(0, 10)
    );

    expect(priceLogs).toEqual([]);
    expect(ledgerEntries).toEqual([
      expect.objectContaining({
        id: "req-source-edit-cost-estimate:openai-image:1",
        userKey: "source-edit-user",
        reqId: requestSummaryKey("req-source-edit-cost-estimate"),
        providerUsage: {
          generationKind: "source_image_edit",
          hasSourceImage: true,
          size: "1024x1024",
          quality: "medium",
          inputFidelity: "high",
        },
        estimatedCostUsd: null,
        estimatedOutputCostUsd: null,
        costEstimateComplete: false,
        estimateSource: null,
        unpricedCostComponents: ["image_generation"],
      }),
    ]);
    expect(JSON.stringify(ledgerEntries)).not.toContain(
      "make the product shot brighter"
    );
    expect(JSON.stringify(ledgerEntries)).not.toContain("https://");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores removed image-price and global spend settings", async () => {
    configureOpenAiImagesEnv("gpt-image-2");
    process.env.OPENAI_IMAGE_ESTIMATED_COST_USD = "999";
    process.env.MESSENGER_GLOBAL_DAILY_IMAGE_CAP = "1";
    process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD = "0.01";
    process.env.MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD = "0.02";
    process.env.MESSENGER_USER_DAILY_SPEND_CAP_USD = "0.01";
    const fetchMock = vi.fn(async () => createGeneratedImageResponse());
    const onProviderAttempt = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await expect(
      generator.generate({
        userKey: "user-with-customer-quota",
        reqId: "req-no-internal-price-gate",
        onProviderAttempt,
      })
    ).resolves.toBeDefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onProviderAttempt).toHaveBeenCalledOnce();
    expect(
      await readCostLedgerPeriod(new Date().toISOString().slice(0, 10))
    ).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(
          /^req-no-internal-price-gate:openai-image:[0-9a-f-]{36}:1$/i
        ),
        status: "provider_attempt_succeeded",
        estimatedCostUsd: null,
        finalCostUsd: null,
      }),
    ]);
  });

  it("retains legacy owner-bypass metadata for cost observability", async () => {
    configureOpenAiImagesEnv("gpt-image-2");
    process.env.MESSENGER_GLOBAL_DAILY_IMAGE_CAP = "1";
    process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD = "0.01";
    process.env.MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD = "0.01";
    process.env.MESSENGER_USER_DAILY_SPEND_CAP_USD = "0.01";
    const fetchMock = vi.fn(async () => createGeneratedImageResponse());
    const onProviderAttempt = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await expect(
      generator.generate({
        userKey: "owner-user",
        reqId: "req-owner-budget-bypass",
        bypassBudgetLimits: true,
        onProviderAttempt,
      })
    ).resolves.toBeDefined();

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onProviderAttempt).toHaveBeenCalledOnce();
    expect(
      await readCostLedgerPeriod(new Date().toISOString().slice(0, 10))
    ).toEqual([
      expect.objectContaining({
        status: "provider_attempt_succeeded",
        providerUsage: expect.objectContaining({
          budgetBypassApplied: true,
        }),
      }),
    ]);
  });

  it("uses the gpt-image-2 edits endpoint when source image data is provided", async () => {
    configureOpenAiImagesEnv("gpt-image-2");

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(toUrlString(url)).toBe("https://api.openai.com/v1/images/edits");
      expect(new Headers(init?.headers).has("content-type")).toBe(false);
      const body = init?.body as FormData;
      expect(body).toBeInstanceOf(FormData);
      expect(body.get("model")).toBe("gpt-image-2");
      expect(body.get("output_format")).toBe("png");
      expect((body.get("image[]") as File).type).toBe("image/jpeg");

      return createImageApiGeneratedResponse();
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
      expect(prompt).toContain(
        "User request: make it feel like a late-night event poster"
      );
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
