import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertProductionWebhookReplayProtectionConfig,
  claimWebhookReplayKey,
  claimWhatsAppWebhookReplayLease,
  claimWhatsAppWebhookReplayLeaseWithDeps,
  completeWhatsAppWebhookReplayLease,
  completeWhatsAppWebhookReplayLeaseWithDeps,
  createWhatsAppWebhookReplayOwnerToken,
  markWhatsAppWebhookEffectsStarted,
  markWhatsAppWebhookFallbackPending,
  markWhatsAppWebhookFallbackPendingWithDeps,
  releaseWhatsAppWebhookReplayLease,
  resetWebhookReplayProtection,
  runWithWhatsAppWebhookReplayLeaseHeartbeat,
  type WhatsAppWebhookReplayDeps,
} from "./_core/webhookReplayProtection";

const originalNodeEnv = process.env.NODE_ENV;
const originalRedisUrl = process.env.REDIS_URL;
const originalReplayTtl = process.env.WEBHOOK_REPLAY_TTL_SECONDS;
const originalWhatsAppReplayTtl =
  process.env.WHATSAPP_WEBHOOK_REPLAY_TTL_SECONDS;
const originalWhatsAppReplayLease =
  process.env.WHATSAPP_WEBHOOK_REPLAY_LEASE_SECONDS;
const originalIngressContentTtl =
  process.env.WEBHOOK_INGRESS_CONTENT_TTL_SECONDS;
const originalIngressLease = process.env.WEBHOOK_INGRESS_DELIVERY_LEASE_SECONDS;
const originalIngressAttempts = process.env.WEBHOOK_INGRESS_MAX_ATTEMPTS;

beforeEach(() => {
  delete process.env.REDIS_URL;
  delete process.env.WHATSAPP_WEBHOOK_REPLAY_TTL_SECONDS;
  delete process.env.WHATSAPP_WEBHOOK_REPLAY_LEASE_SECONDS;
  delete process.env.WEBHOOK_INGRESS_CONTENT_TTL_SECONDS;
  delete process.env.WEBHOOK_INGRESS_DELIVERY_LEASE_SECONDS;
  delete process.env.WEBHOOK_INGRESS_MAX_ATTEMPTS;
  resetWebhookReplayProtection();
});

