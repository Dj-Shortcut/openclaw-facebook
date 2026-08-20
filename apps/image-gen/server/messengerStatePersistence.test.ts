import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getOrCreateState,
  getState,
  resetStateStore,
  setFlowState,
} from "./_core/messengerState";
import { runWithMessengerRequestContext } from "./_core/messengerRequestContext";

describe("Messenger state rollout boundary", () => {
  const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

  beforeEach(() => {
    process.env.PRIVACY_PEPPER = "state-rollout-test-pepper";
    delete process.env.MESSENGER_PAGE_SCOPED_STATE_ENABLED;
    resetStateStore();
  });

  afterEach(() => {
    delete process.env.MESSENGER_PAGE_SCOPED_STATE_ENABLED;
    resetStateStore();
    if (originalPrivacyPepper === undefined) {
      delete process.env.PRIVACY_PEPPER;
    } else {
      process.env.PRIVACY_PEPPER = originalPrivacyPepper;
    }
  });

  it("keeps legacy state active until the offline migration is complete", async () => {
    const psid = "legacy-rollout-user";
    await Promise.resolve(getOrCreateState(psid));
    await Promise.resolve(setFlowState(psid, "PROCESSING"));

    const pageState = await runWithMessengerRequestContext(
      "page-before-migration",
      async () => await Promise.resolve(getState(psid))
    );

    expect(pageState?.stage).toBe("PROCESSING");
  });

  it("isolates Page state only after the rollout gate is enabled", async () => {
    process.env.MESSENGER_PAGE_SCOPED_STATE_ENABLED = "true";
    const psid = "page-scoped-rollout-user";

    await runWithMessengerRequestContext("page-one", async () => {
      await Promise.resolve(getOrCreateState(psid));
      await Promise.resolve(setFlowState(psid, "PROCESSING"));
    });
    const otherPageState = await runWithMessengerRequestContext(
      "page-two",
      async () => await Promise.resolve(getState(psid))
    );

    expect(otherPageState).toBeNull();
  });
});
