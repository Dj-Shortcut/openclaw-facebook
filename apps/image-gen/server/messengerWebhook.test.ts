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
  sendGenericTemplateMock,
  sendImageMock,
  sendQuickRepliesMock,
  sendTextMock,
  safeLogMock,
} = vi.hoisted(() => ({
  sendGenericTemplateMock: vi.fn(async () => ({ sent: true })),
  sendImageMock: vi.fn(async () => ({ sent: true })),
  sendQuickRepliesMock: vi.fn(async () => ({ sent: true })),
  sendTextMock: vi.fn(async () => ({ sent: true })),
  safeLogMock: vi.fn(),
}));

vi.mock("./_core/messengerApi", () => ({
  sendGenericTemplate: sendGenericTemplateMock,
  sendImage: sendImageMock,
  sendQuickReplies: sendQuickRepliesMock,
  sendText: sendTextMock,
  safeLog: safeLogMock,
}));

import {
  processFacebookWebhookPayload as processFacebookWebhookPayloadBase,
  resetMessengerEventDedupe,
} from "./_core/messengerWebhook";
import { t } from "./_core/i18n";
import {
  STYLE_CATEGORY_CONFIGS,
  getStylesForCategory,
} from "./_core/messengerStyles";
import {
  anonymizePsid,
  getState,
  resetStateStore,
  setPendingImage,
  setPreselectedStyle,
  setFlowState,
} from "./_core/messengerState";
import {
  detectAck,
  getEventDedupeKey,
} from "./_core/webhookHelpers";
import { getBotFeatures } from "./_core/bot/features";
import { setSourceImageDnsLookupForTests } from "./_core/image-generation/sourceImageFetcher";
import { processConsentedFacebookWebhookPayload } from "./testConsentHelpers";

const TEST_PEPPER = "ci-test-pepper";
const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

const processFacebookWebhookPayload = processConsentedFacebookWebhookPayload(
  processFacebookWebhookPayloadBase
);

