import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLeaderbotAiAnswerIdempotencyKey,
  finalizeLeaderbotAiAnswerQuota,
  isLeaderbotAiAnswerEnforcementEnabled,
  markLeaderbotAiAnswerDeliveryStarted,
  reserveLeaderbotAiAnswerQuota,
} from "./leaderbot-bridge.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
  process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
  delete process.env.LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED;
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.unstubAllGlobals();
});

describe("Leaderbot AI-answer quota bridge", () => {
  it("is default-off and only enables on the exact rollout value", () => {
    expect(isLeaderbotAiAnswerEnforcementEnabled()).toBe(false);
    process.env.LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED = "TRUE";
    expect(isLeaderbotAiAnswerEnforcementEnabled()).toBe(false);
    process.env.LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED = "true";
    expect(isLeaderbotAiAnswerEnforcementEnabled()).toBe(true);
  });

  it("derives a stable opaque key without exposing inbound identifiers", () => {
    const input = {
      accountId: "tenant-account",
      pageId: "raw-page-id",
      messageId: "raw-message-id",
      traceRequestId: "raw-trace-id",
      timestamp: 1_700_000_000_000,
    };
    const key = createLeaderbotAiAnswerIdempotencyKey(input);

    expect(createLeaderbotAiAnswerIdempotencyKey(input)).toBe(key);
    expect(
      createLeaderbotAiAnswerIdempotencyKey({
        ...input,
        traceRequestId: "a-different-trace",
        timestamp: input.timestamp + 999,
      }),
    ).toBe(key);
    expect(key).toMatch(/^messenger_ai_answer:[0-9a-f]{64}$/);
    expect(key).not.toContain(input.pageId);
    expect(key).not.toContain(input.messageId);
    expect(key).not.toContain(input.traceRequestId);
  });

  it("uses trace and timestamp only when Meta supplied no message id", () => {
    const base = {
      accountId: "tenant-account",
      pageId: "raw-page-id",
      traceRequestId: "trace-one",
      timestamp: 1_700_000_000_000,
    };
    expect(createLeaderbotAiAnswerIdempotencyKey(base)).not.toBe(
      createLeaderbotAiAnswerIdempotencyKey({
        ...base,
        traceRequestId: "trace-two",
      }),
    );
  });

  it("uses the authenticated internal route and parses a reservation", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          status: "reserved",
          reservationId: "16be1d70-9ed5-4b32-80cc-98be433581dc",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      reserveLeaderbotAiAnswerQuota({
        pageId: "page-1",
        idempotencyKey: `messenger_ai_answer:${"a".repeat(64)}`,
        ownerToken: "11111111-1111-4111-8111-111111111111",
      }),
    ).resolves.toEqual({
      status: "reserved",
      reservationId: "16be1d70-9ed5-4b32-80cc-98be433581dc",
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://image-gen.example.test/internal/messenger/ai-answer-quota/reserve",
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({ Authorization: "Bearer internal-token" });
    expect(JSON.parse(String(init.body))).toEqual({
      pageId: "page-1",
      idempotencyKey: `messenger_ai_answer:${"a".repeat(64)}`,
      ownerToken: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("fails closed on transport errors and finalizes by opaque reservation id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("offline");
    }));
    await expect(
      reserveLeaderbotAiAnswerQuota({
        pageId: "page-1",
        idempotencyKey: `messenger_ai_answer:${"b".repeat(64)}`,
        ownerToken: "11111111-1111-4111-8111-111111111111",
      }),
    ).resolves.toEqual({ status: "unavailable" });

    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ status: "finalized" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      finalizeLeaderbotAiAnswerQuota({
        pageId: "page-1",
        reservationId: "16be1d70-9ed5-4b32-80cc-98be433581dc",
        ownerToken: "11111111-1111-4111-8111-111111111111",
        outcome: "committed",
      }),
    ).resolves.toBe(true);
  });

  it("retries a lost delivery-fence response once with the same attempt token", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "delivery_started" }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      pageId: "page-1",
      reservationId: "16be1d70-9ed5-4b32-80cc-98be433581dc",
      ownerToken: "11111111-1111-4111-8111-111111111111",
      deliveryAttemptToken: "22222222-2222-4222-8222-222222222222",
    };

    await expect(markLeaderbotAiAnswerDeliveryStarted(input)).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(
      fetchMock.mock.calls.map(call =>
        JSON.parse(String((call[1] as RequestInit).body)),
      ),
    ).toEqual([input, input]);
  });
});
