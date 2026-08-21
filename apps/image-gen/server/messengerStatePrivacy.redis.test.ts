import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  storageDelete: vi.fn(async () => undefined),
  beginSubject: vi.fn(async () => 7),
  completeSubject: vi.fn(async () => undefined),
  completeJob: vi.fn(async () => undefined),
  reschedule: vi.fn(async () => undefined),
  eraseBilling: vi.fn(async () => 0),
  eraseIngress: vi.fn(async () => undefined),
  eraseGeneration: vi.fn(async () => 0),
  containProvider: vi.fn(async () => true),
  eraseCost: vi.fn(async () => 0),
}));

vi.mock("./storage", async importOriginal => {
  const actual = await importOriginal<typeof import("./storage")>();
  return { ...actual, storageDelete: mocks.storageDelete };
});
vi.mock("./_core/messengerPrivacySubject", () => ({
  beginMessengerPrivacyErasure: mocks.beginSubject,
  completeMessengerPrivacyErasure: mocks.completeSubject,
  isMessengerPrivacyErasureComplete: vi.fn(async () => false),
  assertMessengerPrivacySubject: vi.fn(async () => undefined),
}));
vi.mock("./_core/workspaceEntitlementRuntime", () => ({
  assertMessengerGenerationOwnership: vi.fn(async () => undefined),
}));
vi.mock("./_core/messengerPrivacyErasureQueue", () => ({
  enqueueMessengerPrivacyErasureJob: vi.fn(),
  claimMessengerPrivacyErasureJob: vi.fn(),
  setMessengerPrivacyErasureEpoch: vi.fn(),
  rescheduleMessengerPrivacyErasureJob: mocks.reschedule,
  completeMessengerPrivacyErasureJob: mocks.completeJob,
}));
vi.mock("./_core/meta/webhookIngressQueue", () => ({
  eraseWebhookIngressDeliveriesForSubject: mocks.eraseIngress,
}));
vi.mock("./_core/messengerGenerationQueue", () => ({
  eraseMessengerGenerationJobsForSubject: mocks.eraseGeneration,
}));
vi.mock("./_core/messengerProviderAttemptFence", () => ({
  containMessengerProviderAttemptsForPrivacy: mocks.containProvider,
}));
vi.mock("./_core/costLedger", async importOriginal => {
  const actual = await importOriginal<typeof import("./_core/costLedger")>();
  return { ...actual, deleteCostLedgerEntriesForSubject: mocks.eraseCost };
});
vi.mock("./db", async importOriginal => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    eraseBillingHandoffIdentity: mocks.eraseBilling,
    getConnectedFacebookPageConnection: vi.fn(async () => null),
  };
});

import { processClaimedMessengerPrivacyErasureJob } from "./_core/dataDeletionService";
import {
  getOrCreateState,
  getState,
  setConsentState,
  setLastGenerated,
  setLastGenerationContext,
} from "./_core/messengerState";
import {
  runWithMessengerRequestContext,
  setMessengerRequestPrivacySubject,
} from "./_core/messengerRequestContext";
import {
  beginMessengerStatePrivacyErasure,
  deletePersistedStateHistoryForErasure,
  getPersistedStateForErasure,
  getPersistedStateHistoryForErasure,
  isPersistedStateHistoryErased,
} from "./_core/messengerStatePersistence";
import { getRedisClient, resetRedisClientForTests } from "./_core/redis";
import {
  getMessengerGenerationCompletion,
  markMessengerGenerationCompleted,
} from "./_core/messengerGenerationCompletion";
import {
  beginMessengerPrivacyOwnershipErasure,
  completeMessengerPrivacyOwnershipErasure,
  registerMessengerPrivacyOwnership,
} from "./_core/messengerPrivacyOwnershipHistory";

const runRedis = process.env.RUN_REDIS_INTEGRATION === "1";
const suite = runRedis ? describe : describe.skip;