function toUrlString(url: string | URL): string {
  return typeof url === "string" ? url : url.toString();
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
  const fetchMock = vi.fn(async (url: string | URL) => {
    if (isSourceImageFetchUrl(url)) {
      return {
        ok: true,
        headers: new Headers({ "content-type": "image/jpeg" }),
        arrayBuffer: async () => sourceImage,
      } as Response;
    }

    return {
      ok: true,
      json: async () => ({ data: [{ b64_json: GENERATED_IMAGE_BASE64 }] }),
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

async function sendMessengerQuickReply(
  processPayload: typeof processFacebookWebhookPayloadBase,
  psid: string,
  mid: string,
  payload: string
): Promise<void> {
  await processPayload({
    entry: [
      {
        messaging: [
          {
            sender: { id: psid },
            message: {
              mid,
              quick_reply: { payload },
            },
          },
        ],
      },
    ],
  });
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

function clearMessengerSendMocks(): void {
  sendImageMock.mockClear();
  sendQuickRepliesMock.mockClear();
  sendTextMock.mockClear();
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
    sendGenericTemplateMock.mockClear();
    sendQuickRepliesMock.mockClear();
    sendTextMock.mockClear();
    safeLogMock.mockClear();
    resetStateStore();
    resetMessengerEventDedupe();
  });

  it("registers built-in bot features", () => {
    expect(getBotFeatures().map(feature => feature.name)).toEqual(
      expect.arrayContaining(["rateLimit", "styleCommands"])
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

    expect(sendQuickRepliesMock).toHaveBeenCalledTimes(1);
    expect(sendTextMock).not.toHaveBeenCalled();
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

    expect(sendQuickRepliesMock).toHaveBeenCalledTimes(1);
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
      postback: { payload: "STYLE_DISCO" },
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

    expect(sendQuickRepliesMock).toHaveBeenCalledTimes(1);
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

    expect(sendQuickRepliesMock).toHaveBeenCalledTimes(1);
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

  it("continues with restyle starter pills after consent is granted", async () => {
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
    expect(getState(psid)?.stage).toBe("AWAITING_STYLE");
    expect(sendTextMock).toHaveBeenCalledWith(
      psid,
      expect.stringContaining("Je bent klaar")
    );
    expect(sendQuickRepliesMock).toHaveBeenCalledWith(
      psid,
      t("nl", "styleCategoryPicker"),
      expect.arrayContaining([
        expect.objectContaining({ payload: "STYLE_CATEGORY_ILLUSTRATED" }),
        expect.objectContaining({ payload: "STYLE_CATEGORY_ATMOSPHERE" }),
        expect.objectContaining({ payload: "STYLE_CATEGORY_BOLD" }),
      ])
    );
    expect(sendQuickRepliesMock).not.toHaveBeenCalledWith(
      psid,
      expect.stringContaining("Je bent klaar"),
      expect.any(Array)
    );
  });

  it("opens the Messenger response window before postback routing", async () => {
    const psid = "fresh-postback-window-user";
    const timestamp = 1730000000789;

    sendTextMock.mockImplementationOnce(async () => {
      expect(getState(psid)?.lastUserMessageAt).toBe(timestamp);
      return { sent: true };
    });

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              timestamp,
              postback: { payload: "STYLE_CATEGORY_ILLUSTRATED" },
            },
          ],
        },
      ],
    });

    expect(sendTextMock).toHaveBeenCalledTimes(1);
    expect(sendGenericTemplateMock).toHaveBeenCalledTimes(1);
  });

  it("returns generated images for all canonical styles through the OpenAI path", async () => {
    const styles = STYLE_CATEGORY_CONFIGS.flatMap(category =>
      getStylesForCategory(category.category).map(style => style.style)
    );

    for (const style of styles) {
      const fetchMock = installOpenAiSuccessFetchMock();
      sendImageMock.mockClear();
      sendQuickRepliesMock.mockClear();
      sendTextMock.mockClear();
      resetStateStore();
      resetMessengerEventDedupe();

      await processFacebookWebhookPayload({
        entry: [
          {
            messaging: [
              {
                sender: { id: `style-user-${style}` },
                message: {
                  mid: `mid-photo-${style}`,
                  attachments: [
                    {
                      type: "image",
                      payload: { url: "https://img.example/source.jpg" },
                    },
                  ],
                },
              },
              {
                sender: { id: `style-user-${style}` },
                message: {
                  mid: `mid-style-${style}`,
                  quick_reply: { payload: style },
                },
              },
            ],
          },
        ],
      });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(sendImageMock).toHaveBeenCalledWith(
        `style-user-${style}`,
        expect.stringMatching(
          /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.jpg$/
        )
      );
    }
  });

  it("uses canonical quick-reply payload and APP_BASE_URL for image attachments", async () => {
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    installOpenAiSuccessFetchMock();

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "canonical-payload-user" },
              message: {
                mid: "mid-photo-canonical",
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://img.example/source.jpg" },
                  },
                ],
              },
            },
            {
              sender: { id: "canonical-payload-user" },
              message: {
                mid: "mid-style-canonical",
                quick_reply: { payload: "disco" },
              },
            },
          ],
        },
      ],
    });

    expect(sendImageMock).toHaveBeenCalledWith(
      "canonical-payload-user",
      expect.stringMatching(
        /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.jpg$/
      )
    );
  });

  it("routes STYLE_NORMAN_BLACKWELL quick replies through the same payload flow", async () => {
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";

    const sourceImage = Buffer.alloc(6000, 7);
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (isSourceImageFetchUrl(url)) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "image/jpeg" }),
          arrayBuffer: async () => sourceImage,
        } as Response;
      }

      const formData = init?.body as FormData;
      const prompt = String(formData.get("prompt"));
      expect(prompt).toContain(
        "Reimagine this photo as a nostalgic mid-century American editorial illustration"
      );
      expect(prompt).toContain("warm storybook lighting");
      expect(prompt).toContain(
        "all-American palette of cream, brick red, muted teal, and honey gold"
      );

      return {
        ok: true,
        json: async () => ({ data: [{ b64_json: GENERATED_IMAGE_BASE64 }] }),
      } as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "norman-payload-user" },
              message: {
                mid: "mid-photo-norman-payload",
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://img.example/source.jpg" },
                  },
                ],
              },
            },
            {
              sender: { id: "norman-payload-user" },
              message: {
                mid: "mid-style-norman-payload",
                quick_reply: { payload: "STYLE_NORMAN_BLACKWELL" },
              },
            },
          ],
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sendImageMock).toHaveBeenCalledWith(
      "norman-payload-user",
      expect.stringMatching(
        /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.jpg$/
      )
    );
    expect(getState(anonymizePsid("norman-payload-user"))?.selectedStyle).toBe(
      "norman-blackwell"
    );
  });

  it("returns a generated image attachment and follow-up after style selection", async () => {
    installOpenAiSuccessFetchMock();

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "mock-image-user" },
              message: {
                mid: "mid-photo-1",
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://img.example/source.jpg" },
                  },
                ],
              },
            },
            {
              sender: { id: "mock-image-user" },
              message: {
                mid: "mid-style-1",
                quick_reply: { payload: "disco" },
              },
            },
          ],
        },
      ],
    });

    expect(sendImageMock).toHaveBeenCalledWith(
      "mock-image-user",
      expect.stringMatching(
        /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.jpg$/
      )
    );
    expect(sendQuickRepliesMock).toHaveBeenLastCalledWith(
      "mock-image-user",
      "Klaar ✅",
      [
        {
          content_type: "text",
          title: "Nieuwe stijl",
          payload: "CHOOSE_STYLE",
        },
        { content_type: "text", title: "Privacy", payload: "PRIVACY_INFO" },
      ]
    );
  });

  it("shows friendly message when OPENAI_API_KEY is missing", async () => {
    delete process.env.OPENAI_API_KEY;

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "openai-missing-key-user" },
              message: {
                mid: "mid-photo-openai-missing",
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://img.example/source.jpg" },
                  },
                ],
              },
            },
            {
              sender: { id: "openai-missing-key-user" },
              message: {
                mid: "mid-style-openai-missing",
                quick_reply: { payload: "disco" },
              },
            },
          ],
        },
      ],
    });

    expect(sendQuickRepliesMock).toHaveBeenLastCalledWith(
      "openai-missing-key-user",
      "AI generation isn’t enabled yet.",
      [
        {
          content_type: "text",
          title: "Opnieuw",
          payload: "RETRY_STYLE_disco",
        },
        { content_type: "text", title: "Andere", payload: "CHOOSE_STYLE" },
      ]
    );
    expect(sendImageMock).not.toHaveBeenCalled();
    expect(sendTextMock).toHaveBeenCalledTimes(2);
    expect(sendTextMock).toHaveBeenNthCalledWith(
      1,
      "openai-missing-key-user",
      "Ik maak nu je Disco-stijl."
    );
    expect(sendTextMock).toHaveBeenNthCalledWith(
      2,
      "openai-missing-key-user",
      "Oeps. Probeer nog een stijl."
    );
  });

  it("reaches OpenAI generator path with API key", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";

    const sourceImage = Buffer.alloc(6000, 7);
    const generatedImageBytes = Buffer.from("fake-png").toString("base64");
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (isSourceImageFetchUrl(url, "https://img.example/source.jpg")) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "image/jpeg" }),
          arrayBuffer: async () => sourceImage,
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({ data: [{ b64_json: generatedImageBytes }] }),
      } as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    try {
      await processFacebookWebhookPayload({
        entry: [
          {
            messaging: [
              {
                sender: { id: "openai-success-user" },
                message: {
                  mid: "mid-photo-openai-success",
                  attachments: [
                    {
                      type: "image",
                      payload: { url: "https://img.example/source.jpg" },
                    },
                  ],
                },
              },
              {
                sender: { id: "openai-success-user" },
                message: {
                  mid: "mid-style-openai-success",
                  quick_reply: { payload: "gold" },
                },
              },
            ],
          },
        ],
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(sendImageMock).toHaveBeenCalledWith(
      "openai-success-user",
      expect.stringMatching(
        /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.jpg$/
      )
    );
  });

  it("keeps failure context and retries selected style with prior photo", async () => {
    delete process.env.OPENAI_API_KEY;

    const psid = "retry-failure-user";
    const userId = anonymizePsid(psid);

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              message: {
                mid: "mid-photo-retry-failure",
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://img.example/retry.jpg" },
                  },
                ],
              },
            },
            {
              sender: { id: psid },
              message: {
                mid: "mid-style-retry-failure",
                quick_reply: { payload: "gold" },
              },
            },
          ],
        },
      ],
    });

    const failedState = getState(userId);
    expect(failedState?.stage).toBe("FAILURE");
    expect(failedState?.lastPhoto).toMatch(
      /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.jpg$/
    );
    expect(failedState?.lastPhotoSource).toBe("stored");
    expect(failedState?.selectedStyle).toBe("gold");

    sendTextMock.mockClear();
    sendQuickRepliesMock.mockClear();

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              postback: { payload: "RETRY_STYLE_gold" },
            },
          ],
        },
      ],
    });

    const retriedState = getState(userId);
    expect(retriedState?.stage).toBe("FAILURE");
    expect(retriedState?.lastPhoto).toMatch(
      /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.jpg$/
    );
    expect(retriedState?.lastPhotoSource).toBe("stored");
    expect(retriedState?.selectedStyle).toBe("gold");
    expect(sendQuickRepliesMock).not.toHaveBeenCalledWith(
      psid,
      "What style should I use?",
      expect.anything()
    );
    expect(sendQuickRepliesMock).not.toHaveBeenCalledWith(
      psid,
      "Pick a style using the buttons below 🙂",
      expect.anything()
    );
    expect(sendQuickRepliesMock).toHaveBeenCalledWith(
      psid,
      "AI generation isn’t enabled yet.",
      [
        { content_type: "text", title: "Opnieuw", payload: "RETRY_STYLE_gold" },
        { content_type: "text", title: "Andere", payload: "CHOOSE_STYLE" },
      ]
    );
  });
  it("shows timeout message when OpenAI generation exceeds timeout", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";

    const timeoutError = new Error("aborted");
    timeoutError.name = "AbortError";
    const sourceImage = Buffer.alloc(6000, 7);
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (isSourceImageFetchUrl(url, "https://img.example/source.jpg")) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "image/jpeg" }),
          arrayBuffer: async () => sourceImage,
        } as Response;
      }

      throw timeoutError;
    });

    vi.stubGlobal("fetch", fetchMock);

    try {
      await processFacebookWebhookPayload({
        entry: [
          {
            messaging: [
              {
                sender: { id: "openai-timeout-user" },
                message: {
                  mid: "mid-photo-openai-timeout",
                  attachments: [
                    {
                      type: "image",
                      payload: { url: "https://img.example/source.jpg" },
                    },
                  ],
                },
              },
              {
                sender: { id: "openai-timeout-user" },
                message: {
                  mid: "mid-style-openai-timeout",
                  quick_reply: { payload: "clouds" },
                },
              },
            ],
          },
        ],
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(sendQuickRepliesMock).toHaveBeenLastCalledWith(
      "openai-timeout-user",
      "This took too long.",
      [
        {
          content_type: "text",
          title: "Opnieuw",
          payload: "RETRY_STYLE_clouds",
        },
        { content_type: "text", title: "Andere", payload: "CHOOSE_STYLE" },
      ]
    );
  });

  it("style click during generation does not start a second run", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";

    let resolveFetch:
      | ((value: {
          ok: boolean;
          json: () => Promise<{ data: Array<{ b64_json: string }> }>;
        }) => void)
      | undefined;
    const sourceImage = Buffer.alloc(6000, 7);
    const fetchMock = vi.fn((url: string | URL) => {
      if (isSourceImageFetchUrl(url, "https://img.example/source.jpg")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "image/jpeg" }),
          arrayBuffer: async () => sourceImage,
        } as Response);
      }

      return new Promise<{
        ok: boolean;
        json: () => Promise<{ data: Array<{ b64_json: string }> }>;
      }>(resolve => {
        resolveFetch = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      await processFacebookWebhookPayload({
        entry: [
          {
            messaging: [
              {
                sender: { id: "busy-user" },
                message: {
                  mid: "mid-photo-busy",
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

      const firstRun = processFacebookWebhookPayload({
        entry: [
          {
            messaging: [
              {
                sender: { id: "busy-user" },
                message: {
                  mid: "mid-style-busy-1",
                  quick_reply: { payload: "disco" },
                },
              },
            ],
          },
        ],
      });

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(resolveFetch).toBeTypeOf("function");
      });

      sendImageMock.mockClear();
      sendQuickRepliesMock.mockClear();
      sendTextMock.mockClear();
      safeLogMock.mockClear();

      await processFacebookWebhookPayload({
        entry: [
          {
            messaging: [
              {
                sender: { id: "busy-user" },
                message: {
                  mid: "mid-style-busy-2",
                  quick_reply: { payload: "gold" },
                },
              },
            ],
          },
        ],
      });

      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(sendTextMock).toHaveBeenCalledWith(
        "busy-user",
        "⏳ even geduld, ik ben nog bezig met jouw restyle"
      );

      const generatedImageBytes = Buffer.from("fake-png").toString("base64");
      resolveFetch?.({
        ok: true,
        json: async () => ({ data: [{ b64_json: generatedImageBytes }] }),
      });
      await firstRun;
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns only in-progress status message for style changes while generating", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";

    let resolveFetch:
      | ((value: {
          ok: boolean;
          json: () => Promise<{ data: Array<{ b64_json: string }> }>;
        }) => void)
      | undefined;
    const sourceImage = Buffer.alloc(6000, 7);
    const fetchMock = vi.fn((url: string | URL) => {
      if (isSourceImageFetchUrl(url, "https://img.example/source.jpg")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "image/jpeg" }),
          arrayBuffer: async () => sourceImage,
        } as Response);
      }

      return new Promise<{
        ok: boolean;
        json: () => Promise<{ data: Array<{ b64_json: string }> }>;
      }>(resolve => {
        resolveFetch = resolve;
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      await processFacebookWebhookPayload({
        entry: [
          {
            messaging: [
              {
                sender: { id: "busy-user-text" },
                message: {
                  mid: "mid-photo-busy-text",
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

      const firstRun = processFacebookWebhookPayload({
        entry: [
          {
            messaging: [
              {
                sender: { id: "busy-user-text" },
                message: {
                  mid: "mid-style-busy-text-1",
                  quick_reply: { payload: "disco" },
                },
              },
            ],
          },
        ],
      });

      await vi.waitFor(() => {
        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(resolveFetch).toBeTypeOf("function");
      });

      sendImageMock.mockClear();
      sendQuickRepliesMock.mockClear();
      sendTextMock.mockClear();

      await processFacebookWebhookPayload({
        entry: [
          {
            messaging: [
              {
                sender: { id: "busy-user-text" },
                message: {
                  mid: "mid-style-busy-text-2",
                  quick_reply: { payload: "gold" },
                },
              },
            ],
          },
        ],
      });

      expect(sendTextMock.mock.calls).toEqual([
        ["busy-user-text", "⏳ even geduld, ik ben nog bezig met jouw restyle"],
      ]);
      expect(sendImageMock).not.toHaveBeenCalled();
      expect(sendQuickRepliesMock).not.toHaveBeenCalled();

      const generatedImageBytes = Buffer.from("fake-png").toString("base64");
      resolveFetch?.({
        ok: true,
        json: async () => ({ data: [{ b64_json: generatedImageBytes }] }),
      });
      await firstRun;
    } finally {
      vi.unstubAllGlobals();
    }
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

    expect(sendTextMock).toHaveBeenLastCalledWith(
      "deterministic-user",
      t("nl", "flowExplanation")
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

    expect(sendTextMock).toHaveBeenLastCalledWith(
      "deterministic-no-photo-user",
      t("nl", "textWithoutPhoto")
    );
    expect(getState(anonymizePsid("deterministic-no-photo-user"))?.stage).toBe(
      "AWAITING_PHOTO"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps attachment/style/image generation path independent from free-text chat", async () => {
    installOpenAiSuccessFetchMock();

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "deterministic-image-user" },
              message: {
                mid: "mid-deterministic-image-photo",
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://img.example/image-path.jpg" },
                  },
                ],
              },
            },
            {
              sender: { id: "deterministic-image-user" },
              message: {
                mid: "mid-deterministic-image-style",
                quick_reply: { payload: "disco" },
              },
            },
          ],
        },
      ],
    });

    expect(sendImageMock).toHaveBeenCalledTimes(1);
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
        { content_type: "text", title: "Wat doe ik?", payload: "WHAT_IS_THIS" },
        { content_type: "text", title: "Privacy", payload: "PRIVACY_INFO" },
      ])
    );
  });

  it("ignores acknowledgement text after entering AWAITING_STYLE", async () => {
    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "style-user" },
              message: {
                mid: "mid-style-1",
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://img.example/style.jpg" },
                  },
                ],
              },
            },
            {
              sender: { id: "style-user" },
              message: { mid: "mid-style-2", text: "thanks" },
            },
          ],
        },
      ],
    });

    expect(sendTextMock).not.toHaveBeenCalled();
    expect(sendQuickRepliesMock).toHaveBeenLastCalledWith(
      "style-user",
      "Kies eerst een stijlgroep 👇",
      [
        {
          content_type: "text",
          title: "🎨 Illustrated",
          payload: "STYLE_CATEGORY_ILLUSTRATED",
        },
        {
          content_type: "text",
          title: "🌤️ Atmosphere",
          payload: "STYLE_CATEGORY_ATMOSPHERE",
        },
        {
          content_type: "text",
          title: "⚡ Bold",
          payload: "STYLE_CATEGORY_BOLD",
        },
      ]
    );
  });

  it("shows monthly budget fallback when OpenAI quota is exhausted", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";

    const sourceImage = Buffer.alloc(6000, 7);
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (isSourceImageFetchUrl(url, "https://img.example/source.jpg")) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "image/jpeg" }),
          arrayBuffer: async () => sourceImage,
        } as Response;
      }

      return new Response(
        JSON.stringify({
          error: {
            code: "insufficient_quota",
            message: "Budget reached for this month",
          },
        }),
        {
          status: 429,
          statusText: "Too Many Requests",
          headers: new Headers({ "content-type": "application/json" }),
        }
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    try {
      await processFacebookWebhookPayload({
        entry: [
          {
            messaging: [
              {
                sender: { id: "openai-budget-user" },
                message: {
                  mid: "mid-photo-openai-budget",
                  attachments: [
                    {
                      type: "image",
                      payload: { url: "https://img.example/source.jpg" },
                    },
                  ],
                },
              },
              {
                sender: { id: "openai-budget-user" },
                message: {
                  mid: "mid-style-openai-budget",
                  quick_reply: { payload: "clouds" },
                },
              },
            ],
          },
        ],
      });
    } finally {
      vi.unstubAllGlobals();
    }

    expect(sendTextMock).toHaveBeenLastCalledWith(
      "openai-budget-user",
      "⚠️ Even pauze — ons maandbudget is bereikt. Probeer later opnieuw."
    );
    expect(sendQuickRepliesMock).not.toHaveBeenLastCalledWith(
      "openai-budget-user",
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({ payload: "RETRY_STYLE_clouds" }),
      ])
    );
    expect(getState(anonymizePsid("openai-budget-user"))?.stage).toBe(
      "AWAITING_STYLE"
    );
  });

  it("emits one intentional response package per transition in order", async () => {
    installOpenAiSuccessFetchMock();

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "transition-order-user" },
              message: {
                mid: "mid-transition-photo",
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://img.example/source.jpg" },
                  },
                ],
              },
            },
            {
              sender: { id: "transition-order-user" },
              message: {
                mid: "mid-transition-style",
                quick_reply: { payload: "gold" },
              },
            },
          ],
        },
      ],
    });

    expect(sendQuickRepliesMock).toHaveBeenNthCalledWith(
      1,
      "transition-order-user",
      "Kies eerst een stijlgroep 👇",
      expect.any(Array)
    );
    expect(sendTextMock).toHaveBeenCalledTimes(1);
    expect(sendTextMock).toHaveBeenCalledWith(
      "transition-order-user",
      "Ik maak nu je Gold-stijl."
    );
    expect(sendImageMock).toHaveBeenCalledTimes(1);
    expect(sendQuickRepliesMock).toHaveBeenNthCalledWith(
      2,
      "transition-order-user",
      "Klaar ✅",
      [
        {
          content_type: "text",
          title: "Nieuwe stijl",
          payload: "CHOOSE_STYLE",
        },
        { content_type: "text", title: "Privacy", payload: "PRIVACY_INFO" },
      ]
    );

    expect(sendQuickRepliesMock.mock.invocationCallOrder[0]).toBeLessThan(
      sendTextMock.mock.invocationCallOrder[0]
    );
    expect(sendTextMock.mock.invocationCallOrder[0]).toBeLessThan(
      sendImageMock.mock.invocationCallOrder[0]
    );
    expect(sendImageMock.mock.invocationCallOrder[0]).toBeLessThan(
      sendQuickRepliesMock.mock.invocationCallOrder[1]
    );
  });

  it("shows category intro text before the carousel without duplicate substyle pills", async () => {
    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "category-user" },
              message: {
                mid: "mid-category-photo",
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://img.example/source.jpg" },
                  },
                ],
              },
            },
            {
              sender: { id: "category-user" },
              postback: { payload: "STYLE_CATEGORY_ILLUSTRATED" },
            },
          ],
        },
      ],
    });

    expect(sendTextMock).toHaveBeenCalledWith(
      "category-user",
      "Hier zijn je illustrated-stijlen. Kies er eentje hieronder."
    );
    expect(sendGenericTemplateMock).toHaveBeenCalledWith("category-user", [
      expect.objectContaining({
        title: "Caricature",
        image_url:
          "https://leaderbot-fb-image-gen.fly.dev/style-previews/caricature.png",
        buttons: [
          {
            type: "postback",
            title: "Kies",
            payload: "STYLE_CARICATURE",
          },
        ],
      }),
      expect.objectContaining({
        title: "Storybook Anime",
        image_url:
          "https://leaderbot-fb-image-gen.fly.dev/style-previews/storybook-anime.png",
        buttons: [
          {
            type: "postback",
            title: "Kies",
            payload: "STYLE_STORYBOOK_ANIME",
          },
        ],
      }),
      expect.objectContaining({
        title: "Oil Paint",
        image_url:
          "https://leaderbot-fb-image-gen.fly.dev/style-previews/oil-paint.png",
      }),
      expect.objectContaining({
        title: "Norman Blackwell",
        image_url:
          "https://leaderbot-fb-image-gen.fly.dev/style-previews/norman-blackwell.png",
      }),
    ]);
    expect(sendQuickRepliesMock).toHaveBeenCalledTimes(1);
    expect(sendQuickRepliesMock).toHaveBeenCalledWith(
      "category-user",
      "Kies eerst een stijlgroep 👇",
      expect.arrayContaining([
        expect.objectContaining({ payload: "STYLE_CATEGORY_ILLUSTRATED" }),
        expect.objectContaining({ payload: "STYLE_CATEGORY_ATMOSPHERE" }),
        expect.objectContaining({ payload: "STYLE_CATEGORY_BOLD" }),
      ])
    );
    expect(sendTextMock.mock.invocationCallOrder[0]).toBeLessThan(
      sendGenericTemplateMock.mock.invocationCallOrder[0]
    );
    expect(sendTextMock).not.toHaveBeenCalledWith(
      "category-user",
      "Oeps. Probeer nog een stijl."
    );
  });

  it("keeps category selection in no-photo flow on a single text-plus-carousel path", async () => {
    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "category-no-photo-user" },
              postback: { payload: "STYLE_CATEGORY_ATMOSPHERE" },
            },
          ],
        },
      ],
    });

    expect(sendTextMock).toHaveBeenCalledWith(
      "category-no-photo-user",
      "Hier zijn je atmosphere-stijlen. Kies er eentje hieronder."
    );
    expect(sendGenericTemplateMock).toHaveBeenCalledWith(
      "category-no-photo-user",
      expect.arrayContaining([
        expect.objectContaining({
          title: "Petals",
          image_url:
            "https://leaderbot-fb-image-gen.fly.dev/style-previews/petals.png",
        }),
        expect.objectContaining({
          title: "Cinematic",
          image_url:
            "https://leaderbot-fb-image-gen.fly.dev/style-previews/cinematic.png",
        }),
        expect.objectContaining({
          title: "Clouds",
          image_url:
            "https://leaderbot-fb-image-gen.fly.dev/style-previews/clouds.png",
        }),
      ])
    );
    expect(sendQuickRepliesMock).not.toHaveBeenCalled();
  });

  it("falls back to category style pills when the carousel send fails", async () => {
    sendGenericTemplateMock.mockRejectedValueOnce(new Error("template-failed"));

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "category-fallback-user" },
              message: {
                mid: "mid-category-fallback-photo",
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://img.example/source.jpg" },
                  },
                ],
              },
            },
            {
              sender: { id: "category-fallback-user" },
              postback: { payload: "STYLE_CATEGORY_BOLD" },
            },
          ],
        },
      ],
    });

    expect(sendQuickRepliesMock).toHaveBeenLastCalledWith(
      "category-fallback-user",
      "Hier zijn je bold-stijlen. Kies er eentje hieronder.",
      [
        {
          content_type: "text",
          title: "Afroman",
          payload: "STYLE_AFROMAN_AMERICANA",
        },
        { content_type: "text", title: "✨ Gold", payload: "STYLE_GOLD" },
        {
          content_type: "text",
          title: "🌃 Cyberpunk",
          payload: "STYLE_CYBERPUNK",
        },
        {
          content_type: "text",
          title: "🪩 Disco Glow",
          payload: "STYLE_DISCO",
        },
        {
          content_type: "text",
          title: "Categorieen",
          payload: "CHOOSE_STYLE",
        },
      ]
    );
    expect(safeLogMock).toHaveBeenCalledWith("style_category_carousel_failed", {
      user: expect.any(String),
      category: "bold",
      errorCode: "Error",
    });
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

    expect(sendQuickRepliesMock).toHaveBeenCalledWith(psid, "Klaar ✅", [
      { content_type: "text", title: "Nieuwe stijl", payload: "CHOOSE_STYLE" },
      { content_type: "text", title: "Privacy", payload: "PRIVACY_INFO" },
    ]);
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
      "Oeps. Probeer nog een stijl.",
      [
        {
          content_type: "text",
          title: "Probeer opnieuw",
          payload: "RETRY_STYLE",
        },
        {
          content_type: "text",
          title: "Andere stijl",
          payload: "CHOOSE_STYLE",
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

    expect(sendTextMock).toHaveBeenCalledWith(
      "edit-text-user",
      t("nl", "flowExplanation")
    );
    expect(sendImageMock).not.toHaveBeenCalled();
  });

  it("auto-runs surprise when a photo is already available", async () => {
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

    expect(sendTextMock).toHaveBeenNthCalledWith(
      1,
      "surprise-style-user",
      expect.stringMatching(/Mooie keuze/)
    );
    expect(sendTextMock).toHaveBeenNthCalledWith(
      2,
      "surprise-style-user",
      expect.stringMatching(/^Ik maak nu je .*?-stijl\.$/)
    );
    expect(sendTextMock).toHaveBeenCalledTimes(2);
    expect(sendImageMock).toHaveBeenCalledWith(
      "surprise-style-user",
      expect.stringMatching(
        /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.jpg$/
      )
    );
    expect(sendImageMock).toHaveBeenCalledTimes(1);
  });

  it("handles /style cyberpunk as a first-class style selection", async () => {
    installOpenAiSuccessFetchMock();
    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "style-command-user" },
              message: {
                mid: "mid-style-command-photo",
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
              sender: { id: "style-command-user" },
              message: {
                mid: "mid-style-command-text",
                text: "/style cyberpunk",
              },
            },
          ],
        },
      ],
    });

    expect(sendTextMock).toHaveBeenCalledWith(
      "style-command-user",
      "Ik maak nu je Cyberpunk-stijl."
    );
    expect(sendImageMock).toHaveBeenCalledWith(
      "style-command-user",
      expect.stringMatching(
        /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.jpg$/
      )
    );
    expect(getState(anonymizePsid("style-command-user"))?.selectedStyle).toBe(
      "cyberpunk"
    );
    expect(getState(anonymizePsid("style-command-user"))?.lastStyle).toBe(
      "cyberpunk"
    );
  });

  it("persists /style cyberpunk for the next photo upload", async () => {
    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "style-preselect-user" },
              message: {
                mid: "mid-style-preselect-text",
                text: "/style cyberpunk",
              },
            },
          ],
        },
      ],
    });

    expect(sendTextMock).toHaveBeenCalledWith(
      "style-preselect-user",
      "✅ Stijl ingesteld op cyberpunk.\n\nStuur eerst een foto, dan maak ik die stijl voor je."
    );
    expect(sendImageMock).not.toHaveBeenCalled();
    expect(getState(anonymizePsid("style-preselect-user"))?.stage).toBe(
      "AWAITING_PHOTO"
    );

    sendImageMock.mockClear();
    sendQuickRepliesMock.mockClear();
    sendTextMock.mockClear();
    installOpenAiSuccessFetchMock();

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "style-preselect-user" },
              message: {
                mid: "mid-style-preselect-photo",
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

    expect(sendTextMock).toHaveBeenCalledWith(
      "style-preselect-user",
      "Ik maak nu je Cyberpunk-stijl."
    );
    expect(sendImageMock).toHaveBeenCalledWith(
      "style-preselect-user",
      expect.stringMatching(
        /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.jpg$/
      )
    );
    expect(
      getState(anonymizePsid("style-preselect-user"))?.preselectedStyle
    ).toBeNull();
    expect(getState(anonymizePsid("style-preselect-user"))?.selectedStyle).toBe(
      "cyberpunk"
    );
  });

  it("continues generation after GDPR, style choice, photo upload, and face-memory consent", async () => {
    process.env.ENABLE_FACE_MEMORY = "true";
    const psid = "gdpr-style-photo-user";

    await sendMessengerQuickReply(
      processFacebookWebhookPayloadBase,
      psid,
      "mid-gdpr-style-photo-consent",
      "GDPR_CONSENT_AGREE"
    );

    await processFacebookWebhookPayloadBase({
      entry: [
        {
          messaging: [
            {
              sender: { id: psid },
              postback: { payload: "STYLE_CYBERPUNK" },
            },
          ],
        },
      ],
    });

    expect(getState(anonymizePsid(psid))?.preselectedStyle).toBe("cyberpunk");

    clearMessengerSendMocks();
    installOpenAiSuccessFetchMock();

    await sendMessengerPhoto(
      processFacebookWebhookPayloadBase,
      psid,
      "mid-gdpr-style-photo-upload",
      "https://img.example/source.jpg"
    );

    expectFaceMemoryConsentPrompt(psid);

    clearMessengerSendMocks();

    await sendMessengerQuickReply(
      processFacebookWebhookPayloadBase,
      psid,
      "mid-gdpr-style-photo-memory-yes",
      "CONSENT_FACE_YES"
    );

    expect(sendTextMock).toHaveBeenCalledWith(
      psid,
      "Ik maak nu je Cyberpunk-stijl."
    );
    expect(sendImageMock).toHaveBeenCalledWith(
      psid,
      expect.stringMatching(
        /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.jpg$/
      )
    );
    expect(sendQuickRepliesMock).not.toHaveBeenCalledWith(
      psid,
      t("nl", "styleCategoryPicker"),
      expect.any(Array)
    );
    expect(getState(anonymizePsid(psid))?.preselectedStyle).toBeNull();
    expect(getState(anonymizePsid(psid))?.selectedStyle).toBe("cyberpunk");
  });

  it("does not resume a stale preselected style after face-memory consent for a replacement photo", async () => {
    process.env.ENABLE_FACE_MEMORY = "true";
    const psid = "face-memory-stale-preselect-user";
    await setPendingImage(psid, "https://img.example/old-source.jpg");
    await setPreselectedStyle(psid, "cyberpunk");

    clearMessengerSendMocks();

    await sendMessengerPhoto(
      processFacebookWebhookPayload,
      psid,
      "mid-face-memory-stale-photo",
      "https://img.example/new-source.jpg"
    );

    expectFaceMemoryConsentPrompt(psid);

    clearMessengerSendMocks();

    await sendMessengerQuickReply(
      processFacebookWebhookPayload,
      psid,
      "mid-face-memory-stale-yes",
      "CONSENT_FACE_YES"
    );

    expect(sendImageMock).not.toHaveBeenCalled();
    expect(sendTextMock).not.toHaveBeenCalledWith(
      psid,
      "Ik maak nu je Cyberpunk-stijl."
    );
    expect(sendQuickRepliesMock).toHaveBeenCalledWith(
      psid,
      t("nl", "styleCategoryPicker"),
      expect.arrayContaining([
        expect.objectContaining({ payload: "STYLE_CATEGORY_ILLUSTRATED" }),
      ])
    );
    expect(getState(anonymizePsid(psid))?.preselectedStyle).toBeNull();
    expect(getState(anonymizePsid(psid))?.stage).toBe("AWAITING_STYLE");
  });

  it("does not auto-run a stale preselected style when a new photo replaces an older one", async () => {
    await setPendingImage("stale-preselect-user", "https://img.example/old-source.jpg");
    await setPreselectedStyle("stale-preselect-user", "cyberpunk");

    sendImageMock.mockClear();
    sendQuickRepliesMock.mockClear();
    sendTextMock.mockClear();

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "stale-preselect-user" },
              message: {
                mid: "mid-stale-preselect-photo",
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://img.example/new-source.jpg" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(sendImageMock).not.toHaveBeenCalled();
    expect(sendQuickRepliesMock).toHaveBeenCalledWith(
      "stale-preselect-user",
      "Kies eerst een stijlgroep 👇",
      expect.arrayContaining([
        expect.objectContaining({ payload: "STYLE_CATEGORY_ILLUSTRATED" }),
        expect.objectContaining({ payload: "STYLE_CATEGORY_ATMOSPHERE" }),
        expect.objectContaining({ payload: "STYLE_CATEGORY_BOLD" }),
      ])
    );
    expect(getState(anonymizePsid("stale-preselect-user"))?.lastPhotoUrl).toMatch(
      /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.jpg$/
    );
    expect(getState(anonymizePsid("stale-preselect-user"))?.lastPhotoSource).toBe("stored");
    expect(
      getState(anonymizePsid("stale-preselect-user"))?.preselectedStyle
    ).toBe("cyberpunk");
  });

  it("stores Messenger attachment URLs before downstream generation fetches them again", async () => {
    const fetchMock = installOpenAiSuccessFetchMock();

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "stored-boundary-user" },
              message: {
                mid: "mid-stored-boundary-photo",
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://img.example/source.jpg" },
                  },
                ],
              },
            },
            {
              sender: { id: "stored-boundary-user" },
              message: {
                mid: "mid-stored-boundary-style",
                quick_reply: { payload: "gold" },
              },
            },
          ],
        },
      ],
    });

    const fetchedUrls = fetchMock.mock.calls.map(([url]) => toUrlString(url));
    expect(fetchedUrls.filter(url => url === "https://img.example/source.jpg")).toHaveLength(1);
    expect(
      fetchedUrls.some(url => url.startsWith(GENERATED_SOURCE_IMAGE_URL_PREFIX))
    ).toBe(true);
    expect(getState(anonymizePsid("stored-boundary-user"))?.lastPhotoSource).toBe(
      "stored"
    );
  });

  it("handles /style Afroman and routes the next generation through afroman-americana", async () => {
    const sourceImage = Buffer.alloc(6000, 7);
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (isSourceImageFetchUrl(url)) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "image/jpeg" }),
          arrayBuffer: async () => sourceImage,
        } as Response;
      }

      const formData = init?.body as FormData;
      const prompt = String(formData.get("prompt"));
      expect(prompt).toContain(
        "Transform this photo into a premium stylized portrait in an Afroman-inspired Americana look."
      );
      expect(prompt).toContain(
        "Preserve the subject identity and facial features"
      );
      expect(prompt).toContain("tailored American flag suit");
      expect(prompt).toContain("bold retro Americana energy");

      return {
        ok: true,
        json: async () => ({ data: [{ b64_json: GENERATED_IMAGE_BASE64 }] }),
      } as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    await processFacebookWebhookPayload({
      entry: [
        {
          messaging: [
            {
              sender: { id: "afroman-style-user" },
              message: {
                mid: "mid-afroman-photo",
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
              sender: { id: "afroman-style-user" },
              message: {
                mid: "mid-afroman-style-command",
                text: "/style Afroman",
              },
            },
          ],
        },
      ],
    });

    expect(sendTextMock).toHaveBeenCalledWith(
      "afroman-style-user",
      "Ik maak nu je Afroman-stijl."
    );
    expect(sendImageMock).toHaveBeenCalledWith(
      "afroman-style-user",
      expect.stringMatching(
        /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.jpg$/
      )
    );
    expect(getState(anonymizePsid("afroman-style-user"))?.selectedStyle).toBe(
      "afroman-americana"
    );
    expect(getState(anonymizePsid("afroman-style-user"))?.lastStyle).toBe(
      "afroman-americana"
    );
  });
});

