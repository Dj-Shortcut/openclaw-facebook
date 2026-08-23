import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  eval: vi.fn(),
}));

vi.mock("./_core/redis", () => ({
  getRedisClient: vi.fn(async () => ({ eval: mocks.eval })),
}));
vi.mock("./_core/stateStore", () => ({
  deleteEphemeralKey: vi.fn(),
  deleteEphemeralKeyIfValue: vi.fn(),
  deleteScopedState: vi.fn(),
  getScopedStateStorageKey: (scope: string, key: string) => `${scope}:${key}`,
  hasEphemeralKeyValue: vi.fn(),
  isRedisStateStoreEnabled: vi.fn(() => true),
  readScopedState: vi.fn(),
  setEphemeralKeyIfAbsent: vi.fn(),
  writeScopedState: vi.fn(),
}));
vi.mock("./_core/messengerGenerationQueue", () => ({
  getMessengerGenerationJobLeaseSeconds: vi.fn(() => 900),
}));

import {
  commitMessengerImageQuotaSuccess,
  eraseMessengerImageQuotaForUser,
  getMessengerImageQuotaStatus,
  renewMessengerImageQuotaReservation,
  reserveMessengerImageQuota,
  type MessengerImageQuotaIdentity,
} from "./_core/messengerImageQuotaStore";

const identity: MessengerImageQuotaIdentity = {
  workspaceId: 101,
  channelConnectionId: 201,
  bindingEpoch: 3,
  privacyEpoch: 5,
  userKey: "a".repeat(64),
};

