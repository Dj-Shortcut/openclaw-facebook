import { describe, expect, it, vi } from "vitest";
import {
  createConversationBoundaryEnvelopeV2WithKey,
  verifyQueuedConversationBoundaryEnvelopeV2WithDeps,
  verifyConversationBoundaryEnvelopeV2WithDeps,
  type VerifiedQueuedConversationBoundaryV2,
} from "./_core/conversationBoundaryEnvelope";
import {
  parseConversationIdentityConfig,
  type ConversationIdentityKey,
} from "./_core/conversationIdentityConfig";
import {
  resolveConversationSenderId,
  resolveMessengerEndpoint,
  resolveWhatsAppEndpoint,
  type ConversationEndpoint,
  type ConversationSenderId,
} from "./_core/conversationEndpoint";
import type { ResolvedConversationIdentityV2 } from "./_core/conversationIdentityResolver";
import { deriveConversationSubjectV2 } from "./_core/conversationSubject";
import {
  WebhookReplayV2Error,
  claimWebhookReplayV2WithDeps,
  completeWebhookReplayV2WithDeps,
  createWebhookReplayLeaseOwnerTokenV2,
  ensureWebhookReplayV2ReadyWithDeps,
  parseWebhookReplayClaimIdV2,
  type WebhookReplayClaimResultV2,
  type WebhookReplayEventIdentityV2,
  type WebhookReplayLeaseV2,
  type WebhookReplayV2Deps,
  type WebhookReplayV2ErrorCode,
} from "./_core/webhookReplayProtectionV2";

const KEY = parseConversationIdentityConfig({
  CONVERSATION_SCOPE_HMAC_KEY_ID: "k1",
  CONVERSATION_SCOPE_HMAC_SECRET: "44".repeat(32),
});
const KEY_V2 = parseConversationIdentityConfig({
  CONVERSATION_SCOPE_HMAC_KEY_ID: "k2",
  CONVERSATION_SCOPE_HMAC_SECRET: "55".repeat(32),
});
const MESSENGER_ENDPOINT = resolveMessengerEndpoint({
  entryId: "123456789012345",
});
const MESSENGER_SENDER = resolveConversationSenderId("987654321098765");
const PAYLOAD = Buffer.from('{"messageId":"mid-1"}', "utf8");
const CLAIM_ID = parseWebhookReplayClaimIdV2(`rc2.${"11".repeat(16)}`);
const OTHER_CLAIM_ID = parseWebhookReplayClaimIdV2(`rc2.${"22".repeat(16)}`);
const OWNER_TOKEN = createWebhookReplayLeaseOwnerTokenV2();
const OTHER_OWNER_TOKEN = createWebhookReplayLeaseOwnerTokenV2();
const THIRD_OWNER_TOKEN = createWebhookReplayLeaseOwnerTokenV2();
const FOURTH_OWNER_TOKEN = createWebhookReplayLeaseOwnerTokenV2();
const FIFTH_OWNER_TOKEN = createWebhookReplayLeaseOwnerTokenV2();
const SIXTH_OWNER_TOKEN = createWebhookReplayLeaseOwnerTokenV2();

function resolvedIdentity(
  input: {
    endpoint?: ConversationEndpoint;
    senderId?: ConversationSenderId;
    workspaceId?: number;
    channelConnectionId?: number;
    key?: ConversationIdentityKey;
    ownerToken?: typeof OWNER_TOKEN;
    ownerTokenError?: Error;
  } = {}
): ResolvedConversationIdentityV2 {
  const endpoint = input.endpoint ?? MESSENGER_ENDPOINT;
  const senderId = input.senderId ?? MESSENGER_SENDER;
  const workspaceId = input.workspaceId ?? 42;
  const channelConnectionId = input.channelConnectionId ?? 7;
  const subject = deriveConversationSubjectV2({
    workspaceId,
    channelConnectionId,
    endpoint,
    senderId,
    key: input.key ?? KEY,
  });
  const delivery =
    endpoint.channel === "messenger"
      ? Object.freeze({
          channel: "messenger" as const,
          channelConnectionId,
          pageId: endpoint.pageId,
          senderId,
        })
      : Object.freeze({
          channel: "whatsapp" as const,
          channelConnectionId,
          wabaId: endpoint.wabaId,
          phoneNumberId: endpoint.phoneNumberId,
          senderId,
        });
  return Object.freeze({
    subject,
    delivery,
    connectionStatus: "connected" as const,
  });
}

