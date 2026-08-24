import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  claimWhatsAppWebhookReplayLease,
  completeWhatsAppWebhookReplayLease,
  markWhatsAppWebhookEffectsStarted,
  releaseWhatsAppWebhookReplayLease,
} from "./_core/webhookReplayProtection";
import { getRedisClient, resetRedisClientForTests } from "./_core/redis";

const suite = describe.runIf(process.env.RUN_REDIS_INTEGRATION === "1");
const originalRedisUrl = process.env.REDIS_URL;
const originalReplayTtl = process.env.WHATSAPP_WEBHOOK_REPLAY_TTL_SECONDS;
const originalReplayLease = process.env.WHATSAPP_WEBHOOK_REPLAY_LEASE_SECONDS;
const originalContentTtl = process.env.WEBHOOK_INGRESS_CONTENT_TTL_SECONDS;
const originalIngressLease = process.env.WEBHOOK_INGRESS_DELIVERY_LEASE_SECONDS;
const originalIngressAttempts = process.env.WEBHOOK_INGRESS_MAX_ATTEMPTS;
const replayKeys = new Set<string>();

function logicalReplayKey(label: string): string {
  return `whatsapp:v2:redis:${label}:${randomUUID()}`;
}

function redisReplayKey(logicalKey: string): string {
  const key = `webhook-replay:${logicalKey}`;
  replayKeys.add(key);
  return key;
}

suite("WhatsApp webhook replay state with Redis", () => {
  beforeAll(async () => {
    process.env.REDIS_URL ||= "redis://127.0.0.1:6379/12";
    process.env.WHATSAPP_WEBHOOK_REPLAY_TTL_SECONDS = "86400";
    process.env.WHATSAPP_WEBHOOK_REPLAY_LEASE_SECONDS = "300";
    process.env.WEBHOOK_INGRESS_CONTENT_TTL_SECONDS = "86400";
    process.env.WEBHOOK_INGRESS_DELIVERY_LEASE_SECONDS = "900";
    process.env.WEBHOOK_INGRESS_MAX_ATTEMPTS = "3";
    resetRedisClientForTests();
    await (await getRedisClient()).ping();
  });

  afterEach(async () => {
    const redis = await getRedisClient();
    for (const key of replayKeys) await redis.del(key);
    replayKeys.clear();
  });

  afterAll(() => {
    resetRedisClientForTests();
    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;
    for (const [name, value] of [
      ["WHATSAPP_WEBHOOK_REPLAY_TTL_SECONDS", originalReplayTtl],
      ["WHATSAPP_WEBHOOK_REPLAY_LEASE_SECONDS", originalReplayLease],
      ["WEBHOOK_INGRESS_CONTENT_TTL_SECONDS", originalContentTtl],
      ["WEBHOOK_INGRESS_DELIVERY_LEASE_SECONDS", originalIngressLease],
      ["WEBHOOK_INGRESS_MAX_ATTEMPTS", originalIngressAttempts],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("mutually excludes legacy and phase-aware instances on one key", async () => {
    const redis = await getRedisClient();
    const legacyFirst = logicalReplayKey("legacy-first");
    const legacyFirstKey = redisReplayKey(legacyFirst);
    await redis.set(legacyFirstKey, "1", "EX", 60);
    await expect(claimWhatsAppWebhookReplayLease(legacyFirst)).resolves.toEqual(
      { status: "duplicate" }
    );

    const newFirst = logicalReplayKey("new-first");
    const newFirstKey = redisReplayKey(newFirst);
    const claim = await claimWhatsAppWebhookReplayLease(newFirst);
    if (claim.status !== "acquired") throw new Error("expected replay lease");
    await expect(
      redis.set(newFirstKey, "1", "EX", 60, "NX")
    ).resolves.toBeNull();
    await completeWhatsAppWebhookReplayLease(claim.lease);
    await expect(
      releaseWhatsAppWebhookReplayLease(claim.lease)
    ).resolves.toBeUndefined();
    await expect(claimWhatsAppWebhookReplayLease(newFirst)).resolves.toEqual({
      status: "duplicate",
    });
  });

  it("takes over expired owners without losing the durable event/fallback phase", async () => {
    const redis = await getRedisClient();

    const eventLogical = logicalReplayKey("event-expiry");
    const eventKey = redisReplayKey(eventLogical);
    const event = await claimWhatsAppWebhookReplayLease(eventLogical);
    if (event.status !== "acquired") throw new Error("expected event lease");
    await redis.set(eventKey, `event:${event.lease.ownerToken}:1`, "EX", 60);
    const recoveredEvent = await claimWhatsAppWebhookReplayLease(eventLogical);
    if (recoveredEvent.status !== "acquired") {
      throw new Error("expected recovered event lease");
    }
    expect(recoveredEvent.lease.mode).toBe("event");
    await releaseWhatsAppWebhookReplayLease(recoveredEvent.lease);

    const fallbackLogical = logicalReplayKey("fallback-expiry");
    const fallbackKey = redisReplayKey(fallbackLogical);
    const beforeEffects =
      await claimWhatsAppWebhookReplayLease(fallbackLogical);
    if (beforeEffects.status !== "acquired") {
      throw new Error("expected pre-effects lease");
    }
    await markWhatsAppWebhookEffectsStarted(beforeEffects.lease);
    await expect(redis.get(fallbackKey)).resolves.toMatch(
      new RegExp(`^fallback:${beforeEffects.lease.ownerToken}:\\d+$`)
    );
    await redis.set(
      fallbackKey,
      `fallback:${beforeEffects.lease.ownerToken}:1`,
      "EX",
      60
    );
    const recoveredFallback =
      await claimWhatsAppWebhookReplayLease(fallbackLogical);
    if (recoveredFallback.status !== "acquired") {
      throw new Error("expected recovered fallback lease");
    }
    expect(recoveredFallback.lease.mode).toBe("fallback");
    await releaseWhatsAppWebhookReplayLease(recoveredFallback.lease);
    await expect(redis.get(fallbackKey)).resolves.toBe("fallback_pending");
  });
});
