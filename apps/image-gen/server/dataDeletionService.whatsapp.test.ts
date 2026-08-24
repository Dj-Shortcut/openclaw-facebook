import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  storageDeleteMock,
  eraseBillingHandoffIdentityMock,
  getConnectedFacebookPageConnectionMock,
  getConnectedMetaChannelConnectionMock,
  beginPrivacyErasureMock,
  runPrivacyErasureMock,
  completePrivacyErasureMock,
  beginStatePrivacyErasureMock,
  eraseWebhookIngressMock,
  containProviderAttemptsMock,
  eraseGenerationJobsMock,
  eraseImageQuotaMock,
  deleteCostLedgerEntriesMock,
} = vi.hoisted(() => ({
  storageDeleteMock: vi.fn(async () => undefined),
  eraseBillingHandoffIdentityMock: vi.fn(async () => 1),
  getConnectedFacebookPageConnectionMock: vi.fn(async () => null),
  getConnectedMetaChannelConnectionMock: vi.fn(
    async (
      channel: "facebook_messenger" | "whatsapp",
      externalId: string,
      expected?: {
        workspaceId?: number | null;
        channelConnectionId?: number | null;
        bindingEpoch?: number | null;
      }
    ) =>
      channel === "whatsapp" &&
      externalId === "whatsapp-phone-42" &&
      expected?.workspaceId === 42 &&
      expected.channelConnectionId === 12 &&
      expected.bindingEpoch === 3
        ? { id: 12, workspaceId: 42 }
        : null
  ),
  beginPrivacyErasureMock: vi.fn(async () => 6),
  runPrivacyErasureMock: vi.fn(),
  completePrivacyErasureMock: vi.fn(async () => undefined),
  beginStatePrivacyErasureMock: vi.fn(async () => undefined),
  eraseWebhookIngressMock: vi.fn(async () => 0),
  containProviderAttemptsMock: vi.fn(async () => true),
  eraseGenerationJobsMock: vi.fn(async () => 0),
  eraseImageQuotaMock: vi.fn(async () => undefined),
  deleteCostLedgerEntriesMock: vi.fn(async () => undefined),
}));

vi.mock("./storage", async importOriginal => {
  const actual = await importOriginal<typeof import("./storage")>();
  return { ...actual, storageDelete: storageDeleteMock };
});

vi.mock("./db", async importOriginal => {
  const actual = await importOriginal<typeof import("./db")>();
  return {
    ...actual,
    eraseBillingHandoffIdentity: eraseBillingHandoffIdentityMock,
    getConnectedFacebookPageConnection: getConnectedFacebookPageConnectionMock,
    getConnectedMetaChannelConnection: getConnectedMetaChannelConnectionMock,
  };
});

vi.mock("./_core/messengerPrivacySubject", async importOriginal => {
  const actual =
    await importOriginal<typeof import("./_core/messengerPrivacySubject")>();
  return {
    ...actual,
    assertMessengerPrivacySubject: vi.fn(async () => undefined),
    beginMessengerPrivacyErasure: beginPrivacyErasureMock,
    completeMessengerPrivacyErasure: completePrivacyErasureMock,
    runWithLockedMessengerPrivacyErasure: runPrivacyErasureMock,
  };
});

vi.mock("./_core/workspaceEntitlementRuntime", async importOriginal => {
  const actual =
    await importOriginal<
      typeof import("./_core/workspaceEntitlementRuntime")
    >();
  return {
    ...actual,
    assertMessengerGenerationOwnership: vi.fn(async () => undefined),
  };
});

vi.mock("./_core/messengerStatePersistence", async importOriginal => {
  const actual =
    await importOriginal<typeof import("./_core/messengerStatePersistence")>();
  return {
    ...actual,
    beginMessengerStatePrivacyErasure: beginStatePrivacyErasureMock,
  };
});

vi.mock("./_core/meta/webhookIngressQueue", async importOriginal => {
  const actual =
    await importOriginal<typeof import("./_core/meta/webhookIngressQueue")>();
  return {
    ...actual,
    eraseWebhookIngressDeliveriesForSubject: eraseWebhookIngressMock,
  };
});

