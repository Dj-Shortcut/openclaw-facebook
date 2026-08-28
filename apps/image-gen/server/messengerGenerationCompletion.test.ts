import { afterEach, describe, expect, it, vi } from "vitest";

const { assertPrivacyMock } = vi.hoisted(() => ({
  assertPrivacyMock: vi.fn(async () => undefined),
}));
const { storageDeleteMock } = vi.hoisted(() => ({
  storageDeleteMock: vi.fn(async () => undefined),
}));

vi.mock("./_core/messengerPrivacySubject", () => ({
  assertMessengerPrivacySubject: assertPrivacyMock,
}));
vi.mock("./storage", () => ({
  storageKeyFromPublicUrl: (url: string) => {
    const path = new URL(url).pathname.replace(/^\/+/, "");
    return path.startsWith("generated/images/v1/")
      ? path
      : `generated/images/${url.split("/").at(-1)}`;
  },
  storageDelete: storageDeleteMock,
}));

import {
  confirmMessengerGenerationDeliveryReceipts,
  deleteMessengerGenerationCompletionsForUser,
  getMessengerGenerationCompletion,
  isLegacyMessengerGenerationCompletionKey,
  markMessengerGenerationCompleted,
  markMessengerGenerationDeliveryAccepted,
  markMessengerGenerationDeliveryRetryable,
  markMessengerGenerationDeliveryStarted,
  markMessengerGenerationDelivered,
  markMessengerGenerationQuotaCommitted,
  markMessengerGenerationSuccessNoticeSent,
  registerMessengerObjectForPrivacyCleanup,
  unregisterMessengerObjectFromPrivacyCleanup,
} from "./_core/messengerGenerationCompletion";
import { buildMessengerStorageObjectKey } from "./_core/messengerStorageObject";
import { clearStateStore } from "./_core/stateStore";

const GENERATION_COMPLETION_TEST_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

