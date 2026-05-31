import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const {
  getRedisClientMock,
  isRedisEnabledMock,
  sendImageMock,
  sendQuickRepliesMock,
  sendTextMock,
  safeLogMock,
} = vi.hoisted(() => ({
  getRedisClientMock: vi.fn(),
  isRedisEnabledMock: vi.fn(() => false),
  sendImageMock: vi.fn(async () => ({ sent: true })),
  sendQuickRepliesMock: vi.fn(async () => ({ sent: true })),
  sendTextMock: vi.fn(async () => ({ sent: true })),
  safeLogMock: vi.fn(),
}));

vi.mock("./_core/messengerApi", () => ({
  sendImage: sendImageMock,
  sendQuickReplies: sendQuickRepliesMock,
  sendText: sendTextMock,
  safeLog: safeLogMock,
}));

vi.mock("./_core/redis", () => ({
  getRedisClient: getRedisClientMock,
  isRedisEnabled: isRedisEnabledMock,
}));

import {
  processFacebookWebhookPayload as processFacebookWebhookPayloadBase,
  processInternalMessengerImageRequest,
  processMessengerGenerationJob,
  resetMessengerEventDedupe,
} from "./_core/messengerWebhook";
import { t } from "./_core/i18n";
import {
  anonymizePsid,
  getState,
  resetStateStore,
  setPendingImage,
  setPendingStoredImage,
  setFlowState,
} from "./_core/messengerState";
import {
  detectAck,
  getEventDedupeKey,
} from "./_core/webhookHelpers";
import { getBotFeatures } from "./_core/bot/features";
import { setSourceImageDnsLookupForTests } from "./_core/image-generation/sourceImageFetcher";
import { processConsentedFacebookWebhookPayload } from "./testConsentHelpers";
import { markMessengerGenerationCompleted } from "./_core/messengerGenerationCompletion";
import { resetMessengerGenerationQueueForTests } from "./_core/messengerGenerationQueue";
import { deleteEphemeralKey, setEphemeralKey } from "./_core/stateStore";

const TEST_PEPPER = "ci-test-pepper";
const originalPrivacyPepper = process.env.PRIVACY_PEPPER;
const originalMessengerGenerationQueueEnabled =
  process.env.MESSENGER_GENERATION_QUEUE_ENABLED;
const originalMessengerGenerationInlineFallback =
  process.env.MESSENGER_GENERATION_INLINE_FALLBACK;

const processFacebookWebhookPayload = processConsentedFacebookWebhookPayload(
  processFacebookWebhookPayloadBase
);

function toUrlString(url: string | URL): string {
  return typeof url === "string" ? url : url.toString();
}