vi.mock("./_core/messengerProviderAttemptFence", async importOriginal => {
  const actual =
    await importOriginal<
      typeof import("./_core/messengerProviderAttemptFence")
    >();
  return {
    ...actual,
    containMessengerProviderAttemptsForPrivacy: containProviderAttemptsMock,
  };
});

vi.mock("./_core/messengerGenerationQueue", async importOriginal => {
  const actual =
    await importOriginal<typeof import("./_core/messengerGenerationQueue")>();
  return {
    ...actual,
    eraseMessengerGenerationJobsForSubject: eraseGenerationJobsMock,
  };
});

vi.mock("./_core/messengerImageQuotaStore", async importOriginal => {
  const actual =
    await importOriginal<typeof import("./_core/messengerImageQuotaStore")>();
  return {
    ...actual,
    eraseMessengerImageQuotaForUser: eraseImageQuotaMock,
  };
});

vi.mock("./_core/costLedger", async importOriginal => {
  const actual = await importOriginal<typeof import("./_core/costLedger")>();
  return {
    ...actual,
    deleteCostLedgerEntriesForUser: deleteCostLedgerEntriesMock,
  };
});

import { deleteUserData } from "./_core/dataDeletionService";
import {
  deleteMessengerGenerationCompletionsForUser,
  markMessengerGenerationCompleted,
  type MessengerGenerationCompletionFence,
} from "./_core/messengerGenerationCompletion";
import {
  anonymizePsid,
  getOrCreateState,
  getState,
  resetStateStore,
} from "./_core/messengerState";
import { buildMessengerStorageObjectKey } from "./_core/messengerStorageObject";
import { runWithMessengerRequestContext } from "./_core/messengerRequestContext";

