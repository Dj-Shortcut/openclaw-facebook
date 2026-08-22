import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deleteAndSend: vi.fn(),
  getErasingEpoch: vi.fn(),
  resolveOwnership: vi.fn(),
}));

vi.mock("./_core/consentService", async importOriginal => {
  const actual =
    await importOriginal<typeof import("./_core/consentService")>();
  return {
    ...actual,
    deleteUserDataAndSendResult: mocks.deleteAndSend,
  };
});
vi.mock("./_core/messengerPrivacySubject", async importOriginal => {
  const actual =
    await importOriginal<typeof import("./_core/messengerPrivacySubject")>();
  return {
    ...actual,
    getErasingMessengerPrivacySubjectEpoch: mocks.getErasingEpoch,
  };
});
vi.mock("./_core/workspaceEntitlementRuntime", async importOriginal => {
  const actual =
    await importOriginal<
      typeof import("./_core/workspaceEntitlementRuntime")
    >();
  return {
    ...actual,
    resolveMessengerGenerationOwnership: mocks.resolveOwnership,
  };
});

import { handleEntry } from "./_core/webhookEventRouter";
import { isMessengerErasureControlDelivery } from "./_core/messengerRequestContext";
import type { HandlerContext } from "./_core/webhookHandlerTypes";

describe("Messenger erasure retry routing", () => {
  beforeEach(() => {
    process.env.PRIVACY_PEPPER = "erasure-retry-test-pepper";
    mocks.resolveOwnership.mockReset().mockResolvedValue({
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
    });
    mocks.getErasingEpoch.mockReset().mockResolvedValue(9);
    mocks.deleteAndSend
      .mockReset()
      .mockImplementation(
        async (
          _psid: string,
          _lang: string,
          sendText: (text: string) => Promise<unknown>
        ) => {
          await sendText("deletion pending");
        }
      );
  });

  it("resumes only a deletion control and scopes its outcome delivery", async () => {
    const sendLoggedText = vi.fn(async () => {
      expect(isMessengerErasureControlDelivery()).toBe(true);
      return { sent: true as const };
    });
    const ctx = {
      defaultLang: "nl",
      claimEventReplayOrLog: vi.fn(async () => true),
      sendLoggedText,
    } as unknown as HandlerContext;

    await handleEntry(ctx, {
      id: "page-erasure",
      messaging: [
        {
          sender: { id: "psid-erasure", locale: "nl_BE" },
          recipient: { id: "page-erasure" },
          timestamp: Date.now(),
          message: { mid: "mid-erasure", text: "verwijder mijn data" },
        },
      ],
    });

    expect(mocks.deleteAndSend).toHaveBeenCalledTimes(1);
    expect(sendLoggedText).toHaveBeenCalledWith(
      "psid-erasure",
      "deletion pending",
      expect.any(String)
    );
  });

  it("does not repeat an erasure retry when replay claim is lost", async () => {
    const ctx = {
      defaultLang: "nl",
      claimEventReplayOrLog: vi.fn(async () => false),
      sendLoggedText: vi.fn(),
    } as unknown as HandlerContext;

    await handleEntry(ctx, {
      id: "page-erasure",
      messaging: [
        {
          sender: { id: "psid-erasure" },
          recipient: { id: "page-erasure" },
          message: { mid: "mid-erasure-replayed", text: "delete my data" },
        },
      ],
    });

    expect(mocks.deleteAndSend).not.toHaveBeenCalled();
    expect(ctx.sendLoggedText).not.toHaveBeenCalled();
  });
});