function promptFromOpenAiRequest(init: RequestInit | undefined): string {
  if (typeof init?.body !== "string") {
    return "";
  }
  const payload = JSON.parse(init.body) as {
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

const GENERATED_IMAGE_BASE64 = Buffer.from("fake-png").toString("base64");
const GENERATED_SOURCE_IMAGE_URL_PREFIX =
  "https://leaderbot-fb-image-gen.fly.dev/generated/";
const DEFAULT_ALLOWED_SOURCE_IMAGE_HOSTS =
  "img.example,lookaside.fbsbx.com,leaderbot-fb-image-gen.fly.dev";

function isNormalizedSourceImageUrl(url: string | URL): boolean {
  return toUrlString(url).startsWith(GENERATED_SOURCE_IMAGE_URL_PREFIX);
}

function isSourceImageFetchUrl(
  url: string | URL,
  exactExternalUrl?: string
): boolean {
  const urlString = toUrlString(url);
  if (isNormalizedSourceImageUrl(urlString)) {
    return true;
  }

  if (exactExternalUrl) {
    return urlString === exactExternalUrl;
  }

  return urlString.startsWith("https://img.example/");
}

function installOpenAiSuccessFetchMock() {
  const sourceImage = Buffer.alloc(6000, 7);
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (isSourceImageFetchUrl(url)) {
      return {
        ok: true,
        headers: new Headers({ "content-type": "image/jpeg" }),
        arrayBuffer: async () => sourceImage,
      } as Response;
    }

    return {
      ok: true,
      json: async () => ({ output: [{ type: "image_generation_call", result: GENERATED_IMAGE_BASE64 }] }),
    } as Response;
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function installImageIngressFetchMock() {
  const sourceImage = Buffer.alloc(6000, 7);
  const fetchMock = vi.fn(async (url: string | URL) => {
    if (isSourceImageFetchUrl(url)) {
      return {
        ok: true,
        headers: new Headers({ "content-type": "image/jpeg" }),
        arrayBuffer: async () => sourceImage,
      } as Response;
    }

    throw new Error(`Unexpected fetch in messengerWebhook.test: ${toUrlString(url)}`);
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function sendMessengerPhoto(
  processPayload: typeof processFacebookWebhookPayloadBase,
  psid: string,
  mid: string,
  imageUrl: string
): Promise<void> {
  await processPayload({
    entry: [
      {
        messaging: [
          {
            sender: { id: psid },
            message: {
              mid,
              attachments: [
                {
                  type: "image",
                  payload: { url: imageUrl },
                },
              ],
            },
          },
        ],
      },
    ],
  });
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 1000
): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for test condition");
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

function clearMessengerSendMocks(): void {
  sendImageMock.mockClear();
  sendQuickRepliesMock.mockClear();
  sendTextMock.mockClear();
}

const IN_FLIGHT_NOTICE = "Even geduld, ik ben nog bezig met je afbeelding.";

function inFlightNoticeSendCount(psid: string): number {
  return sendTextMock.mock.calls.filter(
    ([recipient, text]) =>
      recipient === psid &&
      text === IN_FLIGHT_NOTICE
  ).length;
}

function expectFaceMemoryConsentPrompt(psid: string): void {
  expect(sendQuickRepliesMock).toHaveBeenCalledWith(
    psid,
    expect.stringContaining("Mag ik je foto 30 dagen bewaren?"),
    expect.arrayContaining([
      expect.objectContaining({ payload: "CONSENT_FACE_YES" }),
    ])
  );
}

beforeAll(() => {
  process.env.PRIVACY_PEPPER = TEST_PEPPER;
});

afterAll(() => {
  if (originalPrivacyPepper === undefined) {
    delete process.env.PRIVACY_PEPPER;
    return;
  }

  process.env.PRIVACY_PEPPER = originalPrivacyPepper;
});

afterEach(() => {
  vi.unstubAllGlobals();
  setSourceImageDnsLookupForTests(null);
  delete process.env.OPENAI_API_KEY;
  delete process.env.APP_BASE_URL;
  delete process.env.SOURCE_IMAGE_ALLOWED_HOSTS;
  delete process.env.ENABLE_FACE_MEMORY;
  if (originalMessengerGenerationQueueEnabled === undefined) {
    delete process.env.MESSENGER_GENERATION_QUEUE_ENABLED;
  } else {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED =
      originalMessengerGenerationQueueEnabled;
  }
  if (originalMessengerGenerationInlineFallback === undefined) {
    delete process.env.MESSENGER_GENERATION_INLINE_FALLBACK;
  } else {
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK =
      originalMessengerGenerationInlineFallback;
  }
  getRedisClientMock.mockReset();
  isRedisEnabledMock.mockReset();
  isRedisEnabledMock.mockReturnValue(false);
  resetMessengerGenerationQueueForTests();
});

beforeEach(() => {
  setSourceImageDnsLookupForTests(async () => [
    { address: "93.184.216.34", family: 4 },
  ]);
});

describe("messenger webhook dedupe", () => {
  beforeEach(() => {
    delete process.env.MOCK_MODE;
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = DEFAULT_ALLOWED_SOURCE_IMAGE_HOSTS;
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    installImageIngressFetchMock();
    sendImageMock.mockClear();
    sendQuickRepliesMock.mockClear();
    sendTextMock.mockClear();
    safeLogMock.mockClear();
    resetStateStore();
    resetMessengerEventDedupe();
  });

  it("registers built-in bot features", () => {
    expect(getBotFeatures().map(feature => feature.name)).toEqual(
      expect.arrayContaining(["rateLimit", "assistant_commands"])
    );
  });

  it("processes a message.mid only once", async () => {
    const payload = {
      entry: [
        {
          messaging: [
            {
              sender: { id: "psid-123" },
              message: {
                mid: "m_abc123",
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://img.example/a.jpg" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    await processFacebookWebhookPayload(payload);
    await processFacebookWebhookPayload(payload);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sendTextMock).not.toHaveBeenCalled();
    expect(sendQuickRepliesMock).toHaveBeenCalledTimes(1);
  });

  it("throttles repeated in-flight notices while a PROCESSING generation is active", async () => {
    const psid = "active-processing-user";
    const inFlightKey = `messenger:inflight:${psid}`;
    const nowSpy = vi.spyOn(Date, "now");

    await Promise.resolve(setFlowState(psid, "PROCESSING"));
    await setEphemeralKey(inFlightKey, "active", 60);

    try {
      nowSpy.mockReturnValue(1_771_000_000_000);
      await processFacebookWebhookPayload({
        entry: [
          {
            messaging: [
              {
                sender: { id: psid },
                message: { mid: "mid-inflight-first", text: "nog eens" },
              },
            ],
          },
        ],
      });

      expect(inFlightNoticeSendCount(psid)).toBe(1);
      expect(sendTextMock).toHaveBeenLastCalledWith(
        psid,
        IN_FLIGHT_NOTICE
      );

      nowSpy.mockReturnValue(1_771_000_010_000);
      await processFacebookWebhookPayload({
        entry: [
          {
            messaging: [
              {
                sender: { id: psid },
                message: { mid: "mid-inflight-cooldown", text: "nog eens" },
              },
            ],
          },
        ],
      });

      expect(inFlightNoticeSendCount(psid)).toBe(1);

      nowSpy.mockReturnValue(1_771_000_031_000);
      await processFacebookWebhookPayload({
        entry: [
          {
            messaging: [
              {
                sender: { id: psid },
                message: {
                  mid: "mid-inflight-after-cooldown",
                  text: "nog eens",
                },
              },
            ],
          },
        ],
      });

      expect(inFlightNoticeSendCount(psid)).toBe(2);
      expect(sendTextMock).toHaveBeenLastCalledWith(
        psid,
        IN_FLIGHT_NOTICE
      );
    } finally {
      nowSpy.mockRestore();
      await deleteEphemeralKey(inFlightKey);
    }
  });

  it("clears the in-flight notice cooldown when PROCESSING has no active generation", async () => {
    const psid = "processing-cleared-user";
    const inFlightKey = `messenger:inflight:${psid}`;
    const nowSpy = vi.spyOn(Date, "now");

    await Promise.resolve(setFlowState(psid, "PROCESSING"));
    await setEphemeralKey(inFlightKey, "active", 60);

    try {
      nowSpy.mockReturnValue(1_771_000_100_000);
      await processFacebookWebhookPayload({
        entry: [
          {
            messaging: [
              {
                sender: { id: psid },
                message: { mid: "mid-inflight-before-clear", text: "nog eens" },
              },
            ],
          },
        ],
      });

      expect(inFlightNoticeSendCount(psid)).toBe(1);
      expect(sendTextMock).toHaveBeenLastCalledWith(
        psid,
        IN_FLIGHT_NOTICE
      );

      await deleteEphemeralKey(inFlightKey);
      nowSpy.mockReturnValue(1_771_000_110_000);
      await processFacebookWebhookPayload({
        entry: [
          {
            messaging: [
              {
                sender: { id: psid },
                message: { mid: "mid-inflight-clear", text: "status" },
              },
            ],
          },
        ],
      });

      clearMessengerSendMocks();
      await setEphemeralKey(inFlightKey, "active-again", 60);
      nowSpy.mockReturnValue(1_771_000_111_000);
      await processFacebookWebhookPayload({
        entry: [
          {
            messaging: [
              {
                sender: { id: psid },
                message: { mid: "mid-inflight-after-clear", text: "nog eens" },
              },
            ],
          },
        ],
      });

      expect(inFlightNoticeSendCount(psid)).toBe(1);
      expect(sendTextMock).toHaveBeenLastCalledWith(
        psid,
        IN_FLIGHT_NOTICE
      );
    } finally {
      nowSpy.mockRestore();
      await deleteEphemeralKey(inFlightKey);
    }
  });

  it("does not send a duplicate generated image for a completed queued job", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("duplicate job should not call the image provider");
    });
    vi.stubGlobal("fetch", fetchMock);
    await Promise.resolve(
      markMessengerGenerationCompleted(
        "req-completed-job",
        "https://assets.example/generated/completed.jpg",
        "completed-job-user-key",
        1_771_000_000_000
      )
    );

    await processMessengerGenerationJob({
      psid: "completed-job-user",
      userId: "completed-job-user-key",
      style: "disco",
      reqId: "req-completed-job",
      lang: "nl",
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendImageMock).not.toHaveBeenCalled();
    expect(sendTextMock).not.toHaveBeenCalled();
    expect(sendQuickRepliesMock).not.toHaveBeenCalled();
    expect(safeLogMock).toHaveBeenCalledWith(
      "messenger_generation_job_duplicate_completed",
      expect.objectContaining({
        reqId: "req-completed-job",
        style: "disco",
      })
    );
  });

  it("uses sourceImageUrl from internal gateway image requests", async () => {
    const fetchMock = installOpenAiSuccessFetchMock();

    await processInternalMessengerImageRequest({
      psid: "internal-source-user",
      prompt: "Restyle deze foto cinematic",
      reqId: "req-internal-source",
      lang: "nl",
      timestamp: 1_771_000_000_000,
      sourceImageUrl: "https://img.example/source.jpg",
    });

    expect(
      fetchMock.mock.calls.some(
        ([url]) => toUrlString(url) === "https://img.example/source.jpg"
      )
    ).toBe(true);
    expect(sendImageMock).toHaveBeenCalledWith(
      "internal-source-user",
      expect.stringMatching(
        /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.(jpg|png)$/
      )
    );
    expect(getState("internal-source-user")?.lastPhotoSource).toBe("stored");
    expect(safeLogMock).toHaveBeenCalledWith(
      "internal_image_request_received",
      expect.objectContaining({
        reqId: "req-internal-source",
        hasSourceImageUrl: true,
      })
    );
  });

  it("generates a new image from arbitrary text-only internal gateway prompts", async () => {
    const fetchMock = installOpenAiSuccessFetchMock();
    const userPrompt =
      "Maak een futuristische productfoto van een transparante koffiemok op een marmeren tafel";

    await processInternalMessengerImageRequest({
      psid: "internal-text-image-user",
      prompt: userPrompt,
      reqId: "req-internal-text-image",
      lang: "nl",
      timestamp: 1_771_000_000_000,
    });

    const openAiCall = fetchMock.mock.calls.find(
      ([url]) => toUrlString(url) === "https://api.openai.com/v1/responses"
    );
    expect(openAiCall).toBeDefined();
    const prompt = promptFromOpenAiRequest(openAiCall?.[1]);
    expect(prompt).toContain("Create a new image from the user's request.");
    expect(prompt).toContain(userPrompt);
    expect(prompt).not.toContain("storybook");
    expect(sendTextMock).toHaveBeenCalledWith(
      "internal-text-image-user",
      "Ik maak nu je afbeelding."
    );
    expect(sendTextMock).not.toHaveBeenCalledWith(
      "internal-text-image-user",
      expect.stringContaining("Storybook Anime")
    );
    expect(sendImageMock).toHaveBeenCalledWith(
      "internal-text-image-user",
      expect.stringMatching(
        /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.(jpg|png)$/
      )
    );
  });

  it("cleans pasted prompt wrappers before text-to-image generation", async () => {
    const fetchMock = installOpenAiSuccessFetchMock();

    await processInternalMessengerImageRequest({
      psid: "internal-pasted-prompt-user",
      prompt:
        "Gebruik deze prompt en maak een afbeelding: Maak een krachtige samurai poster, geen tekst, geen logo",
      reqId: "req-internal-pasted-prompt",
      lang: "nl",
      timestamp: 1_771_000_000_000,
    });

    const openAiCall = fetchMock.mock.calls.find(
      ([url]) => toUrlString(url) === "https://api.openai.com/v1/responses"
    );
    const prompt = promptFromOpenAiRequest(openAiCall?.[1]);
    expect(prompt).toContain(
      "User request: Maak een krachtige samurai poster, geen tekst, geen logo"
    );
    expect(prompt).not.toContain("Gebruik deze prompt");
  });

  it("uses a retained source photo for natural make-me transformation requests", async () => {
    const fetchMock = installOpenAiSuccessFetchMock();
    await setPendingStoredImage(
      "internal-make-me-source-user",
      "https://img.example/retained-source.jpg"
    );

    await processInternalMessengerImageRequest({
      psid: "internal-make-me-source-user",
      prompt: "Kan je me een samurai maken",
      reqId: "req-internal-make-me-source",
      lang: "nl",
      timestamp: 1_771_000_000_000,
    });

    expect(
      fetchMock.mock.calls.some(
        ([url]) => toUrlString(url) === "https://img.example/retained-source.jpg"
      )
    ).toBe(true);
    expect(sendImageMock).toHaveBeenCalledWith(
      "internal-make-me-source-user",
      expect.stringMatching(
        /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.(jpg|png)$/
      )
    );
  });

  it("keeps make-me generation prompt-first when no source photo exists", async () => {
    const fetchMock = installOpenAiSuccessFetchMock();

    await processInternalMessengerImageRequest({
      psid: "internal-make-me-text-user",
      prompt: "Kan je me een samurai maken",
      reqId: "req-internal-make-me-text",
      lang: "nl",
      timestamp: 1_771_000_000_000,
    });

    const openAiCall = fetchMock.mock.calls.find(
      ([url]) => toUrlString(url) === "https://api.openai.com/v1/responses"
    );
    expect(openAiCall).toBeDefined();
    expect(promptFromOpenAiRequest(openAiCall?.[1])).toContain(
      "Create a new image from the user's request."
    );
    expect(sendTextMock).not.toHaveBeenCalledWith(
      "internal-make-me-text-user",
      "Stuur eerst de foto die je wilt bewerken."
    );
  });

  it("keeps legacy style names inside text-to-image prompts instead of routing through style presets", async () => {
    const fetchMock = installOpenAiSuccessFetchMock();
    const userPrompt = "Maak een storybook anime landschap met mistige bergen";

    await processInternalMessengerImageRequest({
      psid: "internal-style-word-text-image-user",
      prompt: userPrompt,
      reqId: "req-internal-style-word-text-image",
      lang: "nl",
      timestamp: 1_771_000_000_000,
    });

    const openAiCall = fetchMock.mock.calls.find(
      ([url]) => toUrlString(url) === "https://api.openai.com/v1/responses"
    );
    expect(openAiCall).toBeDefined();
    const prompt = promptFromOpenAiRequest(openAiCall?.[1]);
    expect(prompt).toContain("Create a new image from the user's request.");
    expect(prompt).toContain(userPrompt);
    expect(prompt).not.toContain("Transform this photo into a whimsical");
    expect(getState("internal-style-word-text-image-user")?.lastDirectorMode).toBeUndefined();
    expect(safeLogMock).toHaveBeenCalledWith(
      "internal_image_request_received",
      expect.objectContaining({
        reqId: "req-internal-style-word-text-image",
        hasSourceImageUrl: false,
      })
    );
  });

  it("keeps legacy style words inside source-image edit prompts instead of routing through preset restyles", async () => {
    const fetchMock = installOpenAiSuccessFetchMock();
    await setPendingStoredImage(
      "internal-style-word-source-user",
      "https://img.example/retained-source.jpg"
    );
    const userPrompt = "Maak me cyberpunk met neon regen";

    await processInternalMessengerImageRequest({
      psid: "internal-style-word-source-user",
      prompt: userPrompt,
      reqId: "req-internal-style-word-source",
      lang: "nl",
      timestamp: 1_771_000_000_000,
    });

    expect(
      fetchMock.mock.calls.some(
        ([url]) => toUrlString(url) === "https://img.example/retained-source.jpg"
      )
    ).toBe(true);
    const openAiCall = fetchMock.mock.calls.find(
      ([url]) => toUrlString(url) === "https://api.openai.com/v1/responses"
    );
    expect(openAiCall).toBeDefined();
    const prompt = promptFromOpenAiRequest(openAiCall?.[1]);
    expect(prompt).toContain("Edit the uploaded/source image");
    expect(prompt).toContain(userPrompt);
    expect(prompt).not.toContain("Transform this photo into a cyberpunk portrait");
    expect(getState("internal-style-word-source-user")?.lastDirectorMode).toBeUndefined();
    expect(safeLogMock).toHaveBeenCalledWith(
      "internal_image_request_received",
      expect.objectContaining({
        reqId: "req-internal-style-word-source",
        hasSourceImageUrl: false,
      })
    );
  });

  it("keeps explicit restyle requests in the photo flow when no source image exists", async () => {
    installOpenAiSuccessFetchMock();

    await expect(
      processInternalMessengerImageRequest({
        psid: "internal-restyle-without-photo-user",
        prompt: "Restyle deze foto cinematic",
        reqId: "req-internal-restyle-without-photo",
        lang: "nl",
        timestamp: 1_771_000_000_000,
      })
    ).rejects.toThrow("needs a source image");

    expect(sendTextMock).toHaveBeenCalledWith(
      "internal-restyle-without-photo-user",
      "Stuur eerst de foto die je wilt bewerken."
    );
    expect(sendImageMock).not.toHaveBeenCalled();
  });

  it("does not resolve an internal gateway image request until durable enqueue succeeds", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    isRedisEnabledMock.mockReturnValue(true);
    let resolveEnqueue!: () => void;
    const redisState = new Map<string, string>();
    const enqueueStarted = new Promise<void>(resolve => {
      const redis = {
        del: vi.fn(async (key: string) => (redisState.delete(key) ? 1 : 0)),
        get: vi.fn(async (key: string) => redisState.get(key) ?? null),
        llen: vi.fn(async () => 1),
        lpush: vi.fn(
          () =>
            new Promise<number>(innerResolve => {
              resolve();
              resolveEnqueue = () => innerResolve(1);
            })
        ),
        set: vi.fn(async (key: string, value: string) => {
          redisState.set(key, value);
          return "OK";
        }),
      };
      getRedisClientMock.mockResolvedValue(redis);
    });

    let settled = false;
    const requestPromise = processInternalMessengerImageRequest({
      psid: "internal-durable-user",
      prompt: "Restyle deze foto cinematic",
      reqId: "req-internal-durable",
      lang: "nl",
      timestamp: 1_771_000_000_000,
      sourceImageUrl: "https://img.example/durable.jpg",
    }).then(() => {
      settled = true;
    });

    await enqueueStarted;
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(settled).toBe(false);

    resolveEnqueue();
    await requestPromise;

    expect(settled).toBe(true);
    expect(safeLogMock).toHaveBeenCalledWith(
      "messenger_generation_job_queued",
      expect.objectContaining({
        reqId: "req-internal-durable",
        style: undefined,
      })
    );
  });

  it("does not report source-image internal requests as queued when source normalization fails", async () => {
    process.env.MESSENGER_GENERATION_QUEUE_ENABLED = "1";
    process.env.MESSENGER_GENERATION_INLINE_FALLBACK = "0";
    isRedisEnabledMock.mockReturnValue(true);
    const redisState = new Map<string, string>();
    const redis = {
      del: vi.fn(async (key: string) => (redisState.delete(key) ? 1 : 0)),
      get: vi.fn(async (key: string) => redisState.get(key) ?? null),
      llen: vi.fn(async () => 0),
      lpush: vi.fn(async () => 1),
      set: vi.fn(async (key: string, value: string) => {
        redisState.set(key, value);
        return "OK";
      }),
    };
    getRedisClientMock.mockResolvedValue(redis);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const urlString = toUrlString(url);
        if (urlString === "https://img.example/source-normalization-fail.jpg") {
          return {
            ok: false,
            status: 502,
            headers: new Headers({ "content-type": "text/plain" }),
            text: async () => "bad gateway",
          } as Response;
        }

        throw new Error(
          `Unexpected fetch in normalization failure test: ${urlString}`
        );
      })
    );

    await expect(
      processInternalMessengerImageRequest({
        psid: "internal-source-fail-user",
        prompt: "Restyle deze foto cinematic",
        reqId: "req-internal-source-fail",
        lang: "nl",
        timestamp: 1_771_000_000_000,
        sourceImageUrl: "https://img.example/source-normalization-fail.jpg",
      })
    ).rejects.toThrow("source image could not be persisted");

    expect(redis.lpush).not.toHaveBeenCalled();
    expect(safeLogMock).not.toHaveBeenCalledWith(
      "messenger_generation_job_queued",
      expect.anything()
    );
    expect((await Promise.resolve(getState("internal-source-fail-user")))?.stage).toBe(
      "AWAITING_PHOTO"
    );
  });

  it("dedupes on mid before the real message arrives when an echo already used it", async () => {
    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "echo-user" },
              message: {
                mid: "mid-shared",
                is_echo: true,
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://img.example/echo.jpg" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "echo-user" },
              message: {
                mid: "mid-shared",
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://img.example/real.jpg" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(sendQuickRepliesMock).not.toHaveBeenCalled();
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it("falls back to sender+timestamp dedupe when mid is missing", async () => {
    const payload = {
      entry: [
        {
          messaging: [
            {
              sender: { id: "psid-456" },
              timestamp: 1730000000000,
              message: {
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://img.example/b.jpg" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    await processFacebookWebhookPayload(payload);
    await processFacebookWebhookPayload(payload);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not collide fallback keys for different events with identical timestamps", () => {
    const timestamp = 1730000000002;

    const imageEventKey = getEventDedupeKey(
      {
        sender: { id: "psid-same-ts" },
        timestamp,
        message: {
          attachments: [
            { type: "image", payload: { url: "https://img.example/a.jpg" } },
          ],
        },
      },
      "psid-same-ts"
    );

    const textEventKey = getEventDedupeKey(
      {
        sender: { id: "psid-same-ts" },
        timestamp,
        message: {
          text: "hello",
        },
      },
      "psid-same-ts"
    );

    expect(imageEventKey).toBeDefined();
    expect(textEventKey).toBeDefined();
    expect(imageEventKey).not.toBe(textEventKey);
  });

  it("keeps fallback key deterministic for true duplicates without mid", () => {
    const duplicateEvent = {
      sender: { id: "psid-dup-ts" },
      timestamp: 1730000000003,
      postback: { payload: "SOME_ACTION" },
    };

    const first = getEventDedupeKey(duplicateEvent, "psid-dup-ts", "entry-dup");
    const second = getEventDedupeKey(
      duplicateEvent,
      "psid-dup-ts",
      "entry-dup"
    );

    expect(first).toBe(second);
    expect(first).toContain("entry:entry-dup");
    expect(first).toMatch(/postback:[a-f0-9]{12}/);
  });

  it("does not include raw sender id or payload text in fallback key", () => {
    const key = getEventDedupeKey(
      {
        sender: { id: "psid-sensitive" },
        timestamp: 1730000000005,
        postback: { payload: "VERY_SENSITIVE_PAYLOAD" },
        message: {
          quick_reply: { payload: "ANOTHER_SECRET" },
        },
      },
      "anonymized-user-key",
      "entry-sensitive"
    );

    expect(key).toBeDefined();
    expect(key).toContain("entry:entry-sensitive");
    expect(key).toContain("user:anonymized-user-key");
    expect(key).not.toContain("psid-sensitive");
    expect(key).not.toContain("VERY_SENSITIVE_PAYLOAD");
    expect(key).not.toContain("ANOTHER_SECRET");
    expect(key).toMatch(/postback:[a-f0-9]{12}/);
    expect(key).toMatch(/quickReply:[a-f0-9]{12}/);
  });

  it("still blocks duplicate fallback events in replay protection", async () => {
    const duplicatePayload = {
      entry: [
        {
          messaging: [
            {
              sender: { id: "psid-replay" },
              timestamp: 1730000000004,
              message: {
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://img.example/replay.jpg" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    await processFacebookWebhookPayload(duplicatePayload);
    await processFacebookWebhookPayload(duplicatePayload);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("uses entry.id plus timestamp as replay key when mid is missing", async () => {
    const payload = {
      entry: [
        {
          id: "entry-123",
          messaging: [
            {
              sender: { id: "psid-entry-fallback" },
              timestamp: 1730000000001,
              message: {
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://img.example/c.jpg" },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    await processFacebookWebhookPayload(payload);
    await processFacebookWebhookPayload(payload);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(safeLogMock).toHaveBeenCalledWith("webhook_replay_ignored", {
      user: expect.any(String),
      eventId: expect.stringContaining("entry:entry-123:"),
    });
  });

  it("does not emit photo debug logs when debug logging is disabled", async () => {
    const consoleLogSpy = vi
      .spyOn(console, "log")
      .mockImplementation(() => undefined);

    try {
      const expectedPsidHash = anonymizePsid("psid-host-log").slice(0, 12);
      await processFacebookWebhookPayload({
        entry: [
          {
            messaging: [
              {
                sender: { id: "psid-host-log" },
                message: {
                  mid: "mid-host-log",
                  attachments: [
                    {
                      type: "image",
                      payload: {
                        url: "https://lookaside.fbsbx.com/path/to/file.jpg?token=secret",
                      },
                    },
                  ],
                },
              },
            ],
          },
        ],
      });
      const photoReceivedCall = consoleLogSpy.mock.calls
        .map(args => args[0])
        .find(
          value =>
            typeof value === "string" &&
            value.includes('"msg":"photo_received"')
        );

      expect(photoReceivedCall).toBeUndefined();
      expect(expectedPsidHash).toMatch(/[a-f0-9]{12}/);
    } finally {
      consoleLogSpy.mockRestore();
    }
  });

  it("updates lastUserMessageAt only for inbound user messages", async () => {
    const psid = "window-user";
    const userId = anonymizePsid(psid);

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              timestamp: 1730000000000,
              read: { watermark: 1730000000000 },
            },
            {
              sender: { id: psid },
              timestamp: 1730000000001,
              delivery: { mids: ["mid-delivery"] },
            },
          ],
        },
      ],
    });

    expect(getState(userId)?.lastUserMessageAt).toBeUndefined();

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              timestamp: 1730000000123,
              message: { mid: "mid-window-1", text: "Hi" },
            },
          ],
        },
      ],
    });

    expect(getState(userId)?.lastUserMessageAt).toBe(1730000000123);

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              timestamp: 1730000000999,
              message: { mid: "mid-window-echo", is_echo: true, text: "echo" },
            },
          ],
        },
      ],
    });

    expect(getState(userId)?.lastUserMessageAt).toBe(1730000000123);
  });

  it("opens the Messenger response window before a fresh consent prompt", async () => {
    const psid = "fresh-consent-window-user";
    const timestamp = 1730000000456;

    sendQuickRepliesMock.mockImplementationOnce(async () => {
      expect(getState(psid)?.lastUserMessageAt).toBe(timestamp);
      return { sent: true };
    });

    await processFacebookWebhookPayloadBase({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              timestamp,
              message: { mid: "mid-fresh-consent-window", text: "Hi" },
            },
          ],
        },
      ],
    });

    expect(sendQuickRepliesMock).toHaveBeenCalledTimes(1);
    expect(sendTextMock).not.toHaveBeenCalled();
    expect(safeLogMock).not.toHaveBeenCalledWith(
      "messenger_send_skipped",
      expect.objectContaining({ reason: "response_window_closed" })
    );
  });

  it("continues with prompt-first quick start actions after consent is granted", async () => {
    const psid = "fresh-consent-accepted-user";

    await processFacebookWebhookPayloadBase({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              timestamp: 1730000000555,
              message: {
                mid: "mid-fresh-consent-accepted",
                quick_reply: { payload: "GDPR_CONSENT_AGREE" },
              },
            },
          ],
        },
      ],
    });

    expect(getState(psid)?.consentGiven).toBe(true);
    expect(getState(psid)?.stage).toBe("IDLE");
    expect(sendTextMock).toHaveBeenCalledWith(
      psid,
      expect.stringContaining("Je bent klaar")
    );
    expect(sendQuickRepliesMock).toHaveBeenCalledWith(
      psid,
      t("nl", "flowExplanation"),
      [
        {
          content_type: "text",
          title: "Nieuwe afbeelding",
          payload: "OPENCLAW_ACTION:Nieuwe%20afbeelding",
        },
        {
          content_type: "text",
          title: "Pas foto aan",
          payload: "OPENCLAW_ACTION:Pas%20foto%20aan",
        },
        { content_type: "text", title: "Privacy", payload: "OPENCLAW_ACTION:Privacy" },
      ]
    );
    expect(
      sendQuickRepliesMock.mock.calls.some(([, text]) =>
        String(text).toLowerCase().includes("stijl")
      )
    ).toBe(false);
  });

});

describe("messenger deterministic free text", () => {
  beforeEach(() => {
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = DEFAULT_ALLOWED_SOURCE_IMAGE_HOSTS;
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    installImageIngressFetchMock();
    sendImageMock.mockClear();
    sendQuickRepliesMock.mockClear();
    sendTextMock.mockClear();
    safeLogMock.mockClear();
    resetStateStore();
    resetMessengerEventDedupe();
  });

  it("keeps free-text deterministic with an existing photo", async () => {
    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "deterministic-user" },
              message: {
                mid: "mid-deterministic-photo",
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://img.example/deterministic.jpg" },
                  },
                ],
              },
            },
            {
              sender: { id: "deterministic-user" },
              message: {
                mid: "mid-deterministic-text",
                text: "Wat kan ik nu doen?",
              },
            },
          ],
        },
      ],
    });

    expect(sendTextMock).not.toHaveBeenCalledWith(
      "deterministic-user",
      t("nl", "flowExplanation")
    );
    expect(sendQuickRepliesMock).toHaveBeenLastCalledWith(
      "deterministic-user",
      t("nl", "assistantQuickActions"),
      [
        {
          content_type: "text",
          title: "Pas aan",
          payload: "OPENCLAW_ACTION:Pas%20aan",
        },
        {
          content_type: "text",
          title: "Nieuwe afbeelding",
          payload: "OPENCLAW_ACTION:Nieuwe%20afbeelding",
        },
        { content_type: "text", title: "Privacy", payload: "OPENCLAW_ACTION:Privacy" },
      ]
    );
  });

  it("lets typed Messenger replies choose the last quick action", async () => {
    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "typed-action-user" },
              message: {
                mid: "mid-typed-action-photo",
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://img.example/typed-action.jpg" },
                  },
                ],
              },
            },
            {
              sender: { id: "typed-action-user" },
              message: {
                mid: "mid-typed-action-help",
                text: "Wat kan ik nu doen?",
              },
            },
            {
              sender: { id: "typed-action-user" },
              message: {
                mid: "mid-typed-action-choice",
                text: "Nr 1 go",
              },
            },
          ],
        },
      ],
    });

    expect(sendQuickRepliesMock).toHaveBeenCalledWith(
      "typed-action-user",
      t("nl", "assistantQuickActions"),
      expect.arrayContaining([
        expect.objectContaining({
          title: "Pas aan",
          payload: "OPENCLAW_ACTION:Pas%20aan",
        }),
      ])
    );
    expect(sendTextMock).toHaveBeenLastCalledWith(
      "typed-action-user",
      t("nl", "editImagePrompt")
    );
  });

  it("lets typed Messenger replies choose feature-level help actions", async () => {
    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "typed-feature-action-user" },
              message: {
                mid: "mid-typed-feature-action-photo",
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://img.example/typed-feature-action.jpg" },
                  },
                ],
              },
            },
            {
              sender: { id: "typed-feature-action-user" },
              message: {
                mid: "mid-typed-feature-action-help",
                text: "help",
              },
            },
            {
              sender: { id: "typed-feature-action-user" },
              message: {
                mid: "mid-typed-feature-action-choice",
                text: "Nr 1 go",
              },
            },
          ],
        },
      ],
    });

    expect(sendQuickRepliesMock).toHaveBeenCalledWith(
      "typed-feature-action-user",
      t("nl", "assistantQuickActions"),
      expect.arrayContaining([
        expect.objectContaining({
          title: "Pas aan",
          payload: "OPENCLAW_ACTION:Pas%20aan",
        }),
      ])
    );
    expect(sendTextMock).toHaveBeenLastCalledWith(
      "typed-feature-action-user",
      t("nl", "editImagePrompt")
    );
  });

  it("lets Messenger reply-to choose actions from the referenced quick-reply message", async () => {
    sendQuickRepliesMock
      .mockImplementationOnce(async () => ({
        sent: true,
        messageId: "mid-quickstart-actions",
      }))
      .mockImplementationOnce(async () => ({
        sent: true,
        messageId: "mid-photo-received-actions",
      }))
      .mockImplementationOnce(async () => ({
        sent: true,
        messageId: "mid-photo-help-actions",
      }));

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "reply-action-user" },
              message: {
                mid: "mid-reply-action-hi",
                text: "Hi",
              },
            },
            {
              sender: { id: "reply-action-user" },
              message: {
                mid: "mid-reply-action-photo",
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://img.example/reply-action.jpg" },
                  },
                ],
              },
            },
            {
              sender: { id: "reply-action-user" },
              message: {
                mid: "mid-reply-action-help",
                text: "Wat kan ik nu doen?",
              },
            },
            {
              sender: { id: "reply-action-user" },
              message: {
                mid: "mid-reply-action-choice",
                text: "Nr 1 go",
                reply_to: { mid: "mid-quickstart-actions" },
              },
            },
          ],
        },
      ],
    });

    expect(sendTextMock).toHaveBeenLastCalledWith(
      "reply-action-user",
      t("nl", "textWithoutPhoto")
    );
    expect(getState(anonymizePsid("reply-action-user"))?.lastPhotoUrl).toBeNull();
  });

  it("generates direct Messenger text image requests prompt-first", async () => {
    const fetchMock = installOpenAiSuccessFetchMock();

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "direct-text-image-user" },
              message: {
                mid: "mid-direct-text-image",
                text: "Kan je een landschap afbeelding genereren?",
              },
            },
          ],
        },
      ],
    });

    const openAiCall = fetchMock.mock.calls.find(
      ([url]) => toUrlString(url) === "https://api.openai.com/v1/responses"
    );
    expect(openAiCall).toBeDefined();
    expect(promptFromOpenAiRequest(openAiCall?.[1])).toContain(
      "User request: Kan je een landschap afbeelding genereren?"
    );
    expect(sendTextMock).toHaveBeenCalledWith(
      "direct-text-image-user",
      t("nl", "generatingImagePrompt")
    );
    expect(sendImageMock).toHaveBeenCalledWith(
      "direct-text-image-user",
      expect.stringMatching(
        /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.(jpg|png)$/
      )
    );
  });

  it("generates arbitrary Messenger create requests prompt-first", async () => {
    const fetchMock = installOpenAiSuccessFetchMock();

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "arbitrary-text-image-user" },
              message: {
                mid: "mid-arbitrary-text-image",
                text: "Maak een draak met neonvleugels boven Antwerpen",
              },
            },
          ],
        },
      ],
    });

    const openAiCall = fetchMock.mock.calls.find(
      ([url]) => toUrlString(url) === "https://api.openai.com/v1/responses"
    );
    expect(openAiCall).toBeDefined();
    expect(promptFromOpenAiRequest(openAiCall?.[1])).toContain(
      "User request: Maak een draak met neonvleugels boven Antwerpen"
    );
    expect(sendImageMock).toHaveBeenCalledWith(
      "arbitrary-text-image-user",
      expect.stringMatching(
        /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.(jpg|png)$/
      )
    );
  });

  it("keeps free-text deterministic without a photo and does not call fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "deterministic-no-photo-user" },
              message: { mid: "mid-deterministic-no-photo", text: "Wie ben jij?" },
            },
          ],
        },
      ],
    });

    expect(sendQuickRepliesMock).toHaveBeenLastCalledWith(
      "deterministic-no-photo-user",
      t("nl", "flowExplanation"),
      [
        {
          content_type: "text",
          title: "Nieuwe afbeelding",
          payload: "OPENCLAW_ACTION:Nieuwe%20afbeelding",
        },
        {
          content_type: "text",
          title: "Pas foto aan",
          payload: "OPENCLAW_ACTION:Pas%20foto%20aan",
        },
        { content_type: "text", title: "Privacy", payload: "OPENCLAW_ACTION:Privacy" },
      ]
    );
    expect(getState(anonymizePsid("deterministic-no-photo-user"))?.stage).toBe(
      "IDLE"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

});

