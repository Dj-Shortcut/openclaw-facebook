import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  admitPrivacy: vi.fn(),
  processFacebook: vi.fn(),
  resolveOwnership: vi.fn(),
}));

vi.mock("./_core/messengerPrivacySubject", async importOriginal => {
  const actual =
    await importOriginal<typeof import("./_core/messengerPrivacySubject")>();
  return {
    ...actual,
    admitMessengerPrivacySubjectFromMetaEvent: mocks.admitPrivacy,
  };
});
vi.mock("./_core/workspaceEntitlementRuntime", () => ({
  resolveMessengerGenerationOwnership: mocks.resolveOwnership,
}));
vi.mock("./_core/messengerWebhook", () => ({
  processFacebookWebhookPayload: mocks.processFacebook,
}));

import { webhookIngressQueueTestHooks } from "./_core/meta/webhookIngressQueue";
import {
  getMessengerRequestOwnership,
  getMessengerRequestPrivacySubject,
} from "./_core/messengerRequestContext";
import { toUserKey } from "./_core/privacy";
import { MessengerPrivacyFenceError } from "./_core/messengerPrivacySubject";

describe("Messenger webhook ingress privacy admission", () => {
  beforeEach(() => {
    process.env.PRIVACY_PEPPER = "webhook-ingress-privacy-test-pepper";
    mocks.admitPrivacy.mockReset().mockResolvedValue(4);
    mocks.processFacebook.mockReset().mockResolvedValue(undefined);
    mocks.resolveOwnership.mockReset().mockResolvedValue({
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      pageId: "page-a",
    });
  });

  it("allows reactivation only for a timestamped user event", async () => {
    const timestamp = 1_777_000_000_123;
    const deliveries =
      await webhookIngressQueueTestHooks.createFacebookIngressDeliveries(
        messengerPayload({ timestamp, message: { mid: "mid-1", text: "hi" } })
      );

    expect(deliveries).toHaveLength(1);
    expect(mocks.admitPrivacy).toHaveBeenCalledWith({
      workspaceId: 42,
      channelConnectionId: 7,
      userKey: toUserKey("sender-a"),
      eventOccurredAt: new Date(timestamp),
      allowReactivation: true,
    });
    expect(deliveries[0]?.subjects[0]).toMatchObject({
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 4,
      userKey: toUserKey("sender-a"),
    });
  });

  it("does not grant reactivation authority to non-user Meta events", async () => {
    const timestamp = 1_777_000_000_124;
    await webhookIngressQueueTestHooks.createFacebookIngressDeliveries(
      messengerPayload({ timestamp })
    );

    expect(mocks.admitPrivacy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventOccurredAt: new Date(timestamp),
        allowReactivation: false,
      })
    );
  });

  it("rejects an event without a stable Meta timestamp", async () => {
    await expect(
      webhookIngressQueueTestHooks.createFacebookIngressDeliveries(
        messengerPayload({ message: { mid: "mid-no-time", text: "hi" } })
      )
    ).rejects.toThrow("event timestamp is unavailable");

    expect(mocks.admitPrivacy).not.toHaveBeenCalled();
  });

  it("acknowledges but never queues an event rejected by the durable privacy boundary", async () => {
    mocks.admitPrivacy.mockRejectedValueOnce(new MessengerPrivacyFenceError());

    await expect(
      webhookIngressQueueTestHooks.createFacebookIngressDeliveries(
        messengerPayload({
          timestamp: 1_777_000_000_126,
          message: { mid: "mid-erased", text: "delayed" },
        })
      )
    ).resolves.toEqual([]);

    expect(mocks.processFacebook).not.toHaveBeenCalled();
  });

  it("processes queued work under its immutable privacy epoch without readmission", async () => {
    const userKey = toUserKey("sender-a");
    mocks.processFacebook.mockImplementationOnce(async () => {
      expect(getMessengerRequestOwnership()).toEqual({
        workspaceId: 42,
        channelConnectionId: 7,
        bindingEpoch: 3,
      });
      expect(getMessengerRequestPrivacySubject()).toEqual({
        userKey,
        privacyEpoch: 4,
      });
    });

    await webhookIngressQueueTestHooks.processQueuedWebhookDelivery({
      deliveryId: "11111111-1111-4111-8111-111111111111",
      channel: "facebook",
      payload: messengerPayload({
        timestamp: 1_777_000_000_125,
        message: { mid: "mid-queued", text: "hi" },
      }),
      receivedAt: "2026-08-23T12:00:00.000Z",
      expiresAt: Date.now() + 60_000,
      subjects: [
        {
          workspaceId: 42,
          channelConnectionId: 7,
          bindingEpoch: 3,
          privacyEpoch: 4,
          pageId: "page-a",
          userKey,
        },
      ],
    });

    expect(mocks.processFacebook).toHaveBeenCalledTimes(1);
    expect(mocks.admitPrivacy).not.toHaveBeenCalled();
  });
});

function messengerPayload(event: {
  timestamp?: number;
  message?: { mid: string; text: string };
}) {
  return {
    object: "page",
    entry: [
      {
        id: "page-a",
        messaging: [
          {
            sender: { id: "sender-a" },
            recipient: { id: "page-a" },
            ...event,
          },
        ],
      },
    ],
  };
}