async function verifiedBoundary(
  input: {
    endpoint?: ConversationEndpoint;
    senderId?: ConversationSenderId;
    workspaceId?: number;
    channelConnectionId?: number;
    key?: ConversationIdentityKey;
  } = {}
): Promise<VerifiedQueuedConversationBoundaryV2> {
  const endpoint = input.endpoint ?? MESSENGER_ENDPOINT;
  const senderId = input.senderId ?? MESSENGER_SENDER;
  const key = input.key ?? KEY;
  const identity = resolvedIdentity({ ...input, endpoint, senderId, key });
  const payloadKind =
    endpoint.channel === "messenger"
      ? "meta_messenger_event"
      : "meta_whatsapp_message";
  const envelope = createConversationBoundaryEnvelopeV2WithKey({
    subject: identity.subject,
    payloadKind,
    endpoint,
    senderId,
    payload: PAYLOAD,
    key,
  });
  return await verifyQueuedConversationBoundaryEnvelopeV2WithDeps({
    envelope,
    expectedPayloadKind: payloadKind,
    endpoint,
    senderId,
    payload: PAYLOAD,
    expectedScope: {
      tenantKey: envelope.tenantKey,
      bindingKey: envelope.bindingKey,
    },
    deps: {
      getIdentityKey: () => key,
      resolveIdentity: vi.fn(async () => identity),
    },
  });
}

function replayDeps(
  input: {
    key?: ConversationIdentityKey;
    redisEnabled?: boolean;
    getResult?: string | null;
    getError?: Error;
    evalResult?: unknown;
    evalError?: Error;
    setResult?: unknown;
    setError?: Error;
    pingResult?: string;
    pingError?: Error;
    clientError?: Error;
  } = {}
) {
  const get = vi.fn(async (): Promise<string | null> => {
    if (input.getError) {
      throw input.getError;
    }
    return input.getResult ?? null;
  });
  const set = vi.fn(
    async (
      _key: string,
      _value: string,
      ..._args: Array<string | number>
    ): Promise<unknown> => {
      if (input.setError) {
        throw input.setError;
      }
      return input.setResult === undefined ? "OK" : input.setResult;
    }
  );
  const evalCommand = vi.fn(async (): Promise<unknown> => {
    if (input.evalError) {
      throw input.evalError;
    }
    return input.evalResult ?? 1;
  });
  const ping = vi.fn(async (): Promise<string> => {
    if (input.pingError) {
      throw input.pingError;
    }
    return input.pingResult ?? "PONG";
  });
  const deps = {
    getIdentityKey: () => input.key ?? KEY,
    createLeaseOwnerToken: () => {
      if (input.ownerTokenError) {
        throw input.ownerTokenError;
      }
      return input.ownerToken ?? OWNER_TOKEN;
    },
    isRedisEnabled: () => input.redisEnabled ?? true,
    getRedisClient: async () => {
      if (input.clientError) {
        throw input.clientError;
      }
      return { eval: evalCommand, get, ping, set };
    },
  } satisfies WebhookReplayV2Deps;
  return { deps, evalCommand, get, ping, set };
}

async function expectAcquiredClaim(
  claim: Promise<WebhookReplayClaimResultV2>
): Promise<WebhookReplayLeaseV2> {
  const result = await claim;
  expect(result.status).toBe("acquired");
  if (result.status !== "acquired") {
    throw new Error("expected an acquired V2 replay claim");
  }
  return result.lease;
}

