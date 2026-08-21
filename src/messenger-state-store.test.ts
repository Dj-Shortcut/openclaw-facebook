import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMessengerStateOwnerToken,
  getMemoryMessengerEphemeralStateStore,
  getMemoryMessengerEphemeralStateStoreStatsForTests,
  getMessengerEphemeralStateStore,
  resetMessengerEphemeralStateStoreForTests,
} from "./messenger-state-store.js";

describe("memory Messenger ephemeral state store", () => {
  beforeEach(async () => {
    await resetMessengerEphemeralStateStoreForTests();
  });

  afterEach(async () => {
    await resetMessengerEphemeralStateStoreForTests();
  });

  it("claims an event once per account and Page with idempotent owner retries", async () => {
    const store = getMemoryMessengerEphemeralStateStore();
    const ownerToken = createMessengerStateOwnerToken();
    const input = {
      scope: { accountId: "account-a", pageId: "page-a" },
      eventIdentity: "mid-1",
      ownerToken,
      ttlMs: 10_000,
      now: 1_000,
    } as const;

    await expect(store.claimMessage(input)).resolves.toBe(true);
    await expect(store.claimMessage(input)).resolves.toBe(true);
    await expect(
      store.claimMessage({ ...input, ownerToken: createMessengerStateOwnerToken() }),
    ).resolves.toBe(false);
    await expect(
      store.claimMessage({
        ...input,
        scope: { accountId: "account-a", pageId: "page-b" },
        ownerToken: createMessengerStateOwnerToken(),
      }),
    ).resolves.toBe(true);
  });

  it("allows an event again after its claim expires", async () => {
    const store = getMemoryMessengerEphemeralStateStore();
    const input = {
      scope: { accountId: "account-a", pageId: "page-a" },
      eventIdentity: "mid-expiring",
      ownerToken: "owner-a",
      ttlMs: 1_000,
      now: 1_000,
    } as const;

    await expect(store.claimMessage(input)).resolves.toBe(true);
    await expect(
      store.claimMessage({ ...input, ownerToken: "owner-b", now: 2_001 }),
    ).resolves.toBe(true);
  });

  it("enforces an idempotent daily cap under concurrent reservations", async () => {
    const store = getMemoryMessengerEphemeralStateStore();
    const base = {
      scope: { accountId: "account-a", pageId: "page-a" },
      kind: "image_forward" as const,
      dayKey: "2026-08-21",
      cap: 20,
      expiresAtMs: 2_000_000,
      now: 1_000,
    };
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, index) =>
        store.reserveDaily({ ...base, eventIdentity: `event-${index}` }),
      ),
    );

    expect(results.filter((result) => result.ok)).toHaveLength(20);
    expect(Math.max(...results.map((result) => result.count))).toBe(20);
    const first = await store.reserveDaily({ ...base, eventIdentity: "same-event" });
    const retry = await store.reserveDaily({ ...base, eventIdentity: "same-event" });
    expect(retry).toEqual(first);
    expect(getMemoryMessengerEphemeralStateStoreStatsForTests()).toMatchObject({
      counters: 1,
      reservations: 20,
    });
  });

  it("rejects an empty Page boundary and isolates budgets per Page", async () => {
    const store = getMemoryMessengerEphemeralStateStore();
    await expect(store.claimMessage({
      scope: { accountId: "account-a", pageId: "" },
      eventIdentity: "mid-invalid",
      ownerToken: "owner",
      ttlMs: 1_000,
      now: 1_000,
    })).rejects.toMatchObject({ code: "config" });

    const base = {
      kind: "image_forward" as const,
      dayKey: "2026-08-21",
      cap: 1,
      expiresAtMs: 2_000_000,
      now: 1_000,
    };
    await expect(store.reserveDaily({
      ...base,
      scope: { accountId: "account-a", pageId: "page-a" },
      eventIdentity: "event-a",
    })).resolves.toMatchObject({ ok: true, count: 1 });
    await expect(store.reserveDaily({
      ...base,
      scope: { accountId: "account-a", pageId: "page-b" },
      eventIdentity: "event-b",
    })).resolves.toMatchObject({ ok: true, count: 1 });
  });

  it("does not allow live shared-state mode changes", async () => {
    await expect(getMessengerEphemeralStateStore("memory")).resolves.toBe(
      getMemoryMessengerEphemeralStateStore(),
    );
    await expect(getMessengerEphemeralStateStore("redis")).rejects.toMatchObject({
      code: "config",
    });
  });
});