describe("messengerGenerationCompletion", () => {
  afterEach(() => {
    clearStateStore();
    assertPrivacyMock.mockReset();
    assertPrivacyMock.mockResolvedValue(undefined);
    storageDeleteMock.mockReset();
    storageDeleteMock.mockResolvedValue(undefined);
  });

  it("accepts canonical nested user indexes during the broad readiness scan", () => {
    const completionScope = "messenger-generation-completion";
    const userIndexScope = "messenger-generation-completion:user";
    const canonicalTag = "{mgc:0123456789abcdef}";

    expect(
      isLegacyMessengerGenerationCompletionKey(
        completionScope,
        `${userIndexScope}:${canonicalTag}:index`
      )
    ).toBe(false);
    expect(
      isLegacyMessengerGenerationCompletionKey(
        userIndexScope,
        `${userIndexScope}:${canonicalTag}:index`
      )
    ).toBe(false);
    expect(
      isLegacyMessengerGenerationCompletionKey(
        completionScope,
        `${completionScope}:legacy-request`
      )
    ).toBe(true);
    expect(
      isLegacyMessengerGenerationCompletionKey(
        userIndexScope,
        `${userIndexScope}:legacy-user`
      )
    ).toBe(true);
  });

  it("rejects a scoped object owned by another privacy fence before inventory or completion writes", async () => {
    const fence = {
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 5,
      userKey: "a".repeat(64),
      pageId: "page-fenced-storage",
    };
    const ownKey = buildMessengerStorageObjectKey({
      kind: "generated_image",
      scope: fence,
      fileName: "1787461200000-123e4567-e89b-42d3-a456-426614174000.png",
    });
    const foreignKey = buildMessengerStorageObjectKey({
      kind: "generated_image",
      scope: { ...fence, workspaceId: fence.workspaceId + 1 },
      fileName: "1787461200001-123e4567-e89b-42d3-a456-426614174001.png",
    });

    await expect(
      registerMessengerObjectForPrivacyCleanup(ownKey, fence)
    ).resolves.toBe(true);
    await expect(
      registerMessengerObjectForPrivacyCleanup(foreignKey, fence)
    ).rejects.toThrow("does not match completion privacy fence");
    await expect(
      unregisterMessengerObjectFromPrivacyCleanup(foreignKey, fence)
    ).rejects.toThrow("does not match completion privacy fence");
    await expect(
      markMessengerGenerationCompleted(
        "req-foreign-storage-object",
        `https://assets.example/${foreignKey}`,
        fence.userKey,
        1_771_000_000_000,
        fence
      )
    ).rejects.toThrow("does not match completion privacy fence");
    await expect(
      getMessengerGenerationCompletion("req-foreign-storage-object", fence)
    ).resolves.toBeNull();
    expect(storageDeleteMock).not.toHaveBeenCalledWith(foreignKey);
  });

  it("binds completion reads and writes to the immutable privacy fence", async () => {
    const fence = {
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 5,
      userKey: "user-key-fenced-123",
      pageId: "page-fenced",
    };
    await markMessengerGenerationCompleted(
      "req-fenced",
      "https://assets.example/generated/fenced.jpg",
      fence.userKey,
      1_771_000_000_000,
      fence
    );

    await expect(
      getMessengerGenerationCompletion("req-fenced", fence)
    ).resolves.toEqual(expect.objectContaining(fence));
    await expect(
      getMessengerGenerationCompletion("req-fenced", {
        ...fence,
        workspaceId: 43,
      })
    ).resolves.toBeNull();
  });

  it("scrubs a completion when erasure wins after the state write", async () => {
    const fence = {
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 5,
      userKey: "user-key-erasure-race",
      pageId: "page-erasure-race",
    };
    assertPrivacyMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("privacy erased"));

    await expect(
      markMessengerGenerationCompleted(
        "req-erasure-race",
        "https://assets.example/generated/erasure-race.jpg",
        fence.userKey,
        1_771_000_000_000,
        fence
      )
    ).rejects.toThrow("privacy erased");
    await expect(
      getMessengerGenerationCompletion("req-erasure-race")
    ).resolves.toBeNull();
  });

  it("isolates the same request id across ownership and privacy scopes", async () => {
    const first = {
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 5,
      userKey: "user-key-shared-req-a",
      pageId: "page-a",
    };
    const second = {
      ...first,
      channelConnectionId: 8,
      bindingEpoch: 4,
      privacyEpoch: 6,
      pageId: "page-b",
    };
    await markMessengerGenerationCompleted(
      "req-shared",
      "https://assets.example/generated/a.jpg",
      first.userKey,
      1_771_000_000_000,
      first
    );
    await markMessengerGenerationCompleted(
      "req-shared",
      "https://assets.example/generated/b.jpg",
      second.userKey,
      1_771_000_000_100,
      second
    );
    await expect(
      getMessengerGenerationCompletion("req-shared", first)
    ).resolves.toMatchObject({
      imageUrl: "https://assets.example/generated/a.jpg",
    });
    await expect(
      getMessengerGenerationCompletion("req-shared", second)
    ).resolves.toMatchObject({
      imageUrl: "https://assets.example/generated/b.jpg",
    });
  });

  it("never regresses delivered to pending or extends absolute retention", async () => {
    const fence = {
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 5,
      userKey: "user-key-monotone",
      pageId: "page-monotone",
    };
    await markMessengerGenerationCompleted(
      "req-monotone",
      "https://assets.example/generated/monotone.jpg",
      fence.userKey,
      1_771_000_000_000,
      fence
    );
    await markMessengerGenerationDelivered(
      "req-monotone",
      "https://assets.example/generated/monotone.jpg",
      fence.userKey,
      1_771_000_000_100,
      fence
    );
    await markMessengerGenerationCompleted(
      "req-monotone",
      "https://assets.example/generated/replayed.jpg",
      fence.userKey,
      1_771_000_000_200,
      fence
    );
    await expect(
      getMessengerGenerationCompletion("req-monotone", fence)
    ).resolves.toMatchObject({
      deliveryStatus: "delivered",
      imageUrl: "https://assets.example/generated/monotone.jpg",
      expiresAt: 1_771_604_800_000,
    });
    expect(storageDeleteMock).toHaveBeenCalledWith(
      "generated/images/replayed.jpg"
    );
  });

  it("fails closed when delivery has no create-once completion", async () => {
    const fence = {
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 5,
      userKey: "user-key-missing-delivery",
      pageId: "page-missing-delivery",
    };
    await expect(
      markMessengerGenerationDelivered(
        "req-missing-delivery",
        "https://assets.example/generated/missing.jpg",
        fence.userKey,
        1_771_000_000_000,
        fence
      )
    ).rejects.toThrow("Messenger completion missing");
    expect(storageDeleteMock).toHaveBeenCalledWith(
      "generated/images/missing.jpg"
    );
  });

  it("stores completion markers by generation request id", async () => {
    await Promise.resolve(
      markMessengerGenerationCompleted(
        "req-complete",
        "https://assets.example/generated/req-complete.jpg",
        "user-key-1",
        1_771_000_000_000
      )
    );

    await expect(
      Promise.resolve(getMessengerGenerationCompletion("req-complete"))
    ).resolves.toEqual({
      reqId: "req-complete",
      imageUrl: "https://assets.example/generated/req-complete.jpg",
      completedAt: 1_771_000_000_000,
      deliveryStatus: "pending",
      quotaAccountingMode: "success_only_v1",
      successNoticeStatus: "pending",
      userKey: "user-key-1",
      expiresAt: 1_771_604_800_000,
    });
  });

  it("marks completed generations as delivered without changing completion time", async () => {
    await markMessengerGenerationCompleted(
      "req-delivered",
      "https://assets.example/generated/req-delivered.jpg",
      "user-key-delivered",
      1_771_000_000_000
    );

    await markMessengerGenerationDelivered(
      "req-delivered",
      "https://assets.example/generated/req-delivered.jpg",
      "user-key-delivered",
      1_771_000_000_100
    );

    await expect(
      Promise.resolve(getMessengerGenerationCompletion("req-delivered"))
    ).resolves.toEqual({
      reqId: "req-delivered",
      imageUrl: "https://assets.example/generated/req-delivered.jpg",
      completedAt: 1_771_000_000_000,
      deliveryStatus: "delivered",
      deliveredAt: 1_771_000_000_100,
      quotaAccountingMode: "success_only_v1",
      successNoticeStatus: "pending",
      userKey: "user-key-delivered",
      expiresAt: 1_771_604_800_000,
    });
  });

  it("claims image transport once and reopens it only after a known rejection", async () => {
    const reqId = "req-delivery-claim";
    const imageUrl = "https://assets.example/generated/delivery-claim.jpg";
    const userKey = "user-key-delivery-claim";
    await markMessengerGenerationCompleted(
      reqId,
      imageUrl,
      userKey,
      1_771_000_000_000
    );

    await expect(
      markMessengerGenerationDeliveryStarted(
        reqId,
        imageUrl,
        userKey,
        1_771_000_000_050
      )
    ).resolves.toBe("started");
    await expect(
      markMessengerGenerationDeliveryStarted(
        reqId,
        imageUrl,
        userKey,
        1_771_000_000_060
      )
    ).resolves.toBe("already_started");
    await expect(
      getMessengerGenerationCompletion(reqId)
    ).resolves.toMatchObject({
      deliveryStatus: "transport_started",
      deliveryStartedAt: 1_771_000_000_050,
    });

    await markMessengerGenerationDeliveryRetryable(
      reqId,
      imageUrl,
      userKey,
      1_771_000_000_070
    );
    await expect(
      getMessengerGenerationCompletion(reqId)
    ).resolves.toMatchObject({ deliveryStatus: "pending" });
    await expect(
      markMessengerGenerationDeliveryStarted(
        reqId,
        imageUrl,
        userKey,
        1_771_000_000_080
      )
    ).resolves.toBe("started");
    await markMessengerGenerationDelivered(
      reqId,
      imageUrl,
      userKey,
      1_771_000_000_090
    );
    await markMessengerGenerationDeliveryRetryable(
      reqId,
      imageUrl,
      userKey,
      1_771_000_000_100
    );
    await expect(
      getMessengerGenerationCompletion(reqId)
    ).resolves.toMatchObject({
      deliveryStatus: "delivered",
      deliveredAt: 1_771_000_000_090,
    });
  });

  it("keeps a paid image pending until the exact scoped delivery receipt arrives", async () => {
    const fence = {
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 5,
      userKey: "b".repeat(64),
      pageId: "page-delivery-receipt",
      channel: "facebook_messenger" as const,
    };
    const key = buildMessengerStorageObjectKey({
      kind: "generated_image",
      scope: fence,
      fileName: "1787461200000-123e4567-e89b-42d3-a456-426614174010.png",
    });
    const imageUrl = `https://assets.example/${key}`;
    const now = Date.now();
    await markMessengerGenerationCompleted(
      "req-receipt",
      imageUrl,
      fence.userKey,
      now,
      fence,
      "paid_credit_delivery_v1",
      null,
      "test"
    );
    await markMessengerGenerationDeliveryStarted(
      "req-receipt",
      imageUrl,
      fence.userKey,
      now + 1,
      fence
    );

    await expect(
      markMessengerGenerationDeliveryAccepted(
        "req-receipt",
        imageUrl,
        "mid-paid-receipt",
        fence.userKey,
        now + 2,
        fence
      )
    ).resolves.toBe("receipt_pending");
    await expect(
      markMessengerGenerationDeliveryStarted(
        "req-receipt",
        imageUrl,
        fence.userKey,
        now + 3,
        fence
      )
    ).resolves.toBe("receipt_pending");
    await expect(
      getMessengerGenerationCompletion("req-receipt", fence)
    ).resolves.toMatchObject({
      deliveryStatus: "receipt_pending",
      messengerAcceptedAt: now + 2,
      messengerMessageIdHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });

    await expect(
      confirmMessengerGenerationDeliveryReceipts(
        ["mid-paid-receipt"],
        fence,
        now + 4
      )
    ).resolves.toHaveLength(1);
    await expect(
      getMessengerGenerationCompletion("req-receipt", fence)
    ).resolves.toMatchObject({
      deliveryStatus: "delivered",
      deliveredAt: now + 4,
      deliveryProof: "meta_delivery_receipt_v1",
      receiptConfirmedAt: now + 4,
    });
    await expect(
      confirmMessengerGenerationDeliveryReceipts(
        ["mid-paid-receipt"],
        fence,
        now + 5
      )
    ).resolves.toHaveLength(1);
  });

  it("closes the receipt-before-Graph-response race without a nested lock", async () => {
    const fence = {
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 6,
      userKey: "c".repeat(64),
      pageId: "page-delivery-race",
      channel: "facebook_messenger" as const,
    };
    const key = buildMessengerStorageObjectKey({
      kind: "generated_image",
      scope: fence,
      fileName: "1787461200000-123e4567-e89b-42d3-a456-426614174011.png",
    });
    const imageUrl = `https://assets.example/${key}`;
    const now = Date.now();
    await markMessengerGenerationCompleted(
      "req-receipt-race",
      imageUrl,
      fence.userKey,
      now,
      fence,
      "paid_credit_delivery_v1",
      null,
      "test"
    );
    await markMessengerGenerationDeliveryStarted(
      "req-receipt-race",
      imageUrl,
      fence.userKey,
      now + 1,
      fence
    );
    await expect(
      confirmMessengerGenerationDeliveryReceipts(["mid-raced"], fence, now + 2)
    ).resolves.toEqual([]);

    await expect(
      markMessengerGenerationDeliveryAccepted(
        "req-receipt-race",
        imageUrl,
        "mid-raced",
        fence.userKey,
        now + 3,
        fence
      )
    ).resolves.toBe("delivered");
    await expect(
      getMessengerGenerationCompletion("req-receipt-race", fence)
    ).resolves.toMatchObject({
      deliveryStatus: "delivered",
      deliveryProof: "meta_delivery_receipt_v1",
      receiptConfirmedAt: now + 3,
    });
  });

  it("waits through a real concurrent acceptance/receipt critical section", async () => {
    const fence = {
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 8,
      userKey: "e".repeat(64),
      pageId: "page-delivery-concurrent",
      channel: "facebook_messenger" as const,
    };
    const key = buildMessengerStorageObjectKey({
      kind: "generated_image",
      scope: fence,
      fileName: "1787461200000-123e4567-e89b-42d3-a456-426614174099.png",
    });
    const imageUrl = `https://assets.example/${key}`;
    const now = Date.now();
    await markMessengerGenerationCompleted(
      "req-receipt-concurrent",
      imageUrl,
      fence.userKey,
      now,
      fence,
      "paid_credit_delivery_v1",
      null,
      "test"
    );
    await markMessengerGenerationDeliveryStarted(
      "req-receipt-concurrent",
      imageUrl,
      fence.userKey,
      now + 1,
      fence
    );
    let releaseAcceptance!: () => void;
    const acceptanceBlocked = new Promise<void>(resolve => {
      releaseAcceptance = resolve;
    });
    let enteredAcceptance!: () => void;
    const acceptanceEntered = new Promise<void>(resolve => {
      enteredAcceptance = resolve;
    });
    assertPrivacyMock.mockImplementationOnce(async () => {
      enteredAcceptance();
      await acceptanceBlocked;
    });
    const accepted = markMessengerGenerationDeliveryAccepted(
      "req-receipt-concurrent",
      imageUrl,
      "mid-concurrent",
      fence.userKey,
      now + 2,
      fence
    );
    await acceptanceEntered;
    const confirmed = confirmMessengerGenerationDeliveryReceipts(
      ["mid-concurrent"],
      fence,
      now + 3
    );
    await new Promise(resolve => setTimeout(resolve, 300));
    releaseAcceptance();

    await expect(accepted).resolves.toBe("receipt_pending");
    await expect(confirmed).resolves.toHaveLength(1);
    await expect(
      getMessengerGenerationCompletion("req-receipt-concurrent", fence)
    ).resolves.toMatchObject({
      deliveryStatus: "delivered",
      deliveryProof: "meta_delivery_receipt_v1",
      receiptConfirmedAt: now + 3,
    });
  });

  it("fails closed when two scoped completions claim one Meta message ID", async () => {
    const fence = {
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 7,
      userKey: "d".repeat(64),
      pageId: "page-delivery-conflict",
      channel: "facebook_messenger" as const,
    };
    const now = Date.now();
    for (const [index, reqId] of [
      "req-conflict-a",
      "req-conflict-b",
    ].entries()) {
      const key = buildMessengerStorageObjectKey({
        kind: "generated_image",
        scope: fence,
        fileName: `178746120000${index}-123e4567-e89b-42d3-a456-42661417401${index}.png`,
      });
      const imageUrl = `https://assets.example/${key}`;
      await markMessengerGenerationCompleted(
        reqId,
        imageUrl,
        fence.userKey,
        now + index,
        fence,
        "paid_credit_delivery_v1",
        null,
        "test"
      );
      await markMessengerGenerationDeliveryStarted(
        reqId,
        imageUrl,
        fence.userKey,
        now + 10 + index,
        fence
      );
      const acceptance = markMessengerGenerationDeliveryAccepted(
        reqId,
        imageUrl,
        "mid-conflicting",
        fence.userKey,
        now + 20 + index,
        fence
      );
      if (index === 0) {
        await expect(acceptance).resolves.toBe("receipt_pending");
      } else {
        await expect(acceptance).rejects.toThrow("message claim conflict");
      }
    }

    await expect(
      confirmMessengerGenerationDeliveryReceipts(
        ["mid-conflicting"],
        fence,
        now + 30
      )
    ).resolves.toHaveLength(1);
  });

  it("keeps a receipt-first MID uniquely claimed by the first scoped completion", async () => {
    const fence = {
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 9,
      userKey: "f".repeat(64),
      pageId: "page-delivery-receipt-first-conflict",
      channel: "facebook_messenger" as const,
    };
    const now = Date.now();
    const imageUrls = [0, 1].map(index => {
      const key = buildMessengerStorageObjectKey({
        kind: "generated_image",
        scope: fence,
        fileName: `178746120001${index}-123e4567-e89b-42d3-a456-42661417402${index}.png`,
      });
      return `https://assets.example/${key}`;
    });
    for (const [index, reqId] of ["req-first-a", "req-first-b"].entries()) {
      await markMessengerGenerationCompleted(
        reqId,
        imageUrls[index],
        fence.userKey,
        now + index,
        fence,
        "paid_credit_delivery_v1",
        null,
        "test"
      );
      await markMessengerGenerationDeliveryStarted(
        reqId,
        imageUrls[index],
        fence.userKey,
        now + 10 + index,
        fence
      );
    }
    await expect(
      confirmMessengerGenerationDeliveryReceipts(
        ["mid-receipt-first-conflict"],
        fence,
        now + 20
      )
    ).resolves.toEqual([]);
    await expect(
      markMessengerGenerationDeliveryAccepted(
        "req-first-a",
        imageUrls[0],
        "mid-receipt-first-conflict",
        fence.userKey,
        now + 21,
        fence
      )
    ).resolves.toBe("delivered");
    await expect(
      markMessengerGenerationDeliveryAccepted(
        "req-first-b",
        imageUrls[1],
        "mid-receipt-first-conflict",
        fence.userKey,
        now + 22,
        fence
      )
    ).rejects.toThrow("message claim conflict");
    await expect(
      getMessengerGenerationCompletion("req-first-a", fence)
    ).resolves.toMatchObject({
      deliveryStatus: "delivered",
      deliveryProof: "meta_delivery_receipt_v1",
    });
    await expect(
      getMessengerGenerationCompletion("req-first-b", fence)
    ).resolves.toMatchObject({ deliveryStatus: "transport_started" });
  });

  it("scopes the same Meta MID by the full Page binding fence", async () => {
    const first = {
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 10,
      privacyEpoch: 11,
      userKey: "1".repeat(64),
      pageId: "page-receipt-scope-a",
      channel: "facebook_messenger" as const,
    };
    const second = {
      ...first,
      bindingEpoch: 11,
      pageId: "page-receipt-scope-b",
    };
    const now = Date.now();
    for (const [index, fence] of [first, second].entries()) {
      const key = buildMessengerStorageObjectKey({
        kind: "generated_image",
        scope: fence,
        fileName: `178746120002${index}-123e4567-e89b-42d3-a456-42661417403${index}.png`,
      });
      const imageUrl = `https://assets.example/${key}`;
      await markMessengerGenerationCompleted(
        `req-full-scope-${index}`,
        imageUrl,
        fence.userKey,
        now + index,
        fence,
        "paid_credit_delivery_v1",
        null,
        "test"
      );
      await markMessengerGenerationDeliveryStarted(
        `req-full-scope-${index}`,
        imageUrl,
        fence.userKey,
        now + 10 + index,
        fence
      );
      await expect(
        markMessengerGenerationDeliveryAccepted(
          `req-full-scope-${index}`,
          imageUrl,
          "same-mid-different-binding",
          fence.userKey,
          now + 20 + index,
          fence
        )
      ).resolves.toBe("receipt_pending");
    }
  });

  it("keeps an older Page binding indexed for erasure after a current-binding receipt scan", async () => {
    const oldFence = {
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 20,
      privacyEpoch: 21,
      userKey: "3".repeat(64),
      pageId: "page-before-binding-rotation",
      channel: "facebook_messenger" as const,
    };
    const currentFence = {
      ...oldFence,
      bindingEpoch: 21,
      pageId: "page-after-binding-rotation",
    };
    const objectKey = buildMessengerStorageObjectKey({
      kind: "generated_image",
      scope: oldFence,
      fileName: "1787461200030-123e4567-e89b-42d3-a456-426614174040.png",
    });
    const imageUrl = `https://assets.example/${objectKey}`;
    await markMessengerGenerationCompleted(
      "req-before-binding-rotation",
      imageUrl,
      oldFence.userKey,
      Date.now(),
      oldFence,
      "paid_credit_delivery_v1",
      null,
      "test"
    );
    await markMessengerGenerationDeliveryStarted(
      "req-before-binding-rotation",
      imageUrl,
      oldFence.userKey,
      Date.now(),
      oldFence
    );
    await expect(
      markMessengerGenerationDeliveryAccepted(
        "req-before-binding-rotation",
        imageUrl,
        "old-binding-claimed-mid",
        oldFence.userKey,
        Date.now(),
        oldFence
      )
    ).resolves.toBe("receipt_pending");
    await expect(
      confirmMessengerGenerationDeliveryReceipts(
        ["old-binding-pending-mid"],
        oldFence
      )
    ).resolves.toEqual([]);

    await expect(
      confirmMessengerGenerationDeliveryReceipts(
        ["unknown-current-binding-mid"],
        currentFence
      )
    ).resolves.toEqual([]);
    await deleteMessengerGenerationCompletionsForUser(
      currentFence.userKey,
      currentFence
    );

    await expect(
      getMessengerGenerationCompletion("req-before-binding-rotation", oldFence)
    ).resolves.toBeNull();
    expect(storageDeleteMock).toHaveBeenCalledWith(objectKey);

    for (const [index, messageId] of [
      "old-binding-claimed-mid",
      "old-binding-pending-mid",
    ].entries()) {
      const nextKey = buildMessengerStorageObjectKey({
        kind: "generated_image",
        scope: oldFence,
        fileName: `178746120004${index}-123e4567-e89b-42d3-a456-42661417404${index}.png`,
      });
      const nextImageUrl = `https://assets.example/${nextKey}`;
      const nextReqId = `req-after-binding-erasure-${index}`;
      await markMessengerGenerationCompleted(
        nextReqId,
        nextImageUrl,
        oldFence.userKey,
        Date.now(),
        oldFence,
        "paid_credit_delivery_v1",
        null,
        "test"
      );
      await markMessengerGenerationDeliveryStarted(
        nextReqId,
        nextImageUrl,
        oldFence.userKey,
        Date.now(),
        oldFence
      );
      await expect(
        markMessengerGenerationDeliveryAccepted(
          nextReqId,
          nextImageUrl,
          messageId,
          oldFence.userKey,
          Date.now(),
          oldFence
        )
      ).resolves.toBe("receipt_pending");
    }
  });

  it("prunes 257 expired completion members before applying the active receipt cap", async () => {
    vi.useFakeTimers();
    const currentNow = 1_800_000_000_000;
    vi.setSystemTime(currentNow);
    const fence = {
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 12,
      privacyEpoch: 13,
      userKey: "2".repeat(64),
      pageId: "page-receipt-stale-index",
      channel: "facebook_messenger" as const,
    };
    try {
      for (let index = 0; index < 257; index += 1) {
        const key = buildMessengerStorageObjectKey({
          kind: "generated_image",
          scope: fence,
          fileName: `${currentNow + index}-123e4567-e89b-42d3-a456-${String(index).padStart(12, "0")}.png`,
        });
        await markMessengerGenerationCompleted(
          `req-stale-${index}`,
          `https://assets.example/${key}`,
          fence.userKey,
          currentNow - GENERATION_COMPLETION_TEST_TTL_MS + 500,
          fence,
          "paid_credit_delivery_v1",
          null,
          "test"
        );
      }
      const currentKey = buildMessengerStorageObjectKey({
        kind: "generated_image",
        scope: fence,
        fileName: `${currentNow + 300}-123e4567-e89b-42d3-a456-426614174099.png`,
      });
      const currentImageUrl = `https://assets.example/${currentKey}`;
      await markMessengerGenerationCompleted(
        "req-after-stale-index",
        currentImageUrl,
        fence.userKey,
        currentNow,
        fence,
        "paid_credit_delivery_v1",
        null,
        "test"
      );
      vi.advanceTimersByTime(1_000);
      await markMessengerGenerationDeliveryStarted(
        "req-after-stale-index",
        currentImageUrl,
        fence.userKey,
        currentNow + 1_001,
        fence
      );
      await markMessengerGenerationDeliveryAccepted(
        "req-after-stale-index",
        currentImageUrl,
        "mid-after-stale-index",
        fence.userKey,
        currentNow + 1_002,
        fence
      );
      await expect(
        confirmMessengerGenerationDeliveryReceipts(
          ["mid-after-stale-index"],
          fence,
          currentNow + 1_003
        )
      ).resolves.toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the exact quota balance pending until the success notice is sent", async () => {
    const quotaStatus = {
      daily: { used: 1, limit: 5, remaining: 4 },
      monthly: { used: 1, limit: 20, remaining: 19 },
    };
    await markMessengerGenerationCompleted(
      "req-quota-notice",
      "https://assets.example/generated/quota-notice.jpg",
      "user-key-quota-notice",
      1_771_000_000_000
    );
    await markMessengerGenerationQuotaCommitted(
      "req-quota-notice",
      "https://assets.example/generated/quota-notice.jpg",
      "user-key-quota-notice",
      quotaStatus,
      1_771_000_000_050
    );
    await markMessengerGenerationDelivered(
      "req-quota-notice",
      "https://assets.example/generated/quota-notice.jpg",
      "user-key-quota-notice",
      1_771_000_000_100
    );

    await expect(
      getMessengerGenerationCompletion("req-quota-notice")
    ).resolves.toEqual(
      expect.objectContaining({
        deliveryStatus: "delivered",
        deliveredAt: 1_771_000_000_100,
        quotaStatus,
        quotaCommittedAt: 1_771_000_000_050,
        successNoticeStatus: "pending",
      })
    );

    const refreshedQuotaStatus = {
      daily: { used: 2, limit: 5, remaining: 3 },
      monthly: { used: 2, limit: 20, remaining: 18 },
    };
    await markMessengerGenerationQuotaCommitted(
      "req-quota-notice",
      "https://assets.example/generated/quota-notice.jpg",
      "user-key-quota-notice",
      refreshedQuotaStatus,
      1_771_000_000_125
    );

    await markMessengerGenerationSuccessNoticeSent(
      "req-quota-notice",
      "https://assets.example/generated/quota-notice.jpg",
      "user-key-quota-notice",
      1_771_000_000_150
    );

    await expect(
      getMessengerGenerationCompletion("req-quota-notice")
    ).resolves.toEqual(
      expect.objectContaining({
        deliveryStatus: "delivered",
        deliveredAt: 1_771_000_000_100,
        quotaStatus: refreshedQuotaStatus,
        quotaCommittedAt: 1_771_000_000_050,
        successNoticeStatus: "sent",
        successNoticeSentAt: 1_771_000_000_150,
      })
    );
  });

  it("returns null for unknown generation request ids", async () => {
    await expect(
      Promise.resolve(getMessengerGenerationCompletion("req-missing"))
    ).resolves.toBeNull();
  });

  it("deletes completion markers for one user without touching other users", async () => {
    await markMessengerGenerationCompleted(
      "req-user-1",
      "https://assets.example/generated/user-1.jpg",
      "user-key-1",
      1_771_000_000_000
    );
    await markMessengerGenerationCompleted(
      "req-user-2",
      "https://assets.example/generated/user-2.jpg",
      "user-key-2",
      1_771_000_000_001
    );

    await deleteMessengerGenerationCompletionsForUser("user-key-1");

    await expect(
      Promise.resolve(getMessengerGenerationCompletion("req-user-1"))
    ).resolves.toBeNull();
    await expect(
      Promise.resolve(getMessengerGenerationCompletion("req-user-2"))
    ).resolves.toEqual(
      expect.objectContaining({
        reqId: "req-user-2",
        userKey: "user-key-2",
      })
    );
  });

  it("keeps concurrent completion ids in the per-user deletion index", async () => {
    await Promise.all([
      markMessengerGenerationCompleted(
        "req-concurrent-1",
        "https://assets.example/generated/concurrent-1.jpg",
        "user-key-concurrent",
        1_771_000_000_000
      ),
      markMessengerGenerationCompleted(
        "req-concurrent-2",
        "https://assets.example/generated/concurrent-2.jpg",
        "user-key-concurrent",
        1_771_000_000_001
      ),
      markMessengerGenerationCompleted(
        "req-concurrent-other-user",
        "https://assets.example/generated/concurrent-other-user.jpg",
        "user-key-other-concurrent",
        1_771_000_000_002
      ),
    ]);

    await deleteMessengerGenerationCompletionsForUser("user-key-concurrent");

    await expect(
      Promise.resolve(getMessengerGenerationCompletion("req-concurrent-1"))
    ).resolves.toBeNull();
    await expect(
      Promise.resolve(getMessengerGenerationCompletion("req-concurrent-2"))
    ).resolves.toBeNull();
    await expect(
      Promise.resolve(
        getMessengerGenerationCompletion("req-concurrent-other-user")
      )
    ).resolves.toEqual(
      expect.objectContaining({
        reqId: "req-concurrent-other-user",
        userKey: "user-key-other-concurrent",
      })
    );
  });
});