describe("WhatsApp data deletion tenant boundary", () => {
  const senderId = "whatsapp-delete-sender";
  const phoneNumberId = "whatsapp-phone-42";
  let userKey: string;
  let fence: MessengerGenerationCompletionFence;
  let objectKey: string;
  let imageUrl: string;

  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PRIVACY_PEPPER", "whatsapp-deletion-test-pepper");
    vi.stubEnv("PUBLIC_BASE_URL", "https://assets.example");
    delete process.env.REDIS_URL;
    userKey = anonymizePsid(senderId);
    fence = {
      workspaceId: 42,
      channelConnectionId: 12,
      bindingEpoch: 3,
      privacyEpoch: 5,
      userKey,
      pageId: phoneNumberId,
      channel: "whatsapp",
    };
    objectKey = buildMessengerStorageObjectKey({
      kind: "generated_image",
      scope: fence,
      fileName: "1771000000000-00000000-0000-4000-8000-000000000001.jpg",
    });
    imageUrl = `https://assets.example/${objectKey}`;
    resetStateStore();
    storageDeleteMock.mockClear();
    eraseBillingHandoffIdentityMock.mockClear();
    getConnectedFacebookPageConnectionMock.mockClear();
    getConnectedMetaChannelConnectionMock.mockClear();
    beginPrivacyErasureMock.mockClear();
    runPrivacyErasureMock.mockReset().mockImplementation(
      async (
        input: {
          workspaceId: number;
          channelConnectionId: number;
          userKey: string;
          privacyEpoch: number;
          dataPrivacyEpoch: number;
        },
        task: () => Promise<{ value: unknown; complete: boolean }>
      ) => {
        const result = await task();
        if (result.complete) {
          await completePrivacyErasureMock({
            workspaceId: input.workspaceId,
            channelConnectionId: input.channelConnectionId,
            userKey: input.userKey,
            privacyEpoch: input.privacyEpoch,
          });
        }
        return result.value;
      }
    );
    completePrivacyErasureMock.mockClear();
    beginStatePrivacyErasureMock.mockClear();
    eraseWebhookIngressMock.mockClear();
    containProviderAttemptsMock.mockClear();
    eraseGenerationJobsMock.mockClear();
    eraseImageQuotaMock.mockClear();
    deleteCostLedgerEntriesMock.mockClear();
  });

  afterEach(() => {
    resetStateStore();
    vi.unstubAllEnvs();
  });

  it("tombstones and scrubs the exact WhatsApp subject, billing identity, completion, and object", async () => {
    await runWithMessengerRequestContext(
      phoneNumberId,
      async () => {
        await Promise.resolve(getOrCreateState(senderId));
        await markMessengerGenerationCompleted(
          "whatsapp-delete-completion",
          imageUrl,
          userKey,
          1_771_000_000_000,
          fence
        );

        await expect(deleteUserData(senderId)).resolves.toEqual({
          status: "completed",
        });
        await expect(Promise.resolve(getState(senderId))).resolves.toBeNull();
      },
      {
        channel: "whatsapp",
        workspaceId: 42,
        channelConnectionId: 12,
        bindingEpoch: 3,
        userKey,
        privacyEpoch: 5,
      }
    );

    expect(getConnectedMetaChannelConnectionMock).toHaveBeenCalledWith(
      "whatsapp",
      phoneNumberId,
      {
        workspaceId: 42,
        channelConnectionId: 12,
        bindingEpoch: 3,
      }
    );
    expect(beginPrivacyErasureMock).toHaveBeenCalledWith({
      workspaceId: 42,
      channelConnectionId: 12,
      userKey,
    });
    expect(beginStatePrivacyErasureMock).toHaveBeenCalledWith({
      workspaceId: 42,
      channelConnectionId: 12,
      userKey,
      privacyEpoch: 6,
      bindingEpoch: 3,
    });
    expect(eraseBillingHandoffIdentityMock).toHaveBeenCalledWith(
      42,
      userKey,
      phoneNumberId,
      { channelConnectionId: 12, maxPrivacyEpoch: 5 }
    );
    expect(storageDeleteMock).toHaveBeenCalledWith(objectKey);

    storageDeleteMock.mockClear();
    await deleteMessengerGenerationCompletionsForUser(userKey, fence);
    expect(storageDeleteMock).not.toHaveBeenCalled();
  });

  it("fails closed when a WhatsApp state is presented under the wrong channel", async () => {
    await runWithMessengerRequestContext(
      phoneNumberId,
      async () => {
        await Promise.resolve(getOrCreateState(senderId));
      },
      {
        channel: "whatsapp",
        workspaceId: 42,
        channelConnectionId: 12,
        bindingEpoch: 3,
        userKey,
        privacyEpoch: 5,
      }
    );

    await runWithMessengerRequestContext(
      phoneNumberId,
      async () => {
        await expect(deleteUserData(senderId)).resolves.toEqual({
          status: "failed",
        });
      },
      {
        channel: "facebook_messenger",
        workspaceId: 42,
        channelConnectionId: 12,
        bindingEpoch: 3,
        userKey,
        privacyEpoch: 5,
      }
    );

    expect(getConnectedFacebookPageConnectionMock).toHaveBeenCalledWith(
      phoneNumberId,
      expect.objectContaining({ channelConnectionId: 12 })
    );
    expect(getConnectedMetaChannelConnectionMock).not.toHaveBeenCalled();
    expect(beginPrivacyErasureMock).not.toHaveBeenCalled();
    expect(beginStatePrivacyErasureMock).not.toHaveBeenCalled();
    expect(eraseBillingHandoffIdentityMock).not.toHaveBeenCalled();
    expect(storageDeleteMock).not.toHaveBeenCalled();
  });

  it("fails closed after a WhatsApp binding rebind changes the exact scope", async () => {
    getConnectedMetaChannelConnectionMock.mockResolvedValueOnce(null);

    await runWithMessengerRequestContext(
      phoneNumberId,
      async () => {
        await Promise.resolve(getOrCreateState(senderId));
        await expect(deleteUserData(senderId)).resolves.toEqual({
          status: "failed",
        });
      },
      {
        channel: "whatsapp",
        workspaceId: 42,
        channelConnectionId: 12,
        bindingEpoch: 3,
        userKey,
        privacyEpoch: 5,
      }
    );

    expect(getConnectedMetaChannelConnectionMock).toHaveBeenCalledWith(
      "whatsapp",
      phoneNumberId,
      {
        workspaceId: 42,
        channelConnectionId: 12,
        bindingEpoch: 3,
      }
    );
    expect(beginPrivacyErasureMock).not.toHaveBeenCalled();
    expect(beginStatePrivacyErasureMock).not.toHaveBeenCalled();
    expect(eraseBillingHandoffIdentityMock).not.toHaveBeenCalled();
    expect(storageDeleteMock).not.toHaveBeenCalled();
  });
});
