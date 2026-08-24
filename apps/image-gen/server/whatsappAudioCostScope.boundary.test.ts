import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertOwnership: vi.fn(async () => undefined),
  assertPrivacy: vi.fn(async () => undefined),
  reserveFence: vi.fn(async () => ({
    leaseToken: null,
    attemptKeyHash: null,
  })),
  markFenceStarted: vi.fn(async () => undefined),
  finalizeFence: vi.fn(async () => undefined),
}));

vi.mock("./_core/workspaceEntitlementRuntime", () => ({
  assertMessengerGenerationOwnership: mocks.assertOwnership,
}));

vi.mock("./_core/messengerPrivacySubject", () => ({
  assertMessengerPrivacySubject: mocks.assertPrivacy,
}));

vi.mock("./_core/messengerProviderAttemptFence", () => ({
  reserveMessengerProviderAttemptFence: mocks.reserveFence,
  markMessengerProviderAttemptStarted: mocks.markFenceStarted,
  finalizeMessengerProviderAttemptFence: mocks.finalizeFence,
}));

import { readCostLedgerPeriod } from "./_core/costLedger";
import { toUserKey } from "./_core/privacy";
import { clearStateStore } from "./_core/stateStore";
import {
  transcribePreparedAudioMessage,
  type AudioProviderJob,
} from "./_core/webhookAudioMessageRouter";

const SCOPE = Object.freeze({
  workspaceId: 42,
  channelConnectionId: 8,
  bindingEpoch: 3,
  privacyEpoch: 2,
});
const SENDER_ID = "32470000001";

function providerJob(userId: string): AudioProviderJob {
  return {
    psid: SENDER_ID,
    userId,
    reqId: "req-wa-audio-boundary",
    lang: "en",
    pageId: "404040404040404",
    ...SCOPE,
    providerChannel: "whatsapp",
  };
}

