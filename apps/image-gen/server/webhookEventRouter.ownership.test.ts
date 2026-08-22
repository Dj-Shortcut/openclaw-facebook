import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  assertOwnershipMock,
  resolveOwnershipMock,
  getPageIdMock,
  getOwnershipMock,
  getPrivacySubjectMock,
  traceMock,
} = vi.hoisted(() => ({
  assertOwnershipMock: vi.fn(),
  resolveOwnershipMock: vi.fn(),
  getPageIdMock: vi.fn(),
  getOwnershipMock: vi.fn(),
  getPrivacySubjectMock: vi.fn(),
  traceMock: vi.fn(),
}));

vi.mock("./_core/workspaceEntitlementRuntime", async importOriginal => ({
  ...(await importOriginal<
    typeof import("./_core/workspaceEntitlementRuntime")
  >()),
  assertMessengerGenerationOwnership: assertOwnershipMock,
  resolveMessengerGenerationOwnership: resolveOwnershipMock,
}));

vi.mock("./_core/messengerRequestContext", async importOriginal => ({
  ...(await importOriginal<typeof import("./_core/messengerRequestContext")>()),
  getMessengerRequestPageId: getPageIdMock,
  getMessengerRequestOwnership: getOwnershipMock,
  getMessengerRequestPrivacySubject: getPrivacySubjectMock,
}));

vi.mock("./_core/webhookFallback", async importOriginal => ({
  ...(await importOriginal<typeof import("./_core/webhookFallback")>()),
  logMessengerWebhookTrace: traceMock,
}));

import type { HandlerContext } from "./_core/webhookHandlerTypes";
import { handleEntry } from "./_core/webhookEventRouter";

describe("queued webhook ownership routing", () => {
  const capturedOwnership = {
    workspaceId: 41,
    channelConnectionId: 17,
    bindingEpoch: 3,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    assertOwnershipMock.mockResolvedValue(undefined);
    getPageIdMock.mockReturnValue("page-a");
    getOwnershipMock.mockReturnValue(capturedOwnership);
    getPrivacySubjectMock.mockReturnValue(undefined);
  });

  it("asserts the captured tuple without resolving the Page's current owner", async () => {
    await handleEntry({} as HandlerContext, {
      id: "page-a",
      messaging: [],
    });

    expect(assertOwnershipMock).toHaveBeenCalledWith({
      pageId: "page-a",
      ...capturedOwnership,
    });
    expect(resolveOwnershipMock).not.toHaveBeenCalled();
  });

  it("fails closed without reading the rebound tenant", async () => {
    assertOwnershipMock.mockRejectedValue(
      new Error("Messenger generation ownership changed after enqueue")
    );

    await handleEntry({} as HandlerContext, {
      id: "page-a",
      messaging: [],
    });

    expect(resolveOwnershipMock).not.toHaveBeenCalled();
    expect(traceMock).toHaveBeenCalledWith("webhook_entry_skipped", {
      reason: "queued_page_ownership_changed",
    });
  });

  it("preserves Page resolution for an unqueued live webhook", async () => {
    const currentOwnership = {
      ...capturedOwnership,
      pageId: "page-a",
    };
    getPageIdMock.mockReturnValue(undefined);
    getOwnershipMock.mockReturnValue(undefined);
    resolveOwnershipMock.mockResolvedValue(currentOwnership);

    await handleEntry({} as HandlerContext, {
      id: "page-a",
      messaging: [],
    });

    expect(resolveOwnershipMock).toHaveBeenCalledWith("page-a");
    expect(assertOwnershipMock).not.toHaveBeenCalled();
  });
});
