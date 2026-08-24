import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  drizzle: vi.fn(),
  end: vi.fn(),
}));

vi.mock("drizzle-orm/mysql2", () => ({
  drizzle: mocks.drizzle,
}));

import { closeDatabasePool, getDatabaseOrThrow } from "./db";

describe("database pool lifecycle", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubEnv("DATABASE_URL", "mysql://local.invalid/test");
    mocks.drizzle.mockReturnValue({
      $client: {
        promise: () => ({ end: mocks.end }),
      },
    });
    mocks.end.mockResolvedValue(undefined);
    await closeDatabasePool();
  });

  afterEach(async () => {
    await closeDatabasePool().catch(() => undefined);
    vi.unstubAllEnvs();
  });

  it("awaits the mysql2 promise pool close exactly once", async () => {
    await getDatabaseOrThrow();

    await expect(closeDatabasePool()).resolves.toBeUndefined();
    await expect(closeDatabasePool()).resolves.toBeUndefined();

    expect(mocks.end).toHaveBeenCalledOnce();
  });

  it("reports a pool close failure and still clears the cached database", async () => {
    const closeError = new Error("pool close failed");
    mocks.end.mockRejectedValueOnce(closeError);
    await getDatabaseOrThrow();

    await expect(closeDatabasePool()).rejects.toBe(closeError);
    await expect(closeDatabasePool()).resolves.toBeUndefined();

    expect(mocks.end).toHaveBeenCalledOnce();
  });
});