describe("messenger greeting behavior", () => {
  beforeEach(() => {
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = DEFAULT_ALLOWED_SOURCE_IMAGE_HOSTS;
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    installImageIngressFetchMock();
    sendImageMock.mockClear();
    sendQuickRepliesMock.mockClear();
    sendTextMock.mockClear();
    safeLogMock.mockClear();
    resetStateStore();
    resetMessengerEventDedupe();
  });

  it("shows welcome quick start in IDLE", async () => {
    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "idle-user" },
              message: { mid: "mid-idle-1", text: "Hi" },
            },
          ],
        },
      ],
    });

    expect(sendTextMock).not.toHaveBeenCalled();
    expect(sendQuickRepliesMock).toHaveBeenCalledWith(
      "idle-user",
      t("nl", "flowExplanation"),
      expect.arrayContaining([
        {
          content_type: "text",
          title: "Nieuwe afbeelding",
          payload: "OPENCLAW_ACTION:Nieuwe%20afbeelding",
        },
        {
          content_type: "text",
          title: "Pas foto aan",
          payload: "OPENCLAW_ACTION:Pas%20foto%20aan",
        },
        { content_type: "text", title: "Privacy", payload: "OPENCLAW_ACTION:Privacy" },
      ])
    );
  });

  it("routes conversation action clicks back through normal text handling", async () => {
    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "action-input-user" },
              message: {
                mid: "mid-action-input-1",
                quick_reply: {
                  payload: "OPENCLAW_ACTION:Nieuwe%20afbeelding",
                },
              },
            },
          ],
        },
      ],
    });

    expect(sendQuickRepliesMock).not.toHaveBeenCalled();
    expect(sendTextMock).toHaveBeenCalledWith(
      "action-input-user",
      t("nl", "textWithoutPhoto")
    );
  });

  it("routes quick-start action clicks back through normal help text handling", async () => {
    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "quick-start-action-user", locale: "nl_BE" },
              timestamp: 1,
              message: {
                mid: "mid-quick-start-action",
                quick_reply: {
                  payload: "OPENCLAW_ACTION:Nieuwe%20afbeelding",
                },
              },
            },
          ],
        },
      ],
    });

    expect(sendTextMock).toHaveBeenCalledWith(
      "quick-start-action-user",
      t("nl", "textWithoutPhoto")
    );
  });

  it("offers follow-up quick actions when state is RESULT_READY", async () => {
    const psid = "result-user";
    const userId = anonymizePsid(psid);
    setFlowState(userId, "RESULT_READY");

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              message: { mid: "mid-result-1", text: "Hey" },
            },
          ],
        },
      ],
    });

    expect(sendQuickRepliesMock).toHaveBeenCalledWith(psid, "Klaar.", [
      {
        content_type: "text",
        title: "Nieuwe afbeelding",
        payload: "OPENCLAW_ACTION:Nieuwe%20afbeelding",
      },
      {
        content_type: "text",
        title: "Pas aan",
        payload: "OPENCLAW_ACTION:Pas%20aan",
      },
      { content_type: "text", title: "Privacy", payload: "OPENCLAW_ACTION:Privacy" },
    ]);
  });

  it("starts a fresh prompt-first flow when the new-image action is clicked", async () => {
    const psid = "new-image-action-user";
    const userId = anonymizePsid(psid);
    setPendingImage(userId, "https://img.example/old.jpg");
    sendTextMock.mockClear();

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              message: {
                mid: "mid-new-image-action",
                quick_reply: { payload: "OPENCLAW_ACTION:Nieuwe%20afbeelding" },
              },
            },
          ],
        },
      ],
    });

    const state = getState(userId);
    expect(state?.lastPhotoUrl).toBeNull();
    expect(state?.stage).toBe("IDLE");
    expect(sendTextMock).toHaveBeenCalledWith(psid, t("nl", "textWithoutPhoto"));
  });

  it("offers retry actions when state is FAILURE", async () => {
    const psid = "failure-user";
    const userId = anonymizePsid(psid);
    setFlowState(userId, "FAILURE");

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              message: { mid: "mid-failure-1", text: "Hey" },
            },
          ],
        },
      ],
    });

    expect(sendQuickRepliesMock).toHaveBeenCalledWith(
      psid,
      "Oeps. Probeer opnieuw of beschrijf een nieuwe afbeelding.",
      [
        {
          content_type: "text",
          title: "Nieuwe afbeelding",
          payload: "OPENCLAW_ACTION:Nieuwe%20afbeelding",
        },
      ]
    );
  });
});

