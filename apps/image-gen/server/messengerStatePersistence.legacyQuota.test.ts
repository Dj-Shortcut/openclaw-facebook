import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { deleteStateIfValueMock } = vi.hoisted(() => ({
  deleteStateIfValueMock: vi.fn(),
}));

vi.mock("./_core/stateStore", async importOriginal => {
  const actual = await importOriginal<typeof import("./_core/stateStore")>();
  return {
    ...actual,
    deleteStateIfValue: deleteStateIfValueMock,
  };
});

import { resetStateStore } from "./_core/messengerState";
import { createDefaultState } from "./_core/messengerStateNormalization";
import { deleteLegacyMessengerQuotaShadow } from "./_core/messengerStatePersistence";
import { deleteState, readState, writeState } from "./_core/stateStore";

const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

describe("legacy Messenger quota shadow deletion", () => {
  beforeEach(() => {
    process.env.PRIVACY_PEPPER = "legacy-quota-shadow-test-pepper";
    resetStateStore();
    deleteStateIfValueMock.mockReset();
  });

  afterAll(() => {
    resetStateStore();
    if (originalPrivacyPepper === undefined) delete process.env.PRIVACY_PEPPER;
    else process.env.PRIVACY_PEPPER = originalPrivacyPepper;
  });

  it("reports an unresolved owned CAS conflict after bounded retries", async () => {
    const psid = "legacy-quota-cas-conflict";
    const state = ownedLegacyState(psid);
    await Promise.resolve(writeState(psid, state));
    deleteStateIfValueMock.mockResolvedValue(false);

    await expect(deleteLegacyMessengerQuotaShadow(psid, state)).resolves.toBe(
      "conflict"
    );

    expect(deleteStateIfValueMock).toHaveBeenCalledTimes(4);
    await expect(Promise.resolve(readState(psid))).resolves.toMatchObject({
      workspaceId: state.workspaceId,
      userKey: state.userKey,
    });
  });

  it("retries an owned conflict and reports deletion only after CAS succeeds", async () => {
    const psid = "legacy-quota-cas-retry";
    const state = ownedLegacyState(psid);
    await Promise.resolve(writeState(psid, state));
    deleteStateIfValueMock
      .mockResolvedValueOnce(false)
      .mockImplementationOnce(async () => {
        await Promise.resolve(deleteState(psid));
        return true;
      });

    await expect(deleteLegacyMessengerQuotaShadow(psid, state)).resolves.toBe(
      "deleted"
    );

    expect(deleteStateIfValueMock).toHaveBeenCalledTimes(2);
    await expect(Promise.resolve(readState(psid))).resolves.toBeNull();
  });

  it("preserves a shadow whose ownership tuple does not match", async () => {
    const psid = "legacy-quota-unowned";
    const owned = ownedLegacyState(psid);
    const other = { ...owned, workspaceId: owned.workspaceId! + 1 };
    await Promise.resolve(writeState(psid, other));

    await expect(deleteLegacyMessengerQuotaShadow(psid, owned)).resolves.toBe(
      "unowned"
    );

    expect(deleteStateIfValueMock).not.toHaveBeenCalled();
    await expect(Promise.resolve(readState(psid))).resolves.toMatchObject({
      workspaceId: other.workspaceId,
    });
  });
});

function ownedLegacyState(psid: string) {
  return {
    ...createDefaultState(psid),
    pageId: "legacy-page",
    workspaceId: 91,
    channelConnectionId: 19,
    bindingEpoch: 3,
    privacyEpoch: 7,
  };
}
