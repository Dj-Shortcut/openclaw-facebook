import { describe, expect, it } from "vitest";
import {
  getMessengerRequestPageId,
  runWithMessengerRequestContext,
} from "./_core/messengerRequestContext";
import { parseReservedGenerationJob } from "./_core/messengerGenerationJobPayload";

describe("Messenger Page request context", () => {
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
});