describe("acknowledgement edgecases", () => {
  beforeEach(() => {
    sendImageMock.mockClear();
    sendQuickRepliesMock.mockClear();
    sendTextMock.mockClear();
    safeLogMock.mockClear();
    resetStateStore();
    resetMessengerEventDedupe();
  });

  it("detects legacy like, short acknowledgements, and emoji", () => {
    expect(detectAck("(y)")).toBe("like");
    expect(detectAck("  jep ")).toBe("ok");
    expect(detectAck("Merci")).toBe("thanks");
    expect(detectAck("👍")).toBe("emoji");
    expect(detectAck("   ")).toBeNull();
    expect(detectAck("disco")).toBeNull();
  });

  it("ignores (y) without sending text or quick replies", async () => {
    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "ack-like-user" },
              message: { mid: "mid-ack-like", text: "(y)" },
            },
          ],
        },
      ],
    });

    expect(sendTextMock).not.toHaveBeenCalled();
    expect(sendQuickRepliesMock).not.toHaveBeenCalled();
    expect(safeLogMock).toHaveBeenCalledWith("ack_ignored", { ack: "like" });
  });

  it("ignores 👍 without sending text or quick replies", async () => {
    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "ack-emoji-user" },
              message: { mid: "mid-ack-emoji", text: "👍" },
            },
          ],
        },
      ],
    });

    expect(sendTextMock).not.toHaveBeenCalled();
    expect(sendQuickRepliesMock).not.toHaveBeenCalled();
    expect(safeLogMock).toHaveBeenCalledWith("ack_ignored", { ack: "emoji" });
  });
});

