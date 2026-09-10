import { describe, expect, it } from "vitest";
import { collectCreditTestSessionInventory } from "./credit-test-session-inventory.mjs";

const options = {
  obsoletePrincipalSha256: "a".repeat(64),
  expectedSessionId: "7",
};
function fixture({
  identity = "1\tone-thread-per-connection\t7",
  census = "2\t2\t1\t0\t0\t0",
  connections = ["10", "10"],
  connected = ["2", "2"],
} = {}) {
  const queries = [];
  return {
    queries,
    async execute(sql) {
      queries.push(sql);
      if (sql.startsWith("SELECT @@")) return [identity];
      if (sql.includes("LIKE 'Connections'"))
        return [`Connections\t${connections.shift() ?? "10"}`];
      if (sql.includes("LIKE 'Threads_connected'"))
        return [`Threads_connected\t${connected.shift() ?? "2"}`];
      return [census];
    },
  };
}
describe("draft narrow credit session census", () => {
  it("accepts a stable complete zero census and reads only four thread columns", async () => {
    const session = fixture();
    expect(await collectCreditTestSessionInventory(session, options)).toEqual({
      verified: true,
      obsoleteSessionCount: 0,
      sessionCount: "2",
      attempt: 1,
    });
    expect(session.queries.join("\n")).not.toMatch(
      /PROCESSLIST_(INFO|HOST|DB)|SELECT \*|UPDATE|GRANT/,
    );
    const census = session.queries.find((sql) =>
      sql.includes("AS internal_daemon"),
    );
    expect(census).toContain(
      "BINARY NAME='thread/sql/event_scheduler' AND BINARY PROCESSLIST_USER='event_scheduler'",
    );
    expect(census).toContain(
      "BINARY NAME='thread/sql/compress_gtid_table' AND PROCESSLIST_USER IS NULL",
    );
    // The obsolete-account check must still cover every foreground row, even
    // those excluded from the external connection total.
    expect(census).toContain(
      `COALESCE(SUM(SHA2(PROCESSLIST_USER,256)='${options.obsoletePrincipalSha256}'),0)`,
    );
    expect(census).not.toContain("WHERE internal_daemon");
  });
  it.each([
    [
      { identity: "0\tone-thread-per-connection\t7" },
      "unsupported_or_changed_session",
    ],
    [{ identity: "1\tpool-of-threads\t7" }, "unsupported_or_changed_session"],
    [
      { identity: "1\tone-thread-per-connection\t8" },
      "unsupported_or_changed_session",
    ],
    [{ census: "2\t2\t1\t1\t0\t0" }, "obsolete_sessions_present"],
    [{ census: "2\t2\t1\t0\t1\t0" }, "unknown_session_type"],
    [{ census: "2\t2\t1\t0\t0\t1" }, "unknown_session_type"],
    [{ census: "1\t1\t1\t0\t0\t0" }, "incomplete_inventory"],
    [{ census: "2\t1\t1\t0\t0\t0" }, "incomplete_inventory"],
    [{ census: "2\t2\t0\t0\t0\t0" }, "incomplete_inventory"],
    [{ census: "2\t2\t1\t0\t0\tNaN" }, "metadata_unavailable"],
  ])("fails closed for %j", async (config, reason) => {
    expect(
      await collectCreditTestSessionInventory(fixture(config), options),
    ).toMatchObject({ verified: false, reason });
  });
  it("retries only changing brackets, at most three times", async () => {
    expect(
      await collectCreditTestSessionInventory(
        fixture({ connections: ["1", "2", "3", "4", "5", "6"] }),
        options,
      ),
    ).toEqual({ verified: false, reason: "unstable_inventory", attempt: 3 });
    expect(
      await collectCreditTestSessionInventory(
        fixture({ connections: ["1", "2", "3", "3"] }),
        options,
      ),
    ).toMatchObject({ verified: true, attempt: 2 });
  });
  it("does not trust a reset lost counter to excuse missing sessions", async () => {
    const session = fixture({ census: "1\t1\t1\t0\t0\t0" });
    expect(
      await collectCreditTestSessionInventory(session, options),
    ).toMatchObject({ verified: false, reason: "incomplete_inventory" });
    expect(session.queries.join("\n")).not.toContain("instances_lost");
  });
  it("sanitizes adapter errors", async () => {
    expect(
      await collectCreditTestSessionInventory(
        {
          execute() {
            throw new Error("private SQL content");
          },
        },
        options,
      ),
    ).toEqual({ verified: false, reason: "metadata_unavailable", attempt: 1 });
  });
  it.each([
    { obsoletePrincipalSha256: "bad" },
    { expectedSessionId: "7 OR 1" },
    { maxAttempts: 4 },
  ])("rejects invalid options before SQL", async (override) => {
    const session = fixture();
    await expect(
      collectCreditTestSessionInventory(session, { ...options, ...override }),
    ).rejects.toThrow("invalid credit session inventory input");
    expect(session.queries).toHaveLength(0);
  });
});