describe("WhatsApp audio cost-admission boundary", () => {
  beforeEach(() => {
    process.env.PRIVACY_PEPPER = "whatsapp-audio-boundary-pepper";
    process.env.OPENAI_AUDIO_TRANSCRIPTION_ESTIMATED_COST_USD = "0.01";
    delete process.env.DATABASE_URL;
    delete process.env.REDIS_URL;
    delete process.env.MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD;
    delete process.env.MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD;
    delete process.env.MESSENGER_USER_DAILY_SPEND_CAP_USD;
    clearStateStore();
    vi.clearAllMocks();
    mocks.assertOwnership.mockResolvedValue(undefined);
    mocks.assertPrivacy.mockResolvedValue(undefined);
    mocks.reserveFence.mockResolvedValue({
      leaseToken: null,
      attemptKeyHash: null,
    });
    mocks.markFenceStarted.mockResolvedValue(undefined);
    mocks.finalizeFence.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.PRIVACY_PEPPER;
    delete process.env.OPENAI_AUDIO_TRANSCRIPTION_ESTIMATED_COST_USD;
    clearStateStore();
  });

  it("records the exact WhatsApp tenant scope before the provider call", async () => {
    const userId = toUserKey(SENDER_ID);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ text: "a valid transcript" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      transcribePreparedAudioMessage(
        "req-wa-audio-boundary",
        SENDER_ID,
        userId,
        "wa-media-id",
        {
          apiKey: "test-key",
          sourceAudio: {
            buffer: Buffer.from("audio"),
            contentType: "audio/ogg",
            incomingLen: 5,
          },
        },
        async () => undefined,
        "whatsapp",
        providerJob(userId)
      )
    ).resolves.toBe("a valid transcript");

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(mocks.reserveFence).toHaveBeenCalledWith(
      expect.objectContaining({ providerChannel: "whatsapp" }),
      "openai-audio-transcription",
      1,
      expect.any(Date),
      "whatsapp"
    );
    expect(mocks.assertOwnership).toHaveBeenCalledWith(
      expect.objectContaining({ ...SCOPE, channel: "whatsapp" })
    );
    const period = new Date().toISOString().slice(0, 10);
    const entries = await readCostLedgerPeriod(period);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      ...SCOPE,
      channel: "whatsapp",
      operation: "audio_transcription",
      userKey: userId,
      status: "provider_attempt_succeeded",
    });
  });

  it("rejects a recipient/user mismatch before provider admission or fetch", async () => {
    const userId = toUserKey(SENDER_ID);
    const fetchMock = vi.fn<typeof fetch>();
    const providerAttempt = vi.fn(async () => undefined);
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      transcribePreparedAudioMessage(
        "req-wa-audio-boundary",
        SENDER_ID,
        userId,
        "wa-media-id",
        {
          apiKey: "test-key",
          sourceAudio: {
            buffer: Buffer.from("audio"),
            contentType: "audio/ogg",
            incomingLen: 5,
          },
        },
        providerAttempt,
        "whatsapp",
        providerJob(toUserKey("32479999999"))
      )
    ).rejects.toThrow(
      "Audio transcription requires tenant-scoped cost admission"
    );

    expect(providerAttempt).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.assertOwnership).not.toHaveBeenCalled();
  });

  it("releases pretransport admission when the durable privacy fence loses", async () => {
    const userId = toUserKey(SENDER_ID);
    const providerAttempt = vi.fn(async () => undefined);
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    mocks.reserveFence.mockResolvedValueOnce({
      leaseToken: "lease",
      attemptKeyHash: "a".repeat(64),
    });
    mocks.markFenceStarted.mockRejectedValueOnce(
      new Error("WhatsApp provider privacy changed")
    );

    await expect(
      transcribePreparedAudioMessage(
        "req-wa-audio-boundary",
        SENDER_ID,
        userId,
        "wa-media-id",
        {
          apiKey: "test-key",
          sourceAudio: {
            buffer: Buffer.from("audio"),
            contentType: "audio/ogg",
            incomingLen: 5,
          },
        },
        providerAttempt,
        "whatsapp",
        providerJob(userId)
      )
    ).rejects.toThrow("WhatsApp provider privacy changed");

    expect(providerAttempt).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.finalizeFence).toHaveBeenCalledWith(
      expect.any(Object),
      "known_failed"
    );
    const entries = await readCostLedgerPeriod(
      new Date().toISOString().slice(0, 10)
    );
    expect(entries).toEqual([
      expect.objectContaining({ status: "provider_attempt_failed" }),
    ]);
  });

  it.each([408, 425])(
    "treats a post-start HTTP %i as ambiguous and never retries",
    async status => {
      const userId = toUserKey(SENDER_ID);
      mocks.reserveFence.mockResolvedValue({
        leaseToken: "lease",
        attemptKeyHash: "b".repeat(64),
      });
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("uncertain", { status }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        transcribePreparedAudioMessage(
          `req-wa-audio-${status}`,
          SENDER_ID,
          userId,
          "wa-media-id",
          {
            apiKey: "test-key",
            sourceAudio: {
              buffer: Buffer.from("audio"),
              contentType: "audio/ogg",
              incomingLen: 5,
            },
          },
          async () => undefined,
          "whatsapp",
          { ...providerJob(userId), reqId: `req-wa-audio-${status}` }
        )
      ).resolves.toBeNull();

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(mocks.finalizeFence).toHaveBeenCalledWith(
        expect.any(Object),
        "ambiguous"
      );
    }
  );

  it("preserves a known provider success when deletion wins before transcript delivery", async () => {
    const userId = toUserKey(SENDER_ID);
    mocks.reserveFence.mockResolvedValue({
      leaseToken: "lease",
      attemptKeyHash: "c".repeat(64),
    });
    mocks.assertPrivacy
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("privacy subject erased"));
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ text: "a valid transcript" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      )
    );

    await expect(
      transcribePreparedAudioMessage(
        "req-wa-audio-post-success-delete",
        SENDER_ID,
        userId,
        "wa-media-id",
        {
          apiKey: "test-key",
          sourceAudio: {
            buffer: Buffer.from("audio"),
            contentType: "audio/ogg",
            incomingLen: 5,
          },
        },
        async () => undefined,
        "whatsapp",
        {
          ...providerJob(userId),
          reqId: "req-wa-audio-post-success-delete",
        }
      )
    ).resolves.toBeNull();

    expect(mocks.finalizeFence).toHaveBeenCalledWith(
      expect.any(Object),
      "succeeded"
    );
    expect(mocks.finalizeFence).not.toHaveBeenCalledWith(
      expect.any(Object),
      "ambiguous"
    );
    const entries = await readCostLedgerPeriod(
      new Date().toISOString().slice(0, 10)
    );
    expect(entries).toEqual([
      expect.objectContaining({ status: "provider_attempt_succeeded" }),
    ]);
  });
});