describe("bot rate limit feature", () => {
  beforeEach(() => {
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = DEFAULT_ALLOWED_SOURCE_IMAGE_HOSTS;
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    installImageIngressFetchMock();
    sendImageMock.mockClear();
    sendQuickRepliesMock.mockClear();
    sendTextMock.mockClear();
    safeLogMock.mockClear();
    resetStateStore();
    resetMessengerEventDedupe();
  });

  it("blocks text spam after the configured in-memory threshold", async () => {
    const senderId = "rate-limit-user";

    for (let index = 0; index < 11; index += 1) {
      await processFacebookWebhookPayload({
        entry: [
          {
            messaging: [
              {
                sender: { id: senderId },
                message: { mid: `mid-rate-${index}`, text: `random-${index}` },
              },
            ],
          },
        ],
      });
    }

    expect(sendTextMock).toHaveBeenLastCalledWith(
      senderId,
      "⏳ Slow down a bit."
    );
  });
});

describe("disabled bot features stay out of the runtime flow", () => {
  beforeEach(() => {
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = DEFAULT_ALLOWED_SOURCE_IMAGE_HOSTS;
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    installImageIngressFetchMock();
    sendImageMock.mockClear();
    sendQuickRepliesMock.mockClear();
    sendTextMock.mockClear();
    safeLogMock.mockClear();
    resetStateStore();
    resetMessengerEventDedupe();
  });

  it("does not treat free text as a conversational edit after a generation", async () => {
    installOpenAiSuccessFetchMock();

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "edit-text-user" },
              message: {
                mid: "mid-edit-photo",
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://img.example/source.jpg" },
                  },
                ],
              },
            },
            {
              sender: { id: "edit-text-user" },
              message: {
                mid: "mid-edit-style",
                quick_reply: { payload: "disco" },
              },
            },
          ],
        },
      ],
    });

    sendImageMock.mockClear();
    sendQuickRepliesMock.mockClear();
    sendTextMock.mockClear();

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "edit-text-user" },
              message: {
                mid: "mid-edit-command",
                text: "make it darker and more gold",
              },
            },
          ],
        },
      ],
    });

    expect(sendTextMock).not.toHaveBeenCalledWith(
      "edit-text-user",
      t("nl", "flowExplanation")
    );
    expect(sendQuickRepliesMock).toHaveBeenCalledWith(
      "edit-text-user",
      t("nl", "assistantQuickActions"),
      expect.arrayContaining([
        {
          content_type: "text",
          title: "Pas aan",
          payload: "OPENCLAW_ACTION:Pas%20aan",
        },
      ])
    );
    expect(sendImageMock).not.toHaveBeenCalled();
  });

  it("turns surprise with a photo into explicit choices instead of auto-running", async () => {
    installOpenAiSuccessFetchMock();

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "surprise-style-user" },
              message: {
                mid: "mid-surprise-photo",
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://img.example/source.jpg" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    sendImageMock.mockClear();
    sendQuickRepliesMock.mockClear();
    sendTextMock.mockClear();

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "surprise-style-user" },
              message: {
                mid: "mid-surprise-command",
                text: "surprise me",
              },
            },
          ],
        },
      ],
    });

    expect(sendTextMock).not.toHaveBeenCalled();
    expect(sendImageMock).not.toHaveBeenCalled();
    expect(sendQuickRepliesMock).toHaveBeenCalledWith(
      "surprise-style-user",
      t("nl", "assistantQuickActions"),
      [
        {
          content_type: "text",
          title: "Pas aan",
          payload: "OPENCLAW_ACTION:Pas%20aan",
        },
        {
          content_type: "text",
          title: "Nieuwe afbeelding",
          payload: "OPENCLAW_ACTION:Nieuwe%20afbeelding",
        },
        {
          content_type: "text",
          title: "Privacy",
          payload: "OPENCLAW_ACTION:Privacy",
        },
      ]
    );
  });






});