describe("Messenger image quota Redis contract", () => {
  beforeEach(() => {
    process.env.REDIS_URL = "redis://contract.test:6379";
    process.env.MESSENGER_FREE_DAILY_LIMIT = "5";
    process.env.MESSENGER_FREE_MONTHLY_LIMIT = "20";
    process.env.MESSENGER_IMAGE_QUOTA_TIME_ZONE = "Europe/Brussels";
    mocks.eval.mockReset().mockImplementation(async (script: string) => {
      if (script.includes("local requestedEpoch")) return 2;
      if (script.includes("return redis.call('pexpire', KEYS[1], ARGV[2])")) {
        return 1;
      }
      if (script.includes("state.dailyCount = state.dailyCount + 1")) {
        return ["committed", 1, 1];
      }
      if (script.includes("return {'active'")) return ["active", 1, 1];
      return ["reserved", 0, 0];
    });
  });

  it("keeps every Lua key in one hash slot and every ARGV position stable", async () => {
    const reserved = await reserveMessengerImageQuota(
      identity,
      "quota-contract-request"
    );
    if (reserved.status !== "reserved") {
      throw new Error(`Expected reservation, received ${reserved.status}`);
    }
    await renewMessengerImageQuotaReservation(identity, reserved.reservation);
    await commitMessengerImageQuotaSuccess(identity, reserved.reservation);
    await getMessengerImageQuotaStatus(identity);
    await eraseMessengerImageQuotaForUser({
      workspaceId: identity.workspaceId,
      channelConnectionId: identity.channelConnectionId,
      privacyEpoch: identity.privacyEpoch + 1,
      userKey: identity.userKey,
    });

    const reserveCall = mocks.eval.mock.calls[0] as unknown[];
    expectRedisCallInOneSlot(reserveCall, 4);
    const reserveArgv = reserveCall.slice(6);
    expect(reserveArgv).toHaveLength(11);
    expect(reserveArgv[3]).toBe(5);
    expect(reserveArgv[4]).toBe(20);
    expect(reserveArgv[6]).toBe(900_000);
    expect(reserveArgv[8]).toBe(50 * 24 * 60 * 60);
    expect(reserveArgv[9]).toBe(identity.privacyEpoch);
    expect(reserveArgv[10]).toMatch(/^[a-f0-9]{64}:5:[a-f0-9]{64}$/);

    const renewCall = mocks.eval.mock.calls[1] as unknown[];
    expectRedisCallInOneSlot(renewCall, 2);
    const renewArgv = renewCall.slice(4);
    expect(renewArgv).toHaveLength(3);
    expect(renewArgv[0]).toBe(reserved.reservation.token);
    expect(renewArgv[1]).toBe(900_000);
    expect(renewArgv[2]).toBe(identity.privacyEpoch);

    const commitCall = mocks.eval.mock.calls[2] as unknown[];
    expectRedisCallInOneSlot(commitCall, 4);
    const commitArgv = commitCall.slice(6);
    expect(commitArgv).toHaveLength(11);
    expect(commitArgv[3]).toBe(5);
    expect(commitArgv[4]).toBe(20);
    expect(commitArgv[8]).toBe(50 * 24 * 60 * 60);
    expect(commitArgv[9]).toBe(identity.privacyEpoch);
    expect(commitArgv[10]).toMatch(/^[a-f0-9]{64}:5:[a-f0-9]{64}$/);

    const readCall = mocks.eval.mock.calls[3] as unknown[];
    expectRedisCallInOneSlot(readCall, 3);
    const readArgv = readCall.slice(5);
    expect(readArgv).toHaveLength(6);
    expect(readArgv[3]).toBe(50 * 24 * 60 * 60);
    expect(readArgv[4]).toBe(identity.privacyEpoch);
    expect(readArgv[5]).toMatch(/^[a-f0-9]{64}:5:[a-f0-9]{64}$/);

    const eraseCall = mocks.eval.mock.calls[4] as unknown[];
    expectRedisCallInOneSlot(eraseCall, 2);
    expect(String(eraseCall[0])).toContain("'EX', ARGV[4]");
    const eraseArgv = eraseCall.slice(4);
    expect(eraseArgv).toEqual([
      identity.privacyEpoch + 1,
      expect.stringMatching(/^[^{}]*\{[^{}]+\}[^{}]*:erased:$/),
      expect.stringMatching(/^[^{}]*\{[^{}]+\}[^{}]*:$/),
      50 * 24 * 60 * 60,
    ]);

    const serializedContract = JSON.stringify(mocks.eval.mock.calls);
    expect(serializedContract).not.toContain(identity.userKey);
    expect(serializedContract).not.toContain("quota-contract-request");
  });

  it("keeps count and reservation keys stable across binding epochs", async () => {
    const reconnectedIdentity = {
      ...identity,
      bindingEpoch: identity.bindingEpoch + 1,
    };
    const newPrivacyIdentity = {
      ...reconnectedIdentity,
      privacyEpoch: identity.privacyEpoch + 1,
    };

    const first = await reserveMessengerImageQuota(identity, "binding-first");
    const reconnected = await reserveMessengerImageQuota(
      reconnectedIdentity,
      "binding-second"
    );
    await reserveMessengerImageQuota(newPrivacyIdentity, "privacy-reset");
    expect(first).toMatchObject({
      reservation: { bindingEpoch: identity.bindingEpoch },
    });
    expect(reconnected).toMatchObject({
      reservation: { bindingEpoch: reconnectedIdentity.bindingEpoch },
    });

    const firstKeys = (mocks.eval.mock.calls[0] as unknown[]).slice(2, 6);
    const reconnectKeys = (mocks.eval.mock.calls[1] as unknown[]).slice(2, 6);
    const newPrivacyKeys = (mocks.eval.mock.calls[2] as unknown[]).slice(2, 6);
    expect(reconnectKeys[0]).toBe(firstKeys[0]);
    expect(reconnectKeys[1]).toBe(firstKeys[1]);
    expect(newPrivacyKeys[0]).not.toBe(firstKeys[0]);
    expect(newPrivacyKeys[1]).not.toBe(firstKeys[1]);
  });
});

function expectRedisCallInOneSlot(call: unknown[], keyCount: number): void {
  expect(call[1]).toBe(keyCount);
  const keys = call.slice(2, 2 + keyCount).map(String);
  const tags = keys.map(key => key.match(/\{[^{}]+\}/)?.[0]);
  expect(tags.every(Boolean)).toBe(true);
  expect(new Set(tags).size).toBe(1);
}
