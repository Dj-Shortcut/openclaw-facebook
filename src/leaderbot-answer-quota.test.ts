import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createLeaderbotAiAnswerQuotaToken,
  createLeaderbotAiAnswerIdempotencyKey,
  finalizeLeaderbotAiAnswerQuota,
  getLeaderbotAiAnswerQuotaReadiness,
  heartbeatLeaderbotAiAnswerQuota,
  isLeaderbotAiAnswerEnforcementEnabled,
  markLeaderbotAiAnswerDeliveryKnownRejected,
  markLeaderbotAiAnswerDeliveryStarted,
  reserveLeaderbotAiAnswerQuota,
  startLeaderbotAiAnswerQuotaHeartbeat,
} from "./leaderbot-bridge.js";

const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.LEADERBOT_IMAGE_GEN_INTERNAL_TOKEN = "internal-token";
  process.env.LEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test";
  delete process.env.LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED;
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Leaderbot AI-answer quota bridge", () => {
  const ownerToken = "11111111-1111-4111-8111-111111111111";
  const reservationId = "16be1d70-9ed5-4b32-80cc-98be433581dc";
  const deliveryAttemptToken = "22222222-2222-4222-8222-222222222222";

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

  it("creates canonical UUID tokens for lease ownership and delivery attempts", () => {
    expect(createLeaderbotAiAnswerQuotaToken()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("accepts only the exact authenticated readiness protocol", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            protocol: "leaderbot-ai-answer-quota-v1",
            preflightReady: true,
            admissionEnabled: true,
            drainEnabled: true,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            protocol: "stale-protocol",
            preflightReady: true,
            admissionEnabled: true,
            drainEnabled: true,
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getLeaderbotAiAnswerQuotaReadiness()).resolves.toEqual({
      protocol: "leaderbot-ai-answer-quota-v1",
      preflightReady: true,
      admissionEnabled: true,
      drainEnabled: true,
    });
    await expect(getLeaderbotAiAnswerQuotaReadiness()).resolves.toBeNull();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("uses the authenticated internal route and parses a reservation", async () => {
    const fetchMock = vi.fn(
      async () =>
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
        ownerToken,
      }),
    ).resolves.toEqual({
      status: "reserved",
      reservationId,
      ownerToken,
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      "https://image-gen.example.test/internal/messenger/ai-answer-quota/reserve",
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      Authorization: "Bearer internal-token",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      pageId: "page-1",
      idempotencyKey: `messenger_ai_answer:${"a".repeat(64)}`,
      ownerToken,
    });
  });

  it("fails closed on transport errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(
      reserveLeaderbotAiAnswerQuota({
        pageId: "page-1",
        idempotencyKey: `messenger_ai_answer:${"b".repeat(64)}`,
        ownerToken,
      }),
    ).resolves.toEqual({ status: "unavailable" });
  });

  it("retains owner and attempt UUIDs across the full transport protocol", async () => {
    const bodies: Array<{ operation: string; body: Record<string, unknown> }> =
      [];
    const fetchMock = vi.fn(
      async (url: URL | RequestInfo | string, init?: RequestInit) => {
        const operation = String(url).split("/").at(-1) ?? "";
        bodies.push({ operation, body: JSON.parse(String(init?.body)) });
        const status = {
          heartbeat: "lease_renewed",
          "delivery-started": "delivery_started",
          "delivery-known-rejected": "delivery_known_rejected",
          finalize: "finalized",
        }[operation];
        return new Response(JSON.stringify({ status }), { status: 200 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    const lease = { reservationId, ownerToken };

    await expect(heartbeatLeaderbotAiAnswerQuota(lease)).resolves.toBe(true);
    await expect(
      markLeaderbotAiAnswerDeliveryStarted({
        ...lease,
        pageId: "page-1",
        deliveryAttemptToken,
      }),
    ).resolves.toBe(true);
    await expect(
      markLeaderbotAiAnswerDeliveryKnownRejected({
        ...lease,
        pageId: "page-1",
        deliveryAttemptToken,
      }),
    ).resolves.toBe(true);
    await expect(
      finalizeLeaderbotAiAnswerQuota({
        pageId: "page-1",
        ...lease,
        outcome: "committed",
      }),
    ).resolves.toBe(true);

    expect(bodies).toEqual([
      { operation: "heartbeat", body: lease },
      {
        operation: "delivery-started",
        body: { ...lease, pageId: "page-1", deliveryAttemptToken },
      },
      {
        operation: "delivery-known-rejected",
        body: { ...lease, pageId: "page-1", deliveryAttemptToken },
      },
      {
        operation: "finalize",
        body: { ...lease, pageId: "page-1", outcome: "committed" },
      },
    ]);
  });

  it("renews periodically and stops before the final pre-transport heartbeat", async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn(async () => true);
    const controller = startLeaderbotAiAnswerQuotaHeartbeat(
      { reservationId, ownerToken },
      { intervalMs: 1_000, heartbeat },
    );

    await vi.advanceTimersByTimeAsync(2_000);
    expect(heartbeat).toHaveBeenCalledTimes(2);
    await expect(controller.renewBeforeDelivery()).resolves.toBe(true);
    expect(heartbeat).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(heartbeat).toHaveBeenCalledTimes(3);
    await controller.stop();
  });

  it("blocks transport after any periodic heartbeat failure", async () => {
    vi.useFakeTimers();
    const heartbeat = vi.fn(async () => false);
    const controller = startLeaderbotAiAnswerQuotaHeartbeat(
      { reservationId, ownerToken },
      { intervalMs: 1_000, heartbeat },
    );

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(controller.renewBeforeDelivery()).resolves.toBe(false);
    expect(heartbeat).toHaveBeenCalledTimes(1);
    await controller.stop();
  });

  it("refuses malformed UUIDs without contacting the quota service", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      reserveLeaderbotAiAnswerQuota({
        pageId: "page-1",
        idempotencyKey: `messenger_ai_answer:${"c".repeat(64)}`,
        ownerToken: "not-a-uuid",
      }),
    ).resolves.toEqual({ status: "unavailable" });
    await expect(
      markLeaderbotAiAnswerDeliveryStarted({
        reservationId,
        ownerToken,
        pageId: "page-1",
        deliveryAttemptToken: "not-a-uuid",
      }),
    ).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