async function expectReplayError(
  callback: () => Promise<unknown>,
  code: WebhookReplayV2ErrorCode,
  retryable = false,
  rawValues: readonly string[] = []
): Promise<void> {
  let caught: unknown;
  try {
    await callback();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WebhookReplayV2Error);
  expect(caught).toMatchObject({
    name: "WebhookReplayV2Error",
    code,
    retryable,
    message: "Webhook replay protection is unavailable",
  });
  const serialized = JSON.stringify(caught);
  for (const rawValue of rawValues) {
    expect(serialized).not.toContain(rawValue);
  }
}

describe("V2 webhook replay protection", () => {
  it("claims one exact tenant-scoped Redis key with a bounded TTL", async () => {
    const verified = await verifiedBoundary();
    const { deps, set } = replayDeps();

    const lease = await expectAcquiredClaim(
      claimWebhookReplayV2WithDeps({
        verified,
        eventIdentity: { kind: "meta_message_id", id: "mid.$private-1" },
        replayClaimId: CLAIM_ID,
        deps,
      })
    );
    expect(lease.replayClaimId).toBe(CLAIM_ID);
    expect(lease.leaseOwnerToken).toBe(OWNER_TOKEN);

    expect(set).toHaveBeenCalledOnce();
    expect(set).toHaveBeenCalledWith(
      expect.stringMatching(
        /^webhook-replay:v2:\{b2\.k1\.[0-9a-f]{64}\}:e2\.k1\.[0-9a-f]{64}$/
      ),
      `processing:${CLAIM_ID}:${OWNER_TOKEN}`,
      "EX",
      30,
      "NX"
    );
    const redisKey = String(set.mock.calls[0]?.[0]);
    expect(redisKey).toContain(`{${verified.envelope.bindingKey}}`);
    expect(redisKey).not.toContain(MESSENGER_ENDPOINT.pageId);
    expect(redisKey).not.toContain(MESSENGER_SENDER);
    expect(redisKey).not.toContain("mid.$private-1");
    expect(redisKey).not.toContain(verified.envelope.tenantKey);
    expect(redisKey).not.toContain(verified.envelope.userKey);

    const reflectedClone = { ...lease };
    for (const symbol of Object.getOwnPropertySymbols(lease)) {
      Object.defineProperty(reflectedClone, symbol, {
        value: Reflect.get(lease, symbol),
      });
    }
    const completion = replayDeps();
    await expectReplayError(
      () =>
        completeWebhookReplayV2WithDeps({
          lease: reflectedClone as WebhookReplayLeaseV2,
          deps: completion.deps,
        }),
      "invalid_lease"
    );
    expect(completion.evalCommand).not.toHaveBeenCalled();
  });

  it("returns duplicate only for an explicitly completed claim", async () => {
    const verified = await verifiedBoundary();
    const { deps } = replayDeps({
      setResult: null,
      getResult: `completed:${OTHER_CLAIM_ID}:${OTHER_OWNER_TOKEN}`,
    });

    await expect(
      claimWebhookReplayV2WithDeps({
        verified,
        eventIdentity: { kind: "meta_message_id", id: "wamid.duplicate" },
        replayClaimId: CLAIM_ID,
        deps,
      })
    ).resolves.toEqual({ status: "duplicate" });
  });

  it("does not treat a pre-existing V1 namespace claim as a V2 claim", async () => {
    const verified = await verifiedBoundary();
    const stored = new Map<string, string>([
      ["webhook-replay:mid:same-event-id", "1"],
      ["webhook-replay:whatsapp:legacy-user:same-event-id", "1"],
    ]);
    const get = vi.fn(async (key: string) => stored.get(key) ?? null);
    const set = vi.fn(async (key: string, value: string) => {
      if (stored.has(key)) {
        return null;
      }
      stored.set(key, value);
      return "OK";
    });
    const deps = {
      getIdentityKey: () => KEY,
      createLeaseOwnerToken: () => OWNER_TOKEN,
      isRedisEnabled: () => true,
      getRedisClient: async () => ({
        eval: vi.fn(),
        get,
        ping: vi.fn(async () => "PONG"),
        set,
      }),
    } satisfies WebhookReplayV2Deps;

    await expectAcquiredClaim(
      claimWebhookReplayV2WithDeps({
        verified,
        eventIdentity: { kind: "meta_message_id", id: "same-event-id" },
        replayClaimId: CLAIM_ID,
        deps,
      })
    );

    const v2Key = String(set.mock.calls[0]?.[0]);
    expect(v2Key).toMatch(/^webhook-replay:v2:/);
    expect(get).not.toHaveBeenCalled();
    expect(stored.get("webhook-replay:mid:same-event-id")).toBe("1");
    expect(
      stored.get("webhook-replay:whatsapp:legacy-user:same-event-id")
    ).toBe("1");
    expect(stored.get(v2Key)).toBe(`processing:${CLAIM_ID}:${OWNER_TOKEN}`);
  });

  it("isolates the same provider event across tenant, binding, channel, and sender", async () => {
    const whatsAppEndpoint = resolveWhatsAppEndpoint({
      wabaId: "223456789012345",
      phoneNumberId: "323456789012345",
    });
    const otherMessengerEndpoint = resolveMessengerEndpoint({
      entryId: "123456789012346",
    });
    const otherWhatsAppEndpoint = resolveWhatsAppEndpoint({
      wabaId: "223456789012346",
      phoneNumberId: "323456789012346",
    });
    const variants = [
      await verifiedBoundary(),
      await verifiedBoundary({ workspaceId: 43 }),
      await verifiedBoundary({ channelConnectionId: 8 }),
      await verifiedBoundary({
        senderId: resolveConversationSenderId("887654321098765"),
      }),
      await verifiedBoundary({
        endpoint: whatsAppEndpoint,
        senderId: resolveConversationSenderId("447700900123"),
      }),
      await verifiedBoundary({ endpoint: otherMessengerEndpoint }),
      await verifiedBoundary({
        endpoint: otherWhatsAppEndpoint,
        senderId: resolveConversationSenderId("447700900123"),
      }),
    ];
    const keys: string[] = [];
    for (const verified of variants) {
      const { deps, set } = replayDeps();
      await claimWebhookReplayV2WithDeps({
        verified,
        eventIdentity: { kind: "meta_message_id", id: "same-event-id" },
        replayClaimId: CLAIM_ID,
        deps,
      });
      keys.push(String(set.mock.calls[0]?.[0]));
    }

    expect(new Set(keys).size).toBe(variants.length);
    const baselineSlot = keys[0]?.match(/\{([^}]+)\}/)?.[1];
    const otherSenderSlot = keys[3]?.match(/\{([^}]+)\}/)?.[1];
    expect(otherSenderSlot).toBe(baselineSlot);
  });

  it("purpose-separates Meta IDs from canonical fallback digests", async () => {
    const verified = await verifiedBoundary();
    const raw = "a".repeat(32);
    const keys: string[] = [];
    for (const eventIdentity of [
      { kind: "meta_message_id", id: raw },
      {
        kind: "canonical_fallback_sha256",
        digest: raw.repeat(2),
      },
    ] satisfies WebhookReplayEventIdentityV2[]) {
      const { deps, set } = replayDeps();
      await claimWebhookReplayV2WithDeps({
        verified,
        eventIdentity,
        replayClaimId: CLAIM_ID,
        deps,
      });
      keys.push(String(set.mock.calls[0]?.[0]));
    }
    expect(keys[0]).not.toBe(keys[1]);
  });

  it.each([
    { kind: "meta_message_id", id: "" },
    { kind: "meta_message_id", id: "contains space" },
    { kind: "meta_message_id", id: "line\nbreak" },
    { kind: "meta_message_id", id: "é" },
    { kind: "meta_message_id", id: "a".repeat(1_025) },
    { kind: "canonical_fallback_sha256", digest: Buffer.alloc(32) },
    { kind: "canonical_fallback_sha256", digest: "a".repeat(63) },
    { kind: "canonical_fallback_sha256", digest: "A".repeat(64) },
    { kind: "canonical_fallback_sha256", digest: "g".repeat(64) },
    { kind: "unknown", id: "mid-1" },
  ])("rejects invalid event identity %# before Redis", async eventIdentity => {
    const verified = await verifiedBoundary();
    const { deps, set } = replayDeps();

    await expectReplayError(
      () =>
        claimWebhookReplayV2WithDeps({
          verified,
          eventIdentity: eventIdentity as WebhookReplayEventIdentityV2,
          replayClaimId: CLAIM_ID,
          deps,
        }),
      "invalid_event_identity"
    );
    expect(set).not.toHaveBeenCalled();
  });

  it.each(["", "11", "A".repeat(32), "g".repeat(32), "11".repeat(17)])(
    "rejects invalid claim token %# before Redis",
    async replayClaimId => {
      const verified = await verifiedBoundary();
      const { deps, set } = replayDeps();

      await expectReplayError(
        () =>
          claimWebhookReplayV2WithDeps({
            verified,
            eventIdentity: { kind: "meta_message_id", id: "mid-token" },
            replayClaimId: replayClaimId as typeof CLAIM_ID,
            deps,
          }),
        "invalid_claim_id"
      );
      expect(set).not.toHaveBeenCalled();
    }
  );

  it("fails retryably when a fresh lease owner cannot be created", async () => {
    const verified = await verifiedBoundary();
    const rawError = "entropy raw sentinel";
    const { deps, set } = replayDeps({
      ownerTokenError: new Error(rawError),
    });

    await expectReplayError(
      () =>
        claimWebhookReplayV2WithDeps({
          verified,
          eventIdentity: { kind: "meta_message_id", id: "mid-owner-error" },
          replayClaimId: CLAIM_ID,
          deps,
        }),
      "lease_owner_unavailable",
      true,
      [rawError]
    );
    expect(set).not.toHaveBeenCalled();
  });

  it("rejects forged and genuinely verified but unscoped boundaries", async () => {
    const verified = await verifiedBoundary();
    const { deps, set } = replayDeps();

    await expectReplayError(
      () =>
        claimWebhookReplayV2WithDeps({
          verified: {
            envelope: verified.envelope,
            identity: verified.identity,
          } as VerifiedQueuedConversationBoundaryV2,
          eventIdentity: { kind: "meta_message_id", id: "mid-forged" },
          replayClaimId: CLAIM_ID,
          deps,
        }),
      "invalid_verified_boundary"
    );
    const generic = await verifyConversationBoundaryEnvelopeV2WithDeps({
      envelope: verified.envelope,
      expectedPayloadKind: "meta_messenger_event",
      endpoint: MESSENGER_ENDPOINT,
      senderId: MESSENGER_SENDER,
      payload: PAYLOAD,
      deps: {
        getIdentityKey: () => KEY,
        resolveIdentity: async () => verified.identity,
      },
    });
    await expectReplayError(
      () =>
        claimWebhookReplayV2WithDeps({
          verified: generic as unknown as VerifiedQueuedConversationBoundaryV2,
          eventIdentity: { kind: "meta_message_id", id: "mid-unscoped" },
          replayClaimId: CLAIM_ID,
          deps,
        }),
      "invalid_verified_boundary"
    );
    expect(set).not.toHaveBeenCalled();
  });

  it("rejects key-epoch mismatch and key configuration failure before Redis", async () => {
    const verified = await verifiedBoundary();
    const mismatched = replayDeps({ key: KEY_V2 });
    await expectReplayError(
      () =>
        claimWebhookReplayV2WithDeps({
          verified,
          eventIdentity: { kind: "meta_message_id", id: "mid-key-epoch" },
          replayClaimId: CLAIM_ID,
          deps: mismatched.deps,
        }),
      "identity_key_mismatch"
    );
    expect(mismatched.set).not.toHaveBeenCalled();

    const set = vi.fn();
    await expectReplayError(
      () =>
        claimWebhookReplayV2WithDeps({
          verified,
          eventIdentity: { kind: "meta_message_id", id: "mid-key-error" },
          replayClaimId: CLAIM_ID,
          deps: {
            getIdentityKey: () => {
              throw new Error("secret backend failure");
            },
            createLeaseOwnerToken: () => OWNER_TOKEN,
            isRedisEnabled: () => true,
            getRedisClient: async () => ({
              eval: vi.fn(),
              get: vi.fn(async () => null),
              ping: vi.fn(async () => "PONG"),
              set,
            }),
          },
        }),
      "identity_key_unavailable",
      true,
      ["secret backend failure"]
    );
    expect(set).not.toHaveBeenCalled();
  });

  it("requires Redis in every environment and never uses a memory fallback", async () => {
    const verified = await verifiedBoundary();
    const { deps, set } = replayDeps({ redisEnabled: false });

    await expectReplayError(
      () =>
        claimWebhookReplayV2WithDeps({
          verified,
          eventIdentity: { kind: "meta_message_id", id: "mid-no-redis" },
          replayClaimId: CLAIM_ID,
          deps,
        }),
      "store_unavailable",
      true
    );
    expect(set).not.toHaveBeenCalled();
  });

  it("recovers one owned lease when an ambiguous SET is readable", async () => {
    const verified = await verifiedBoundary();
    const { deps, get } = replayDeps({
      setError: new Error("set response lost"),
      getResult: `processing:${CLAIM_ID}:${OWNER_TOKEN}`,
    });

    const lease = await expectAcquiredClaim(
      claimWebhookReplayV2WithDeps({
        verified,
        eventIdentity: { kind: "meta_message_id", id: "mid-owned" },
        replayClaimId: CLAIM_ID,
        deps,
      })
    );

    expect(lease).toMatchObject({
      replayClaimId: CLAIM_ID,
      leaseOwnerToken: OWNER_TOKEN,
    });
    expect(get).toHaveBeenCalledOnce();
  });

  it("never acquires an existing exact owner after an unambiguous NX miss", async () => {
    const verified = await verifiedBoundary();
    const { deps } = replayDeps({
      setResult: null,
      getResult: `processing:${CLAIM_ID}:${OWNER_TOKEN}`,
    });

    await expectReplayError(
      () =>
        claimWebhookReplayV2WithDeps({
          verified,
          eventIdentity: { kind: "meta_message_id", id: "mid-nx-miss" },
          replayClaimId: CLAIM_ID,
          deps,
        }),
      "claim_busy",
      true
    );
  });

  it("never mistakes an ambiguous processing lease for completed work", async () => {
    const verified = await verifiedBoundary();
    const stored = new Map<string, string>();
    let loseFirstSetResponse = true;
    let loseFirstReadResponse = true;
    let loseFirstCompletionResponse = true;
    const get = vi.fn(async (key: string) => {
      if (loseFirstReadResponse) {
        loseFirstReadResponse = false;
        throw new Error("first reconciliation read lost");
      }
      return stored.get(key) ?? null;
    });
    const set = vi.fn(async (key: string, value: string) => {
      if (stored.has(key)) {
        return null;
      }
      stored.set(key, value);
      if (loseFirstSetResponse) {
        loseFirstSetResponse = false;
        throw new Error("first set response lost");
      }
      return "OK";
    });
    const evalCommand = vi.fn(
      async (
        _script: string,
        _numberOfKeys: number,
        key: string,
        processing: string | number,
        completed: string | number
      ) => {
        const current = stored.get(key);
        if (current === processing) {
          stored.set(key, String(completed));
          if (loseFirstCompletionResponse) {
            loseFirstCompletionResponse = false;
            throw new Error("completion response lost");
          }
          return 1;
        }
        if (current === completed) {
          return 2;
        }
        return current === undefined ? 0 : -1;
      }
    );
    const ownerTokens = [
      OWNER_TOKEN,
      OTHER_OWNER_TOKEN,
      THIRD_OWNER_TOKEN,
      FOURTH_OWNER_TOKEN,
      FIFTH_OWNER_TOKEN,
      SIXTH_OWNER_TOKEN,
    ];
    const deps = {
      getIdentityKey: () => KEY,
      createLeaseOwnerToken: () => {
        const ownerToken = ownerTokens.shift();
        if (!ownerToken) {
          throw new Error("owner token fixture exhausted");
        }
        return ownerToken;
      },
      isRedisEnabled: () => true,
      getRedisClient: async () => ({
        eval: evalCommand,
        get,
        ping: vi.fn(async () => "PONG"),
        set,
      }),
    } satisfies WebhookReplayV2Deps;
    const claim = (replayClaimId: typeof CLAIM_ID) =>
      claimWebhookReplayV2WithDeps({
        verified,
        eventIdentity: { kind: "meta_message_id", id: "mid-ambiguous" },
        replayClaimId,
        deps,
      });

    await expectReplayError(() => claim(CLAIM_ID), "store_unavailable", true);
    const replayKey = String(set.mock.calls[0]?.[0]);
    expect(stored.get(replayKey)).toBe(`processing:${CLAIM_ID}:${OWNER_TOKEN}`);

    await expectReplayError(
      () => claim(OTHER_CLAIM_ID as typeof CLAIM_ID),
      "claim_busy",
      true
    );
    await expectReplayError(() => claim(CLAIM_ID), "claim_busy", true);

    stored.delete(replayKey);
    const staleLease = await expectAcquiredClaim(claim(CLAIM_ID));
    expect(staleLease.leaseOwnerToken).toBe(FOURTH_OWNER_TOKEN);
    stored.delete(replayKey);
    const lease = await expectAcquiredClaim(claim(CLAIM_ID));
    expect(lease.leaseOwnerToken).toBe(FIFTH_OWNER_TOKEN);

    await expectReplayError(
      () => completeWebhookReplayV2WithDeps({ lease: staleLease, deps }),
      "lease_mismatch"
    );
    await expect(
      completeWebhookReplayV2WithDeps({ lease, deps })
    ).resolves.toBeUndefined();
    expect(evalCommand).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('redis.call("SET", KEYS[1]'),
      1,
      replayKey,
      `processing:${CLAIM_ID}:${FIFTH_OWNER_TOKEN}`,
      `completed:${CLAIM_ID}:${FIFTH_OWNER_TOKEN}`,
      300
    );
    expect(stored.get(replayKey)).toBe(
      `completed:${CLAIM_ID}:${FIFTH_OWNER_TOKEN}`
    );
    await expectReplayError(
      () => completeWebhookReplayV2WithDeps({ lease: staleLease, deps }),
      "lease_mismatch"
    );
    await expect(
      completeWebhookReplayV2WithDeps({ lease, deps })
    ).resolves.toBeUndefined();
    await expect(claim(OTHER_CLAIM_ID as typeof CLAIM_ID)).resolves.toEqual({
      status: "duplicate",
    });
  });

  it("fails closed when a completion loses or mismatches its processing lease", async () => {
    const verified = await verifiedBoundary();
    const acquired = replayDeps();
    const lease = await expectAcquiredClaim(
      claimWebhookReplayV2WithDeps({
        verified,
        eventIdentity: { kind: "meta_message_id", id: "mid-completion" },
        replayClaimId: CLAIM_ID,
        deps: acquired.deps,
      })
    );

    const lost = replayDeps({ evalResult: 0 });
    await expectReplayError(
      () => completeWebhookReplayV2WithDeps({ lease, deps: lost.deps }),
      "lease_lost",
      true
    );

    const mismatched = replayDeps({ evalResult: -1 });
    await expectReplayError(
      () => completeWebhookReplayV2WithDeps({ lease, deps: mismatched.deps }),
      "lease_mismatch"
    );

    const unexpected = replayDeps({
      evalResult: "QUEUED",
      getResult: `processing:${CLAIM_ID}:${OWNER_TOKEN}`,
    });
    await expectReplayError(
      () => completeWebhookReplayV2WithDeps({ lease, deps: unexpected.deps }),
      "invalid_store_response",
      true
    );

    await expectReplayError(
      () =>
        completeWebhookReplayV2WithDeps({
          lease: {} as WebhookReplayLeaseV2,
          deps: acquired.deps,
        }),
      "invalid_lease"
    );
  });

  it("fails closed and retryably on unresolved Redis ambiguity", async () => {
    const verified = await verifiedBoundary();
    const rawStoreError = "redis failed for raw-message-sentinel";
    const failed = replayDeps({ setError: new Error(rawStoreError) });
    await expectReplayError(
      () =>
        claimWebhookReplayV2WithDeps({
          verified,
          eventIdentity: {
            kind: "meta_message_id",
            id: "raw-message-sentinel",
          },
          replayClaimId: CLAIM_ID,
          deps: failed.deps,
        }),
      "store_unavailable",
      true,
      [rawStoreError, "raw-message-sentinel"]
    );

    const unexpected = replayDeps({ setResult: "QUEUED" });
    await expectReplayError(
      () =>
        claimWebhookReplayV2WithDeps({
          verified,
          eventIdentity: { kind: "meta_message_id", id: "mid-unexpected" },
          replayClaimId: CLAIM_ID,
          deps: unexpected.deps,
        }),
      "invalid_store_response",
      true
    );

    const invalidOwner = replayDeps({ setResult: null, getResult: "1" });
    await expectReplayError(
      () =>
        claimWebhookReplayV2WithDeps({
          verified,
          eventIdentity: { kind: "meta_message_id", id: "mid-invalid-owner" },
          replayClaimId: CLAIM_ID,
          deps: invalidOwner.deps,
        }),
      "invalid_store_response",
      true
    );
  });

  it("produces a stable digest for the same verified subject and event", async () => {
    const verified = await verifiedBoundary();
    const keys: string[] = [];
    for (let index = 0; index < 2; index += 1) {
      const { deps, set } = replayDeps();
      await claimWebhookReplayV2WithDeps({
        verified,
        eventIdentity: { kind: "meta_message_id", id: "mid-stable" },
        replayClaimId: CLAIM_ID,
        deps,
      });
      keys.push(String(set.mock.calls[0]?.[0]));
    }
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toBe(
      "webhook-replay:v2:{b2.k1.3ec79ce0c84c36cf346ac0a8a3a2c39e8b33a95424bd0ad79044f9811e142a57}:e2.k1.988619b5691284be1788a2249765ac80bbc2f6b8d21cc8e901aae5dbe934508f"
    );
  });

  it("requires a healthy Redis response before V2 activation", async () => {
    const disabled = replayDeps({ redisEnabled: false });
    await expectReplayError(
      () => ensureWebhookReplayV2ReadyWithDeps(disabled.deps),
      "store_unavailable",
      true
    );
    expect(disabled.ping).not.toHaveBeenCalled();

    const unavailable = replayDeps({ clientError: new Error("no client") });
    await expectReplayError(
      () => ensureWebhookReplayV2ReadyWithDeps(unavailable.deps),
      "store_unavailable",
      true
    );

    const failedPing = replayDeps({ pingError: new Error("ping failed") });
    await expectReplayError(
      () => ensureWebhookReplayV2ReadyWithDeps(failedPing.deps),
      "store_unavailable",
      true
    );

    const unexpectedPing = replayDeps({ pingResult: "LOADING" });
    await expectReplayError(
      () => ensureWebhookReplayV2ReadyWithDeps(unexpectedPing.deps),
      "invalid_store_response",
      true
    );

    const failedEval = replayDeps({ evalError: new Error("eval denied") });
    await expectReplayError(
      () => ensureWebhookReplayV2ReadyWithDeps(failedEval.deps),
      "store_unavailable",
      true
    );

    const unexpectedEval = replayDeps({ evalResult: "1" });
    await expectReplayError(
      () => ensureWebhookReplayV2ReadyWithDeps(unexpectedEval.deps),
      "invalid_store_response",
      true
    );

    const ready = replayDeps();
    await expect(
      ensureWebhookReplayV2ReadyWithDeps(ready.deps)
    ).resolves.toBeUndefined();
    expect(ready.ping).toHaveBeenCalledOnce();
    expect(ready.evalCommand).toHaveBeenCalledWith("return 1", 0);
  });
});
