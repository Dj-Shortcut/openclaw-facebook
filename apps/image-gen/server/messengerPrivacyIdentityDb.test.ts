import { MySqlDialect } from "drizzle-orm/mysql-core";
import { describe, expect, it, vi } from "vitest";

import {
  lockActiveMessengerPrivacyIdentity,
  lockExactActiveMessengerPrivacyIdentity,
  type ImageGenTransaction,
} from "./db";

const IDENTITY = {
  workspaceId: 42,
  channelConnectionId: 7,
  bindingEpoch: 3,
  userKey: "a".repeat(64),
  privacyEpoch: 5,
  pageId: "facebook-page-42",
} as const;

describe("Messenger privacy identity database fence", () => {
  it("locks an exact current Page binding epoch", async () => {
    const fixture = lockedIdentityTransaction([[{ id: 11 }], [{ id: 7 }]]);

    await expect(
      lockExactActiveMessengerPrivacyIdentity(fixture.tx, IDENTITY)
    ).resolves.toBeUndefined();

    expect(fixture.forUpdate).toHaveLength(2);
    expect(fixture.forUpdate[0]).toHaveBeenCalledWith("update");
    expect(fixture.forUpdate[1]).toHaveBeenCalledWith("update");

    const predicate = new MySqlDialect().sqlToQuery(fixture.where[1]!);
    expect(predicate.sql).toContain("`channelConnections`.`bindingEpoch` = ?");
    expect(predicate.params).toContain(IDENTITY.bindingEpoch);
  });

  it("fails closed when the expected Page binding epoch is stale", async () => {
    const fixture = lockedIdentityTransaction([[{ id: 11 }], []]);

    await expect(
      lockExactActiveMessengerPrivacyIdentity(fixture.tx, {
        ...IDENTITY,
        bindingEpoch: 2,
      })
    ).rejects.toThrow("Messenger Page privacy identity binding is unavailable");

    const predicate = new MySqlDialect().sqlToQuery(fixture.where[1]!);
    expect(predicate.params).toContain(2);
    expect(predicate.params).not.toContain(IDENTITY.bindingEpoch);
  });

  it("rejects an invalid exact binding epoch before reading identity state", async () => {
    const fixture = lockedIdentityTransaction([]);

    await expect(
      lockExactActiveMessengerPrivacyIdentity(fixture.tx, {
        ...IDENTITY,
        bindingEpoch: 0,
      })
    ).rejects.toThrow("Exact Messenger Page binding epoch is required");

    expect(fixture.select).not.toHaveBeenCalled();
  });

  it("keeps the bounded legacy fence available without inventing an epoch", async () => {
    const fixture = lockedIdentityTransaction([[{ id: 11 }], [{ id: 7 }]]);

    await expect(
      lockActiveMessengerPrivacyIdentity(fixture.tx, IDENTITY)
    ).resolves.toBeUndefined();

    const predicate = new MySqlDialect().sqlToQuery(fixture.where[1]!);
    expect(predicate.sql).not.toContain("`channelConnections`.`bindingEpoch`");
  });
});

function lockedIdentityTransaction(rows: unknown[][]): {
  tx: ImageGenTransaction;
  select: ReturnType<typeof vi.fn>;
  where: unknown[];
  forUpdate: Array<ReturnType<typeof vi.fn>>;
} {
  const whereExpressions: unknown[] = [];
  const locks: Array<ReturnType<typeof vi.fn>> = [];
  const select = vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn((expression: unknown) => {
        whereExpressions.push(expression);
        const selectedRows = rows.shift() ?? [];
        const forUpdate = vi.fn(async () => selectedRows);
        locks.push(forUpdate);
        return {
          limit: vi.fn(() => ({ for: forUpdate })),
        };
      }),
    })),
  }));
  return {
    tx: { select } as unknown as ImageGenTransaction,
    select,
    where: whereExpressions,
    forUpdate: locks,
  };
}
