import { afterEach, describe, expect, it } from "vitest";
import {
  getMessengerRequestPageId,
  runWithMessengerRequestContext,
} from "./_core/messengerRequestContext";
import { parseReservedGenerationJob } from "./_core/messengerGenerationJobPayload";
import { clearStateStore } from "./_core/stateStore";
import {
  findStateByUserKey,
  getOrCreateState,
  hasOpenMessengerResponseWindow,
  anonymizePsid,
  setLastUserMessageAt,
  setMessengerPageId,
} from "./_core/messengerState";

describe("Messenger Page request context", () => {
  afterEach(() => clearStateStore());
  it("keeps concurrent Page identities isolated across async turns", async () => {
    const [first, second] = await Promise.all([
      runWithMessengerRequestContext("page-one", async () => {
        await Promise.resolve();
        return getMessengerRequestPageId();
      }),
      runWithMessengerRequestContext("page-two", async () => {
        await Promise.resolve();
        return getMessengerRequestPageId();
      }),
    ]);

    expect(first).toBe("page-one");
    expect(second).toBe("page-two");
    expect(getMessengerRequestPageId()).toBeUndefined();
  });

  it("retains Page identity in a validated queued generation job", () => {
    const parsed = parseReservedGenerationJob(
      JSON.stringify({
        psid: "raw-only-inside-queue",
        userId: "hashed-user",
        pageId: " page-one ",
        reqId: "request-1",
        lang: "nl",
        generationKind: "text_to_image",
      })
    );

    expect(parsed?.job.pageId).toBe("page-one");
  });

  it("finds Page-scoped state outside request context without using its storage key", async () => {
    const psid = "raw-page-scoped-psid";
    const now = 1_700_000_000_000;
    process.env.PRIVACY_PEPPER = "request-context-test-pepper";
    const userKey = anonymizePsid(psid);
    await runWithMessengerRequestContext("page-a", async () => {
      await getOrCreateState(psid);
      await setMessengerPageId(psid, "page-a", now);
      await setLastUserMessageAt(psid, now);
    });

    await expect(findStateByUserKey(userKey, "page-a")).resolves.toMatchObject({
      psid,
      pageId: "page-a",
    });
    expect(hasOpenMessengerResponseWindow(psid, now + 1, "page-a")).toBe(true);
    await expect(findStateByUserKey(userKey, "page-b")).resolves.toBeNull();
  });
});
