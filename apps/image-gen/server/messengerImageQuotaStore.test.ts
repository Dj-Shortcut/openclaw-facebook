import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  commitMessengerImageQuotaSuccess,
  eraseMessengerImageQuotaForUser,
  getMessengerImageQuotaStatus,
  releaseMessengerImageQuotaReservation,
  renewMessengerImageQuotaReservation,
  reserveMessengerImageQuota,
  type MessengerImageQuotaIdentity,
  type MessengerImageQuotaReservation,
} from "./_core/messengerImageQuotaStore";
import { MessengerPrivacyFenceError } from "./_core/messengerPrivacySubject";
import { clearStateStore } from "./_core/stateStore";

const originalDailyLimit = process.env.MESSENGER_FREE_DAILY_LIMIT;
const originalMonthlyLimit = process.env.MESSENGER_FREE_MONTHLY_LIMIT;
const originalQuotaTimeZone = process.env.MESSENGER_IMAGE_QUOTA_TIME_ZONE;
const originalRedisUrl = process.env.REDIS_URL;

// `userKey` is already HMAC-derived. No raw sender identifier belongs in the
// quota API or its durable keys.
const BASE_IDENTITY: MessengerImageQuotaIdentity = {
  workspaceId: 101,
  channelConnectionId: 201,
  bindingEpoch: 3,
  privacyEpoch: 5,
  userKey: "a".repeat(64),
};