afterEach(() => {
  vi.useRealTimers();
  resetWebhookReplayProtection();
  if (originalNodeEnv === undefined) {
    delete process.env.NODE_ENV;
  } else {
    process.env.NODE_ENV = originalNodeEnv;
  }

  if (originalRedisUrl === undefined) {
    delete process.env.REDIS_URL;
  } else {
    process.env.REDIS_URL = originalRedisUrl;
  }

  if (originalReplayTtl === undefined) {
    delete process.env.WEBHOOK_REPLAY_TTL_SECONDS;
  } else {
    process.env.WEBHOOK_REPLAY_TTL_SECONDS = originalReplayTtl;
  }
  for (const [name, value] of [
    ["WHATSAPP_WEBHOOK_REPLAY_TTL_SECONDS", originalWhatsAppReplayTtl],
    ["WHATSAPP_WEBHOOK_REPLAY_LEASE_SECONDS", originalWhatsAppReplayLease],
    ["WEBHOOK_INGRESS_CONTENT_TTL_SECONDS", originalIngressContentTtl],
    ["WEBHOOK_INGRESS_DELIVERY_LEASE_SECONDS", originalIngressLease],
    ["WEBHOOK_INGRESS_MAX_ATTEMPTS", originalIngressAttempts],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("webhook replay protection config", () => {
  it("requires REDIS_URL in production", () => {
    process.env.NODE_ENV = "production";
    delete process.env.REDIS_URL;

    expect(() => assertProductionWebhookReplayProtectionConfig()).toThrow(
      "REDIS_URL must be configured in production for webhook replay protection"
    );
  });

  it("allows dev mode without REDIS_URL", () => {
    process.env.NODE_ENV = "development";
    delete process.env.REDIS_URL;

    expect(() => assertProductionWebhookReplayProtectionConfig()).not.toThrow();
  });
});

describe("WhatsApp webhook replay lease", () => {
  it("preserves the existing Messenger one-shot replay API", async () => {
    await expect(claimWebhookReplayKey("mid:messenger-event")).resolves.toBe(
      true
    );
    await expect(claimWebhookReplayKey("mid:messenger-event")).resolves.toBe(
      false
    );
  });

  it("releases only its current processing owner and completes monotonically", async () => {
    const first = await claimWhatsAppWebhookReplayLease(
      "whatsapp:v2:scope:event"
    );
    expect(first.status).toBe("acquired");
    if (first.status !== "acquired") throw new Error("expected replay lease");

    await expect(
      claimWhatsAppWebhookReplayLease("whatsapp:v2:scope:event")
    ).rejects.toMatchObject({ code: "claim_busy", retryable: true });
    await releaseWhatsAppWebhookReplayLease(first.lease);

    const second = await claimWhatsAppWebhookReplayLease(
      "whatsapp:v2:scope:event"
    );
    expect(second.status).toBe("acquired");
    if (second.status !== "acquired") throw new Error("expected replay lease");
    await expect(
      releaseWhatsAppWebhookReplayLease(first.lease)
    ).rejects.toMatchObject({ code: "lease_mismatch" });

    await completeWhatsAppWebhookReplayLease(second.lease);
    await expect(
      claimWhatsAppWebhookReplayLease("whatsapp:v2:scope:event")
    ).resolves.toEqual({ status: "duplicate" });
    await expect(
      releaseWhatsAppWebhookReplayLease(second.lease)
    ).resolves.toBeUndefined();
  });

  it("retries only the durable fallback after ordinary effects have started", async () => {
    const first = await claimWhatsAppWebhookReplayLease(
      "whatsapp:v2:scope:fallback-event"
    );
    if (first.status !== "acquired") throw new Error("expected replay lease");
    expect(first.lease.mode).toBe("event");

    await markWhatsAppWebhookFallbackPending(first.lease);
    const fallback = await claimWhatsAppWebhookReplayLease(
      "whatsapp:v2:scope:fallback-event"
    );
    if (fallback.status !== "acquired") {
      throw new Error("expected fallback replay lease");
    }
    expect(fallback.lease.mode).toBe("fallback");

    await releaseWhatsAppWebhookReplayLease(fallback.lease);
    const retry = await claimWhatsAppWebhookReplayLease(
      "whatsapp:v2:scope:fallback-event"
    );
    if (retry.status !== "acquired") {
      throw new Error("expected retried fallback replay lease");
    }
    expect(retry.lease.mode).toBe("fallback");

    await completeWhatsAppWebhookReplayLease(retry.lease);
    await expect(
      claimWhatsAppWebhookReplayLease("whatsapp:v2:scope:fallback-event")
    ).resolves.toEqual({ status: "duplicate" });
  });

  it("retains fallback-only recovery across the ingress lease horizon", async () => {
    vi.useFakeTimers();
    const first = await claimWhatsAppWebhookReplayLease(
      "whatsapp:v2:scope:crash-recovery"
    );
    if (first.status !== "acquired") throw new Error("expected replay lease");
    await markWhatsAppWebhookEffectsStarted(first.lease);

    await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1_000);
    const recovered = await claimWhatsAppWebhookReplayLease(
      "whatsapp:v2:scope:crash-recovery"
    );
    if (recovered.status !== "acquired") {
      throw new Error("expected fallback recovery lease");
    }
    expect(recovered.lease.mode).toBe("fallback");
  });

  it("reclaims event mode after only the short pre-effect owner lease expires", async () => {
    vi.useFakeTimers();
    process.env.WHATSAPP_WEBHOOK_REPLAY_LEASE_SECONDS = "3";
    process.env.WEBHOOK_INGRESS_DELIVERY_LEASE_SECONDS = "9";
    const first = await claimWhatsAppWebhookReplayLease(
      "whatsapp:v2:scope:pre-effect-crash"
    );
    if (first.status !== "acquired") throw new Error("expected replay lease");
    expect(first.lease.mode).toBe("event");

    await vi.advanceTimersByTimeAsync(3_001);
    const recovered = await claimWhatsAppWebhookReplayLease(
      "whatsapp:v2:scope:pre-effect-crash"
    );
    if (recovered.status !== "acquired") {
      throw new Error("expected recovered replay lease");
    }
    expect(recovered.lease.mode).toBe("event");
  });

  it("reclaims only fallback after the durable phase transition and owner crash", async () => {
    vi.useFakeTimers();
    process.env.WHATSAPP_WEBHOOK_REPLAY_LEASE_SECONDS = "3";
    process.env.WEBHOOK_INGRESS_DELIVERY_LEASE_SECONDS = "9";
    const first = await claimWhatsAppWebhookReplayLease(
      "whatsapp:v2:scope:post-effect-crash"
    );
    if (first.status !== "acquired") throw new Error("expected replay lease");
    await markWhatsAppWebhookEffectsStarted(first.lease);
    let handlerRuns = 1;

    await vi.advanceTimersByTimeAsync(3_001);
    const recovered = await claimWhatsAppWebhookReplayLease(
      "whatsapp:v2:scope:post-effect-crash"
    );
    if (recovered.status !== "acquired") {
      throw new Error("expected fallback replay lease");
    }
    if (recovered.lease.mode === "event") handlerRuns += 1;
    expect(recovered.lease.mode).toBe("fallback");
    expect(handlerRuns).toBe(1);
  });

  it("keeps completed delivery a duplicate for the full ingress content horizon", async () => {
    vi.useFakeTimers();
    const first = await claimWhatsAppWebhookReplayLease(
      "whatsapp:v2:scope:completed-horizon"
    );
    if (first.status !== "acquired") throw new Error("expected replay lease");
    await completeWhatsAppWebhookReplayLease(first.lease);

    await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1_000);
    await expect(
      claimWhatsAppWebhookReplayLease("whatsapp:v2:scope:completed-horizon")
    ).resolves.toEqual({ status: "duplicate" });
  });

  it("rejects a WhatsApp replay TTL shorter than ingress recovery", async () => {
    process.env.WHATSAPP_WEBHOOK_REPLAY_TTL_SECONDS = "3600";
    process.env.WEBHOOK_INGRESS_CONTENT_TTL_SECONDS = "7200";
    await expect(
      claimWhatsAppWebhookReplayLease("whatsapp:v2:scope:short-replay")
    ).rejects.toThrow(
      "WHATSAPP_WEBHOOK_REPLAY_TTL_SECONDS must cover the ingress recovery horizon"
    );
  });

  it("rejects an owner lease longer than the ingress delivery lease", async () => {
    process.env.WHATSAPP_WEBHOOK_REPLAY_LEASE_SECONDS = "901";
    process.env.WEBHOOK_INGRESS_DELIVERY_LEASE_SECONDS = "900";
    await expect(
      claimWhatsAppWebhookReplayLease("whatsapp:v2:scope:long-owner")
    ).rejects.toThrow(
      "WHATSAPP_WEBHOOK_REPLAY_LEASE_SECONDS must be at least 3 and no longer than the ingress delivery lease"
    );
  });

  it("heartbeats a long processing lease so an expired duplicate stays busy", async () => {
    vi.useFakeTimers();
    process.env.WEBHOOK_REPLAY_TTL_SECONDS = "3";
    process.env.WHATSAPP_WEBHOOK_REPLAY_TTL_SECONDS = "9";
    process.env.WHATSAPP_WEBHOOK_REPLAY_LEASE_SECONDS = "3";
    process.env.WEBHOOK_INGRESS_CONTENT_TTL_SECONDS = "9";
    process.env.WEBHOOK_INGRESS_DELIVERY_LEASE_SECONDS = "3";
    process.env.WEBHOOK_INGRESS_MAX_ATTEMPTS = "3";
    const claim = await claimWhatsAppWebhookReplayLease(
      "whatsapp:v2:scope:long-event"
    );
    if (claim.status !== "acquired") throw new Error("expected replay lease");

    let finish!: () => void;
    const processing = runWithWhatsAppWebhookReplayLeaseHeartbeat(
      claim.lease,
      async () =>
        await new Promise<void>(resolve => {
          finish = resolve;
        })
    );
    await vi.advanceTimersByTimeAsync(7_000);

    await expect(
      claimWhatsAppWebhookReplayLease("whatsapp:v2:scope:long-event")
    ).rejects.toMatchObject({ code: "claim_busy", retryable: true });
    finish();
    await processing;
    await completeWhatsAppWebhookReplayLease(claim.lease);
    await expect(
      claimWhatsAppWebhookReplayLease("whatsapp:v2:scope:long-event")
    ).resolves.toEqual({ status: "duplicate" });
  });

  it.each(["0.5", "1", "2", "3.5"])(
    "fails closed for an unsafe replay TTL of %s seconds",
    async configuredTtl => {
      process.env.WEBHOOK_REPLAY_TTL_SECONDS = configuredTtl;
      await expect(
        claimWebhookReplayKey("messenger:unsafe-ttl")
      ).rejects.toThrow(
        "WEBHOOK_REPLAY_TTL_SECONDS must be an integer of at least 3"
      );
    }
  );

  it("uses owner-checked Redis transitions and accepts legacy completed keys", async () => {
    const values = new Map<string, string>();
    const set = vi.fn(
      async (key: string, value: string): Promise<"OK" | null> => {
        if (values.has(key)) return null;
        values.set(key, value);
        return "OK";
      }
    );
    const get = vi.fn(async (key: string) => values.get(key) ?? null);
    const evalCommand = vi.fn(
      async (script: string, keys: number, ...args: unknown[]) => {
        const [key] = args.slice(0, keys).map(String);
        const argv = args.slice(keys).map(String);
        if (script.includes("return 4")) {
          const current = values.get(key!);
          if (current === "1" || current?.startsWith("completed:")) return 3;
          const deadline = Date.now() + Number(argv[3]);
          if (current === undefined) {
            values.set(key!, `${argv[1]}${argv[0]}:${deadline}`);
            return 1;
          }
          if (current === argv[5]) {
            values.set(key!, `${argv[2]}${argv[0]}:${deadline}`);
            return 2;
          }
          if (/^(event|fallback):wr1\.[0-9a-f]{32}:\d+$/.test(current)) {
            return 4;
          }
          return -1;
        }
        const current = values.get(key!);
        if (script.includes("ARGV[2] .. ARGV[1]")) {
          if (current?.startsWith("completed:")) return 2;
          if (current?.includes(argv[0]!)) {
            values.set(key!, `${argv[1]}${argv[0]}`);
            return 1;
          }
          return current === undefined ? 0 : -1;
        }
        if (script.includes('ARGV[2], "EX", ARGV[3]')) {
          if (current === argv[1]) return 2;
          if (current?.includes(argv[0]!)) {
            values.set(key!, argv[1]!);
            return 1;
          }
          return current === undefined ? 0 : -1;
        }
        throw new Error("unexpected Redis script in fixture");
      }
    );
    const ownerTokens = [
      createWhatsAppWebhookReplayOwnerToken(),
      createWhatsAppWebhookReplayOwnerToken(),
    ];
    const deps = {
      createOwnerToken: () => {
        const token = ownerTokens.shift();
        if (!token) throw new Error("owner token fixture exhausted");
        return token;
      },
      getRedisClient: async () => ({ eval: evalCommand, get, set }),
      isRedisEnabled: () => true,
    } satisfies WhatsAppWebhookReplayDeps;

    const first = await claimWhatsAppWebhookReplayLeaseWithDeps({
      key: "whatsapp:v2:scope:redis-event",
      deps,
    });
    if (first.status !== "acquired") throw new Error("expected replay lease");
    await expect(set(first.lease.replayKey, "1")).resolves.toBeNull();
    await markWhatsAppWebhookFallbackPendingWithDeps({
      lease: first.lease,
      deps,
    });
    const second = await claimWhatsAppWebhookReplayLeaseWithDeps({
      key: "whatsapp:v2:scope:redis-event",
      deps,
    });
    if (second.status !== "acquired") throw new Error("expected replay lease");
    expect(second.lease.mode).toBe("fallback");
    await completeWhatsAppWebhookReplayLeaseWithDeps({
      lease: second.lease,
      deps,
    });
    expect(values.get(second.lease.replayKey)).toBe(
      `completed:${second.lease.ownerToken}`
    );

    values.set("webhook-replay:whatsapp:v2:scope:legacy-event", "1");
    await expect(
      claimWhatsAppWebhookReplayLeaseWithDeps({
        key: "whatsapp:v2:scope:legacy-event",
        deps: {
          ...deps,
          createOwnerToken: createWhatsAppWebhookReplayOwnerToken,
        },
      })
    ).resolves.toEqual({ status: "duplicate" });
  });
});