suite("Messenger state Redis privacy fence", () => {
  const originalPepper = process.env.PRIVACY_PEPPER;

  beforeEach(async () => {
    process.env.PRIVACY_PEPPER = "state-privacy-redis-test-pepper";
    resetRedisClientForTests();
    const redis = await getRedisClient();
    await redis.flushdb();
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.storageDelete.mockResolvedValue(undefined);
    mocks.beginSubject.mockResolvedValue(7);
    mocks.completeSubject.mockResolvedValue(undefined);
    mocks.completeJob.mockResolvedValue(undefined);
    mocks.reschedule.mockResolvedValue(undefined);
    mocks.eraseBilling.mockResolvedValue(0);
    mocks.eraseIngress.mockResolvedValue(undefined);
    mocks.eraseGeneration.mockResolvedValue(0);
    mocks.containProvider.mockResolvedValue(true);
    mocks.eraseCost.mockResolvedValue(0);
  });

  afterAll(() => {
    resetRedisClientForTests();
    if (originalPepper === undefined) delete process.env.PRIVACY_PEPPER;
    else process.env.PRIVACY_PEPPER = originalPepper;
  });

  it("atomically rejects stale state writes after the subject is erased", async () => {
    const psid = "state-privacy-user-a";
    const userKey = await withFence(psid, 42, 7, 3, 5, async () => {
      const state = await Promise.resolve(getOrCreateState(psid));
      await Promise.resolve(setConsentState(psid, true));
      return state.userKey;
    });

    await beginMessengerStatePrivacyErasure({
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 6,
      userKey,
    });

    await expect(
      withFence(psid, 42, 7, 3, 5, async () => {
        await Promise.resolve(
          setLastGenerationContext(
            psid,
            { prompt: "must-not-survive" },
            Date.now()
          )
        );
      })
    ).rejects.toThrow("subject is erased");

    await expect(
      withFence(psid, 42, 7, 3, 5, async () => Promise.resolve(getState(psid)))
    ).resolves.toBeNull();

    await expect(
      withFence(psid, 42, 7, 3, 5, async () =>
        Promise.resolve(getPersistedStateForErasure(psid))
      )
    ).resolves.toEqual(
      expect.objectContaining({
        userKey,
        workspaceId: 42,
        channelConnectionId: 7,
        bindingEpoch: 3,
        privacyEpoch: 5,
      })
    );
  });

  it("does not tombstone the same user key in another tenant scope", async () => {
    const psid = "state-privacy-shared-user";
    const first = await withFence(psid, 42, 7, 3, 1, async () =>
      Promise.resolve(getOrCreateState(psid))
    );
    await withFence(psid, 84, 9, 1, 1, async () => {
      await Promise.resolve(getOrCreateState(psid));
      await Promise.resolve(setConsentState(psid, true));
    });

    await beginMessengerStatePrivacyErasure({
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 2,
      userKey: first.userKey,
    });

    await expect(
      withFence(psid, 84, 9, 1, 1, async () => {
        await Promise.resolve(
          setLastGenerationContext(
            psid,
            { prompt: "tenant-b-survives" },
            Date.now()
          )
        );
        return await Promise.resolve(getState(psid));
      })
    ).resolves.toEqual(
      expect.objectContaining({ lastPrompt: "tenant-b-survives" })
    );
  });

  it("indexes and CAS-deletes every historical reconnect binding", async () => {
    const psid = "state-privacy-reconnect-history";
    const first = await withFence(psid, 42, 7, 2, 5, async () => {
      await Promise.resolve(getOrCreateState(psid));
      await Promise.resolve(
        setLastGenerationContext(psid, { prompt: "old-binding" })
      );
      return await Promise.resolve(getState(psid));
    });
    await withFence(psid, 42, 7, 3, 5, async () => {
      await Promise.resolve(getOrCreateState(psid));
      await Promise.resolve(
        setLastGenerationContext(psid, { prompt: "new-binding" })
      );
    });

    const erasureScope = {
      workspaceId: 42,
      channelConnectionId: 7,
      userKey: first!.userKey,
      privacyEpoch: 5,
    };
    await beginMessengerStatePrivacyErasure({
      ...erasureScope,
      bindingEpoch: 3,
    });

    await expect(
      getPersistedStateHistoryForErasure(psid, erasureScope)
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ bindingEpoch: 2, lastPrompt: "old-binding" }),
        expect.objectContaining({ bindingEpoch: 3, lastPrompt: "new-binding" }),
      ])
    );
    await deletePersistedStateHistoryForErasure(psid, erasureScope);
    await expect(
      isPersistedStateHistoryErased(psid, erasureScope)
    ).resolves.toBe(true);
    await expect(
      withFence(psid, 42, 7, 2, 5, () =>
        Promise.resolve(getPersistedStateForErasure(psid))
      )
    ).resolves.toBeNull();
    await expect(
      withFence(psid, 42, 7, 3, 5, () =>
        Promise.resolve(getPersistedStateForErasure(psid))
      )
    ).resolves.toBeNull();
  });

  it("scans ownership history in bounded cursor batches", async () => {
    const pageId = "bounded-ownership-history-page";
    const userKey = (await import("./_core/privacy")).toUserKey(
      "bounded-ownership-history-user"
    );
    await Promise.all(
      Array.from({ length: 205 }, (_, index) =>
        registerMessengerPrivacyOwnership({
          pageId,
          userKey,
          workspaceId: index + 1,
          channelConnectionId: index + 10_001,
          bindingEpoch: index + 1,
          privacyEpoch: 1,
        })
      )
    );
    await registerMessengerPrivacyOwnership({
      pageId,
      userKey,
      workspaceId: 1,
      channelConnectionId: 10_001,
      bindingEpoch: 1,
      privacyEpoch: 2,
      channel: "whatsapp",
    });

    const history = await beginMessengerPrivacyOwnershipErasure({
      pageId,
      userKey,
      channel: "facebook_messenger",
    });
    expect(history).toHaveLength(205);
    expect(history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          workspaceId: 1,
          channelConnectionId: 10_001,
          bindingEpoch: 1,
          channel: "facebook_messenger",
        }),
        expect.objectContaining({
          workspaceId: 205,
          channelConnectionId: 10_205,
          bindingEpoch: 205,
        }),
      ])
    );
    await expect(
      beginMessengerPrivacyOwnershipErasure({
        pageId,
        userKey,
        channel: "whatsapp",
      })
    ).resolves.toEqual([
      expect.objectContaining({
        workspaceId: 1,
        channelConnectionId: 10_001,
        bindingEpoch: 1,
        channel: "whatsapp",
      }),
    ]);
    const redis = await getRedisClient();
    const historyKeys: string[] = [];
    let cursor = "0";
    do {
      const result = await redis.scan(
        cursor,
        "MATCH",
        "messenger-privacy-ownership-v1:*:scopes",
        "COUNT",
        100
      );
      cursor = result[0];
      historyKeys.push(...result[1]);
    } while (cursor !== "0");
    expect(historyKeys).toHaveLength(2);
    // Historical tenant routing must outlive every content lane (including
    // durable billing identity), and is removed only after the erasure saga.
    for (const historyKey of historyKeys) {
      await expect(redis.ttl(historyKey)).resolves.toBe(-1);
    }
    await completeMessengerPrivacyOwnershipErasure({
      pageId,
      userKey,
      channel: "facebook_messenger",
    });
    await expect(redis.exists(...historyKeys)).resolves.toBe(1);
    await completeMessengerPrivacyOwnershipErasure({
      pageId,
      userKey,
      channel: "whatsapp",
    });
    await expect(redis.exists(...historyKeys)).resolves.toBe(0);
  });

  it("blocks a stale rebind writer and removes every historical object before DB erasure", async () => {
    const psid = "state-privacy-history-object-cleanup";
    const userKey = (await import("./_core/privacy")).toUserKey(psid);
    const oldUrl =
      "https://assets.example/generated/images/old-binding-result.jpg";
    const currentUrl =
      "https://assets.example/generated/images/current-binding-result.jpg";
    const otherTenantUrl =
      "https://assets.example/generated/images/other-tenant-result.jpg";

    await withFence(psid, 41, 9, 2, 7, async () => {
      await Promise.resolve(getOrCreateState(psid));
      await Promise.resolve(setLastGenerated(psid, oldUrl));
    });
    await withFence(psid, 41, 9, 3, 7, async () => {
      await Promise.resolve(getOrCreateState(psid));
      await Promise.resolve(setLastGenerated(psid, currentUrl));
    });
    await withFence(psid, 52, 11, 1, 7, async () => {
      await Promise.resolve(getOrCreateState(psid));
      await Promise.resolve(setLastGenerated(psid, otherTenantUrl));
    });

    const events: string[] = [];
    mocks.storageDelete.mockImplementation(async key => {
      events.push(`object:${key}`);
    });
    mocks.completeSubject.mockImplementation(async () => {
      events.push("subject-erased");
    });
    mocks.eraseIngress.mockImplementation(async () => {
      await expect(
        withFence(psid, 41, 9, 2, 7, () =>
          Promise.resolve(
            setLastGenerated(psid, "https://assets.example/stale-race.jpg")
          )
        )
      ).rejects.toThrow("subject is erased");
      events.push("stale-old-binding-blocked");
    });

    const outcome = await processClaimedMessengerPrivacyErasureJob({
      psid,
      leaseToken: "lease-token",
      job: {
        version: 1,
        jobId: "b".repeat(64),
        workspaceId: 41,
        channelConnectionId: 9,
        pageId: "page-41",
        bindingEpoch: 3,
        userKey,
        oldPrivacyEpoch: 7,
        sealedPsid: "sealed",
        erasureEpoch: null,
        attemptCount: 0,
        createdAt: 1,
        updatedAt: 1,
        nextAttemptAt: 1,
        lastErrorCode: null,
      },
    });

    expect(outcome).toEqual({ status: "completed" });
    for (const historicalBindingEpoch of [2, 3]) {
      expect(mocks.eraseGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: 41,
          channelConnectionId: 9,
          bindingEpoch: historicalBindingEpoch,
          userKey,
        })
      );
    }
    expect(mocks.storageDelete).toHaveBeenCalledWith(
      "generated/images/old-binding-result.jpg"
    );
    expect(mocks.storageDelete).toHaveBeenCalledWith(
      "generated/images/current-binding-result.jpg"
    );
    expect(mocks.storageDelete).not.toHaveBeenCalledWith(
      "generated/images/other-tenant-result.jpg"
    );
    expect(events).toContain("stale-old-binding-blocked");
    expect(events.at(-1)).toBe("subject-erased");

    await expect(
      withFence(psid, 41, 9, 2, 7, () => Promise.resolve(getState(psid)))
    ).resolves.toBeNull();
    await expect(
      withFence(psid, 41, 9, 3, 7, () => Promise.resolve(getState(psid)))
    ).resolves.toBeNull();
    await expect(
      withFence(psid, 52, 11, 1, 7, () => Promise.resolve(getState(psid)))
    ).resolves.toEqual(
      expect.objectContaining({ lastGeneratedUrl: otherTenantUrl })
    );
  });

  it("fan-out scrubs state and completion inventory after the same Page transfers workspace", async () => {
    const psid = "state-privacy-page-transfer-history";
    const pageId = "shared-transferred-page";
    const userKey = (await import("./_core/privacy")).toUserKey(psid);
    const oldFence = {
      workspaceId: 41,
      channelConnectionId: 9,
      bindingEpoch: 2,
      privacyEpoch: 7,
      userKey,
      pageId,
    };
    const currentFence = {
      workspaceId: 52,
      channelConnectionId: 11,
      bindingEpoch: 1,
      privacyEpoch: 1,
      userKey,
      pageId,
    };
    const unrelatedFence = {
      workspaceId: 63,
      channelConnectionId: 15,
      bindingEpoch: 1,
      privacyEpoch: 1,
      userKey,
      pageId: "unrelated-page",
    };
    const whatsappFence = {
      ...currentFence,
      channel: "whatsapp" as const,
    };

    await withFence(
      psid,
      41,
      9,
      2,
      7,
      async () => {
        await Promise.resolve(getOrCreateState(psid));
        await Promise.resolve(
          setLastGenerated(
            psid,
            "https://assets.example/generated/images/old-transfer-state.jpg"
          )
        );
      },
      pageId
    );
    await markMessengerGenerationCompleted(
      "old-transfer-completion",
      "https://assets.example/generated/images/old-transfer-completion.jpg",
      userKey,
      Date.now(),
      oldFence
    );

    await withFence(
      psid,
      52,
      11,
      1,
      1,
      async () => {
        await Promise.resolve(getOrCreateState(psid));
        await Promise.resolve(
          setLastGenerated(
            psid,
            "https://assets.example/generated/images/current-transfer-state.jpg"
          )
        );
      },
      pageId
    );
    await markMessengerGenerationCompleted(
      "current-transfer-completion",
      "https://assets.example/generated/images/current-transfer-completion.jpg",
      userKey,
      Date.now(),
      currentFence
    );
    // A shared connection can hold channel-separated completion inventory.
    // The privacy history must not collapse WhatsApp into Messenger merely
    // because the numeric tenant scope is identical.
    await registerMessengerPrivacyOwnership({
      pageId,
      userKey,
      workspaceId: whatsappFence.workspaceId,
      channelConnectionId: whatsappFence.channelConnectionId,
      bindingEpoch: whatsappFence.bindingEpoch,
      privacyEpoch: whatsappFence.privacyEpoch,
      channel: whatsappFence.channel,
    });
    await markMessengerGenerationCompleted(
      "whatsapp-transfer-completion",
      "https://assets.example/generated/images/whatsapp-transfer-completion.jpg",
      userKey,
      Date.now(),
      whatsappFence
    );

    await withFence(
      psid,
      63,
      15,
      1,
      1,
      async () => {
        await Promise.resolve(getOrCreateState(psid));
        await Promise.resolve(
          setLastGenerated(
            psid,
            "https://assets.example/generated/images/unrelated-page.jpg"
          )
        );
      },
      unrelatedFence.pageId
    );
    await markMessengerGenerationCompleted(
      "unrelated-page-completion",
      "https://assets.example/generated/images/unrelated-page-completion.jpg",
      userKey,
      Date.now(),
      unrelatedFence
    );

    mocks.beginSubject.mockResolvedValue(1);
    const outcome = await processClaimedMessengerPrivacyErasureJob({
      psid,
      leaseToken: "transfer-lease",
      job: {
        version: 1,
        jobId: "c".repeat(64),
        workspaceId: currentFence.workspaceId,
        channelConnectionId: currentFence.channelConnectionId,
        pageId,
        bindingEpoch: currentFence.bindingEpoch,
        userKey,
        oldPrivacyEpoch: currentFence.privacyEpoch,
        sealedPsid: "sealed",
        erasureEpoch: null,
        attemptCount: 0,
        createdAt: 1,
        updatedAt: 1,
        nextAttemptAt: 1,
        lastErrorCode: null,
      },
    });

    expect(outcome).toEqual({ status: "completed" });
    for (const scope of [oldFence, currentFence]) {
      expect(mocks.eraseIngress).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: scope.workspaceId,
          channelConnectionId: scope.channelConnectionId,
          userKey,
        })
      );
      expect(mocks.containProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: scope.workspaceId,
          channelConnectionId: scope.channelConnectionId,
          userKey,
        })
      );
      expect(mocks.eraseGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: scope.workspaceId,
          channelConnectionId: scope.channelConnectionId,
          pageId,
          userKey,
        })
      );
      expect(mocks.eraseCost).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: scope.workspaceId,
          channelConnectionId: scope.channelConnectionId,
          userKey,
        })
      );
      expect(mocks.eraseBilling).toHaveBeenCalledWith(
        scope.workspaceId,
        userKey,
        pageId
      );
    }
    expect(mocks.eraseIngress).not.toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: unrelatedFence.workspaceId })
    );
    expect(mocks.eraseGeneration).not.toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: unrelatedFence.workspaceId })
    );
    await expect(
      getMessengerGenerationCompletion("old-transfer-completion", oldFence)
    ).resolves.toBeNull();
    await expect(
      getMessengerGenerationCompletion(
        "current-transfer-completion",
        currentFence
      )
    ).resolves.toBeNull();
    await expect(
      getMessengerGenerationCompletion(
        "whatsapp-transfer-completion",
        whatsappFence
      )
    ).resolves.toBeNull();
    await expect(
      getMessengerGenerationCompletion(
        "unrelated-page-completion",
        unrelatedFence
      )
    ).resolves.toEqual(
      expect.objectContaining({
        imageUrl:
          "https://assets.example/generated/images/unrelated-page-completion.jpg",
      })
    );
    expect(mocks.storageDelete).toHaveBeenCalledWith(
      "generated/images/old-transfer-completion.jpg"
    );
    expect(mocks.storageDelete).toHaveBeenCalledWith(
      "generated/images/current-transfer-completion.jpg"
    );
    expect(mocks.storageDelete).toHaveBeenCalledWith(
      "generated/images/whatsapp-transfer-completion.jpg"
    );
    expect(mocks.storageDelete).not.toHaveBeenCalledWith(
      "generated/images/unrelated-page-completion.jpg"
    );
    await expect(
      withFence(
        psid,
        41,
        9,
        2,
        7,
        () => Promise.resolve(getState(psid)),
        pageId
      )
    ).resolves.toBeNull();
    await expect(
      withFence(
        psid,
        52,
        11,
        1,
        1,
        () => Promise.resolve(getState(psid)),
        pageId
      )
    ).resolves.toBeNull();
    await expect(
      withFence(
        psid,
        63,
        15,
        1,
        1,
        () => Promise.resolve(getState(psid)),
        unrelatedFence.pageId
      )
    ).resolves.toEqual(
      expect.objectContaining({
        lastGeneratedUrl:
          "https://assets.example/generated/images/unrelated-page.jpg",
      })
    );
  });
});

async function withFence<T>(
  psid: string,
  workspaceId: number,
  channelConnectionId: number,
  bindingEpoch: number,
  privacyEpoch: number,
  action: () => Promise<T>,
  pageId = `page-${workspaceId}`
): Promise<T> {
  return runWithMessengerRequestContext(
    pageId,
    async () => {
      const state = await Promise.resolve(getOrCreateStateForUserKey(psid));
      setMessengerRequestPrivacySubject({
        userKey: state.userKey,
        privacyEpoch,
      });
      return action();
    },
    { workspaceId, channelConnectionId, bindingEpoch }
  );
}

async function getOrCreateStateForUserKey(psid: string) {
  // The first state call needs the privacy subject in request context. Derive
  // the same privacy-safe key without persisting any raw identifier.
  const { toUserKey } = await import("./_core/privacy");
  const userKey = toUserKey(psid);
  setMessengerRequestPrivacySubject({ userKey, privacyEpoch: 1 });
  return { userKey };
}