describe("Messenger image success quota", () => {
  beforeAll(() => {
    delete process.env.REDIS_URL;
  });

  beforeEach(() => {
    clearStateStore();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T10:00:00.000Z"));
    process.env.MESSENGER_FREE_DAILY_LIMIT = "5";
    process.env.MESSENGER_FREE_MONTHLY_LIMIT = "20";
    process.env.MESSENGER_IMAGE_QUOTA_TIME_ZONE = "Europe/Brussels";
  });

  afterAll(() => {
    vi.useRealTimers();
    restoreEnv("MESSENGER_FREE_DAILY_LIMIT", originalDailyLimit);
    restoreEnv("MESSENGER_FREE_MONTHLY_LIMIT", originalMonthlyLimit);
    restoreEnv("MESSENGER_IMAGE_QUOTA_TIME_ZONE", originalQuotaTimeZone);
    restoreEnv("REDIS_URL", originalRedisUrl);
  });

  it("allows exactly 5 successful photos per local day", async () => {
    for (let index = 1; index <= 5; index += 1) {
      const result = await commitSuccess(BASE_IDENTITY, `daily-${index}`);

      expect(result.quotaStatus).toEqual({
        daily: { used: index, limit: 5, remaining: 5 - index },
        monthly: { used: index, limit: 20, remaining: 20 - index },
      });
    }

    await expect(
      reserveMessengerImageQuota(BASE_IDENTITY, "daily-sixth")
    ).resolves.toEqual({
      status: "daily_exhausted",
      quotaStatus: {
        daily: { used: 5, limit: 5, remaining: 0 },
        monthly: { used: 5, limit: 20, remaining: 15 },
      },
    });
  });

  it("allows exactly 20 successful photos per local month", async () => {
    const localDays = [1, 5, 10, 15];
    let successCount = 0;

    for (const localDay of localDays) {
      vi.setSystemTime(
        new Date(`2026-08-${String(localDay).padStart(2, "0")}T10:00:00.000Z`)
      );
      for (let dailyCount = 0; dailyCount < 5; dailyCount += 1) {
        successCount += 1;
        await commitSuccess(BASE_IDENTITY, `monthly-${successCount}`);
      }
    }

    vi.setSystemTime(new Date("2026-08-20T10:00:00.000Z"));
    await expect(
      reserveMessengerImageQuota(BASE_IDENTITY, "monthly-twenty-first")
    ).resolves.toEqual({
      status: "monthly_exhausted",
      quotaStatus: {
        daily: { used: 0, limit: 5, remaining: 5 },
        monthly: { used: 20, limit: 20, remaining: 0 },
      },
    });
    await expect(getMessengerImageQuotaStatus(BASE_IDENTITY)).resolves.toEqual({
      daily: { used: 0, limit: 5, remaining: 5 },
      monthly: { used: 20, limit: 20, remaining: 0 },
    });

    // 2026-08-31 22:00 UTC is 2026-09-01 00:00 in Europe/Brussels.
    vi.setSystemTime(new Date("2026-08-31T22:00:00.000Z"));
    await expect(
      reserveMessengerImageQuota(BASE_IDENTITY, "september-first")
    ).resolves.toMatchObject({ status: "reserved" });
  });

  it("does not count provider attempts or failures", async () => {
    for (let index = 1; index <= 8; index += 1) {
      const reservation = await reserve(BASE_IDENTITY, `failed-${index}`);
      await releaseMessengerImageQuotaReservation(BASE_IDENTITY, reservation);
    }

    await expect(getMessengerImageQuotaStatus(BASE_IDENTITY)).resolves.toEqual({
      daily: { used: 0, limit: 5, remaining: 5 },
      monthly: { used: 0, limit: 20, remaining: 20 },
    });

    for (let index = 1; index <= 5; index += 1) {
      await commitSuccess(BASE_IDENTITY, `success-after-failure-${index}`);
    }
    await expect(
      reserveMessengerImageQuota(BASE_IDENTITY, "success-after-failure-sixth")
    ).resolves.toMatchObject({
      status: "daily_exhausted",
      quotaStatus: {
        daily: { used: 5, remaining: 0 },
        monthly: { used: 5, remaining: 15 },
      },
    });
  });

  it("renews only the current reservation token and respects erasure", async () => {
    const reservation = await reserve(BASE_IDENTITY, "renew-current-token");
    vi.advanceTimersByTime(400_000);

    await expect(
      renewMessengerImageQuotaReservation(BASE_IDENTITY, {
        ...reservation,
        token: "not-the-owner",
      })
    ).resolves.toBe(false);
    await expect(
      renewMessengerImageQuotaReservation(BASE_IDENTITY, reservation)
    ).resolves.toBe(true);

    // The original lease has now elapsed, while the renewed lease is valid.
    vi.advanceTimersByTime(30_000);
    await expect(
      commitMessengerImageQuotaSuccess(BASE_IDENTITY, reservation)
    ).resolves.toMatchObject({ committed: true });

    const erasedReservation = await reserve(
      BASE_IDENTITY,
      "renew-after-erasure"
    );
    await eraseMessengerImageQuotaForUser({
      workspaceId: BASE_IDENTITY.workspaceId,
      channelConnectionId: BASE_IDENTITY.channelConnectionId,
      privacyEpoch: BASE_IDENTITY.privacyEpoch + 1,
      userKey: BASE_IDENTITY.userKey,
    });
    await expect(
      renewMessengerImageQuotaReservation(BASE_IDENTITY, erasedReservation)
    ).rejects.toBeInstanceOf(MessengerPrivacyFenceError);
  });

  it("counts a retried request id only once", async () => {
    const first = await commitSuccess(BASE_IDENTITY, "stable-request-id");
    expect(first.quotaStatus.daily.used).toBe(1);

    const replay = await reserveMessengerImageQuota(
      BASE_IDENTITY,
      "stable-request-id"
    );
    expect(replay).toMatchObject({ status: "already_committed" });
    if (replay.status !== "already_committed") {
      throw new Error("Expected an already committed request receipt");
    }

    await expect(
      commitMessengerImageQuotaSuccess(BASE_IDENTITY, replay.reservation)
    ).resolves.toMatchObject({
      committed: true,
      alreadyCommitted: true,
      quotaStatus: {
        daily: { used: 1, remaining: 4 },
        monthly: { used: 1, remaining: 19 },
      },
    });
    await expect(
      getMessengerImageQuotaStatus(BASE_IDENTITY)
    ).resolves.toMatchObject({
      daily: { used: 1 },
      monthly: { used: 1 },
    });
  });

  it("keeps counters and request receipts across a binding reconnect", async () => {
    await commitSuccess(BASE_IDENTITY, "reconnect-stable-request");
    const reconnectedIdentity = {
      ...BASE_IDENTITY,
      bindingEpoch: BASE_IDENTITY.bindingEpoch + 1,
    };

    await expect(
      getMessengerImageQuotaStatus(reconnectedIdentity)
    ).resolves.toMatchObject({
      daily: { used: 1, remaining: 4 },
      monthly: { used: 1, remaining: 19 },
    });

    const replay = await reserveMessengerImageQuota(
      reconnectedIdentity,
      "reconnect-stable-request"
    );
    expect(replay).toMatchObject({
      status: "already_committed",
      reservation: { bindingEpoch: reconnectedIdentity.bindingEpoch },
    });
    if (replay.status !== "already_committed") {
      throw new Error("Expected a reconnect-stable request receipt");
    }
    await expect(
      commitMessengerImageQuotaSuccess(reconnectedIdentity, replay.reservation)
    ).resolves.toMatchObject({
      committed: true,
      alreadyCommitted: true,
      quotaStatus: {
        daily: { used: 1, remaining: 4 },
        monthly: { used: 1, remaining: 19 },
      },
    });
  });

  it("rejects a reservation presented through a newer binding fence", async () => {
    const staleReservation = await reserve(
      BASE_IDENTITY,
      "reserved-before-reconnect"
    );
    const reconnectedIdentity = {
      ...BASE_IDENTITY,
      bindingEpoch: BASE_IDENTITY.bindingEpoch + 1,
    };

    await expect(
      renewMessengerImageQuotaReservation(reconnectedIdentity, staleReservation)
    ).resolves.toBe(false);
    await expect(
      commitMessengerImageQuotaSuccess(reconnectedIdentity, staleReservation)
    ).resolves.toMatchObject({ committed: false, alreadyCommitted: false });
    await expect(
      getMessengerImageQuotaStatus(reconnectedIdentity)
    ).resolves.toMatchObject({
      daily: { used: 0, remaining: 5 },
      monthly: { used: 0, remaining: 20 },
    });

    await releaseMessengerImageQuotaReservation(
      BASE_IDENTITY,
      staleReservation
    );
  });

  it("isolates the same user key by workspace, Page, and privacy epoch", async () => {
    for (let index = 1; index <= 5; index += 1) {
      await commitSuccess(BASE_IDENTITY, `base-scope-${index}`);
    }

    const isolatedIdentities: MessengerImageQuotaIdentity[] = [
      {
        ...BASE_IDENTITY,
        workspaceId: 102,
        channelConnectionId: 202,
      },
      { ...BASE_IDENTITY, channelConnectionId: 203 },
      { ...BASE_IDENTITY, privacyEpoch: BASE_IDENTITY.privacyEpoch + 1 },
    ];

    await expect(
      reserveMessengerImageQuota(BASE_IDENTITY, "base-scope-blocked")
    ).resolves.toMatchObject({
      status: "daily_exhausted",
      quotaStatus: {
        daily: { used: 5, remaining: 0 },
        monthly: { used: 5, remaining: 15 },
      },
    });

    for (const [index, identity] of isolatedIdentities.entries()) {
      await expect(
        reserveMessengerImageQuota(identity, `isolated-scope-${index}`)
      ).resolves.toMatchObject({ status: "reserved" });
      await expect(
        getMessengerImageQuotaStatus(identity)
      ).resolves.toMatchObject({
        daily: { used: 0, remaining: 5 },
        monthly: { used: 0, remaining: 20 },
      });
    }
  });

  it("scrubs all known reconnect epochs and fences late old reservations", async () => {
    const oldConnection = {
      ...BASE_IDENTITY,
      channelConnectionId: BASE_IDENTITY.channelConnectionId + 1,
      bindingEpoch: 1,
      privacyEpoch: 2,
    };
    const otherWorkspace = {
      ...BASE_IDENTITY,
      workspaceId: BASE_IDENTITY.workspaceId + 1,
      channelConnectionId: BASE_IDENTITY.channelConnectionId + 2,
    };
    await commitSuccess(BASE_IDENTITY, "erase-current-epoch");
    await commitSuccess(oldConnection, "erase-old-connection-epoch");
    await commitSuccess(otherWorkspace, "keep-other-workspace");

    await eraseMessengerImageQuotaForUser({
      workspaceId: BASE_IDENTITY.workspaceId,
      channelConnectionId: BASE_IDENTITY.channelConnectionId,
      privacyEpoch: BASE_IDENTITY.privacyEpoch + 1,
      userKey: BASE_IDENTITY.userKey,
    });

    await expect(
      reserveMessengerImageQuota(BASE_IDENTITY, "late-old-reservation")
    ).rejects.toBeInstanceOf(MessengerPrivacyFenceError);
    await expect(
      getMessengerImageQuotaStatus(oldConnection)
    ).rejects.toBeInstanceOf(MessengerPrivacyFenceError);
    await expect(
      getMessengerImageQuotaStatus({
        ...BASE_IDENTITY,
        privacyEpoch: BASE_IDENTITY.privacyEpoch + 2,
      })
    ).resolves.toMatchObject({
      daily: { used: 0 },
      monthly: { used: 0 },
    });
    await expect(
      getMessengerImageQuotaStatus(otherWorkspace)
    ).resolves.toMatchObject({
      daily: { used: 1 },
      monthly: { used: 1 },
    });
  });

  it("uses the Brussels calendar through the repeated DST hour", async () => {
    // 00:30 UTC is 02:30 CEST on the DST-ending day.
    vi.setSystemTime(new Date("2026-10-25T00:30:00.000Z"));
    await commitSuccess(BASE_IDENTITY, "before-repeated-hour");

    // 01:30 UTC is 02:30 CET: same local date, despite the repeated hour.
    vi.setSystemTime(new Date("2026-10-25T01:30:00.000Z"));
    await expect(
      getMessengerImageQuotaStatus(BASE_IDENTITY)
    ).resolves.toMatchObject({
      daily: { used: 1, remaining: 4 },
      monthly: { used: 1, remaining: 19 },
    });

    // The next local midnight is 23:00 UTC after the offset changes to CET.
    vi.setSystemTime(new Date("2026-10-25T23:00:00.000Z"));
    await expect(
      getMessengerImageQuotaStatus(BASE_IDENTITY)
    ).resolves.toMatchObject({
      daily: { used: 0, remaining: 5 },
      monthly: { used: 1, remaining: 19 },
    });
  });
});

async function reserve(
  identity: MessengerImageQuotaIdentity,
  requestId: string
): Promise<MessengerImageQuotaReservation> {
  const decision = await reserveMessengerImageQuota(identity, requestId);
  expect(decision).toMatchObject({ status: "reserved" });
  if (decision.status !== "reserved") {
    throw new Error(`Expected a reservation, received ${decision.status}`);
  }
  return decision.reservation;
}

async function commitSuccess(
  identity: MessengerImageQuotaIdentity,
  requestId: string
) {
  const reservation = await reserve(identity, requestId);
  const result = await commitMessengerImageQuotaSuccess(identity, reservation);
  expect(result).toMatchObject({
    committed: true,
    alreadyCommitted: false,
  });
  return result;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
