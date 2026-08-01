import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  workspaceEntitlements,
  workspaceEntitlementUsage,
} from "../../../drizzle/schema";

const databaseMock = vi.hoisted(() => vi.fn());
vi.mock("../../db", () => ({ getDatabaseOrThrow: databaseMock }));

import {
  parseStartpilotQuota,
  reserveStartpilotImageUsage,
  utcDateKey,
} from "./entitlementUsageStore";

const quota = {
  aiAnswersTotal: 300,
  imagesTotal: 20,
  imagesPerDay: 5,
  workspaces: 1,
  facebookPages: 1,
  imageQuality: "images_2",
} as const;

beforeEach(() => vi.clearAllMocks());

describe("Startpilot finite entitlement usage", () => {
  it("accepts only the exact cost-bounded quota snapshot", () => {
    expect(parseStartpilotQuota(quota)).toEqual(quota);
    expect(parseStartpilotQuota({ ...quota, imagesTotal: 200 })).toBeNull();
    expect(
      parseStartpilotQuota({ ...quota, imageQuality: "legacy" })
    ).toBeNull();
  });

  it("reserves an image atomically and resets only the UTC daily counter", async () => {
    const flow = usageFlow({
      imagesUsed: 7,
      imageUsageDate: "2026-07-31",
      imagesUsedToday: 5,
    });
    databaseMock.mockResolvedValue(flow.database);

    await expect(
      reserveStartpilotImageUsage({
        workspaceId: 1,
        entitlementId: 9,
        mode: "test",
        now: new Date("2026-08-01T00:00:00.000Z"),
      })
    ).resolves.toEqual({ allowed: true, imagesUsed: 8, imagesUsedToday: 1 });
    expect(flow.updateSet).toHaveBeenCalledWith({
      imagesUsed: 8,
      imageUsageDate: "2026-08-01",
      imagesUsedToday: 1,
    });
  });

  it("blocks before writing at the total and daily limits", async () => {
    const total = usageFlow({ imagesUsed: 20 });
    databaseMock.mockResolvedValue(total.database);
    await expect(
      reserveStartpilotImageUsage({
        workspaceId: 1,
        entitlementId: 9,
        mode: "test",
      })
    ).resolves.toEqual({ allowed: false, reason: "total_exhausted" });
    expect(total.updateSet).not.toHaveBeenCalled();

    const daily = usageFlow({
      imageUsageDate: utcDateKey(new Date()),
      imagesUsedToday: 5,
    });
    databaseMock.mockResolvedValue(daily.database);
    await expect(
      reserveStartpilotImageUsage({
        workspaceId: 1,
        entitlementId: 9,
        mode: "test",
      })
    ).resolves.toEqual({ allowed: false, reason: "daily_exhausted" });
    expect(daily.updateSet).not.toHaveBeenCalled();
  });
});

function usageFlow(
  overrides: Partial<{
    imagesUsed: number;
    imageUsageDate: string | null;
    imagesUsedToday: number;
  }>
) {
  const validUntil = new Date("2026-09-01T00:00:00.000Z");
  const usage = {
    id: 4,
    workspaceId: 1,
    entitlementId: 9,
    mode: "test",
    planCode: "startpilot_once_v1",
    periodEndsAt: validUntil,
    aiAnswersCommitted: 0,
    aiAnswersReserved: 0,
    imagesUsed: 0,
    imageUsageDate: utcDateKey(new Date()),
    imagesUsedToday: 0,
    ...overrides,
  };
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn((table: unknown) => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            for: vi.fn().mockResolvedValue(
              table === workspaceEntitlements
                ? [
                    {
                      id: 9,
                      workspaceId: 1,
                      mode: "test",
                      planCode: "startpilot_once_v1",
                      status: "active",
                      quota,
                      validUntil,
                    },
                  ]
                : table === workspaceEntitlementUsage
                  ? [usage]
                  : []
            ),
          })),
        })),
      })),
    })),
    update: vi.fn(() => ({ set: updateSet })),
  };
  return {
    database: {
      transaction: vi.fn(
        async (callback: (transaction: typeof tx) => Promise<unknown>) =>
          callback(tx)
      ),
    },
    updateSet,
  };
}
