import { describe, expect, it, vi } from "vitest";

import {
  CREDIT_MIGRATION_PRINCIPAL_REPAIR_LOCK,
  CREDIT_MIGRATION_PRINCIPAL_REPAIR_PRIVILEGES,
  detectMissingCreditMigrationPrivileges,
} from "./image-gen-credit-migration-principal-repair-contract.mjs";
import {
  buildPrincipalPrepareExecBatch,
  parsePrincipalPrepareExecStdout,
  principalPrepareLockNames,
  requestPrincipalPrepareExec,
} from "./image-gen-principal-prepare-exec.mjs";
import { prepareCreditMigrationPrincipalViaExec } from "./image-gen-principal-prepare-driver.mjs";
import {
  PREPARE_HANDSHAKE_SECONDS,
  PREPARE_SQL_LOCK_WAIT_SECONDS,
  PREPARE_EXEC_SECONDS,
  PREPARE_DEADLINE_MS,
  buildPrepareRootExecArgv,
} from "./provision-image-gen-credit-provisioner-exec.mjs";

const NONCE = "a".repeat(32);
const ACCOUNT = Object.freeze({ username: "lbmigrate", hostname: "%" });
const TARGET = Object.freeze({
  app: "leaderbot-portal-mysql",
  machineId: "e82340db573078",
});
const PRIVILEGES = CREDIT_MIGRATION_PRINCIPAL_REPAIR_PRIVILEGES;
const LOCK = CREDIT_MIGRATION_PRINCIPAL_REPAIR_LOCK;
const SUPER_BIT = 16;

// The same account shape the repair contract tests use, so the driver runs
// against the real privilege detector rather than a stand-in.
const BASE_GRANTS = Object.freeze([
  "GRANT USAGE ON *.* TO `credit_migrator`@`%`",
  "GRANT CREATE TEMPORARY TABLES, ALTER, INDEX, REFERENCES, SELECT, INSERT, UPDATE ON `leaderbot`.* TO `credit_migrator`@`%`",
  "GRANT DELETE ON `leaderbot`.`billing_intents` TO `credit_migrator`@`%`",
  "GRANT CREATE, DELETE ON `leaderbot`.`credit_wallets` TO `credit_migrator`@`%`",
]);
const COMPLETE_SCHEMA_GRANT =
  "GRANT CREATE, TRIGGER, CREATE ROUTINE, ALTER ROUTINE ON `leaderbot`.* TO `credit_migrator`@`%`";
const SUPER_GRANT = "GRANT SUPER ON *.* TO `credit_migrator`@`%`";

function batch(overrides = {}) {
  return buildPrincipalPrepareExecBatch({
    account: ACCOUNT,
    databaseName: "leaderbot",
    controllerId: 42,
    nonce: NONCE,
    requireSuper: true,
    superOnly: false,
    ...overrides,
  });
}

describe("principal prepare batch", () => {
  it("leaves compensation and response time beyond all bounded waits", () => {
    expect(PREPARE_EXEC_SECONDS).toBeGreaterThanOrEqual(
      3 * PREPARE_HANDSHAKE_SECONDS + 4 * PREPARE_SQL_LOCK_WAIT_SECONDS + 10,
    );
    expect(PREPARE_DEADLINE_MS).toBeGreaterThanOrEqual(
      (PREPARE_EXEC_SECONDS + 5) * 1000,
    );
    const sql = batch();
    expect(sql).toContain(
      `SET SESSION lock_wait_timeout=${PREPARE_SQL_LOCK_WAIT_SECONDS}`,
    );
    for (const key of ["preWait", "decisionWait", "finishWait"]) {
      expect(sql).toContain(
        `GET_LOCK('${principalPrepareLockNames(NONCE)[key]}',${PREPARE_HANDSHAKE_SECONDS})`,
      );
    }
    expect(() => buildPrepareRootExecArgv(sql)).not.toThrow();
    expect(Buffer.byteLength(sql)).toBeLessThanOrEqual(16_384);
  });

  it.each([
    ["a foreign database", { databaseName: "other" }],
    ["a zero controller id", { controllerId: 0 }],
    ["a fractional controller id", { controllerId: 1.5 }],
    ["a malformed nonce", { nonce: "short" }],
    ["a non-boolean requireSuper", { requireSuper: "yes" }],
    ["a non-boolean superOnly", { superOnly: 1 }],
    ["the root account", { account: { username: "root", hostname: "%" } }],
    [
      "a wildcard-free host",
      { account: { username: "lbmigrate", hostname: "10.0.0.1" } },
    ],
  ])("refuses %s", (_label, overrides) => {
    expect(() => batch(overrides)).toThrow();
  });

  it("holds one lock for the whole batch and releases it at the end", () => {
    const sql = batch();

    expect(sql).toContain("SET @main=GET_LOCK(");
    expect(sql).toContain("SET @released_main=IF(@main=1,RELEASE_LOCK(");
    // Every decision is re-tied to the connection that took the lock.
    expect(sql).toContain("CONNECTION_ID()=@root_id");
    expect(sql.match(/CONNECTION_ID\(\)=@root_id/g).length).toBeGreaterThan(3);
  });

  it("reads the privilege delta only from controller approval locks", () => {
    const locks = principalPrepareLockNames(NONCE);
    const sql = batch({ controllerId: 42 });

    for (const [index] of PRIVILEGES.entries()) {
      expect(sql).toContain(`IS_USED_LOCK('${locks[`delta${index}`]}')=42`);
    }
    expect(sql).toContain(`IS_USED_LOCK('${locks.preApprove}')=42`);
    expect(sql).toContain(`IS_USED_LOCK('${locks.accept}')=42`);
    expect(sql).toContain(`IS_USED_LOCK('${locks.finishApprove}')=42`);
  });

  it("never grants a privilege the account already holds", () => {
    expect(batch()).toContain("(@delta & @before_mask)=0");
  });

  it("confines superOnly to SUPER and non-super runs away from SUPER", () => {
    expect(batch({ superOnly: true })).toContain("(@delta & 15)=0");
    expect(batch({ superOnly: false })).not.toContain("(@delta & 15)=0");
    expect(batch({ requireSuper: false })).toContain(
      `(@delta & ${SUPER_BIT})=0`,
    );
    expect(batch({ requireSuper: true })).not.toContain(
      `SET @allowed=COALESCE(@main=1 AND @ready=1 AND @pre_wait=1 AND CONNECTION_ID()=@root_id AND IS_USED_LOCK('${principalPrepareLockNames(NONCE).ready}')`,
    );
  });

  it("rolls back exactly the rights it added when acceptance is withheld", () => {
    const sql = batch();

    // The compensation set is the intersection of the approved delta and what
    // is actually present, computed while the same connection holds the lock.
    expect(sql).toContain("SET @added=IF(@allowed=1 AND @accepted=0 AND");
    expect(sql).toContain(`@delta & (`);
    expect(sql).toMatch(/REVOKE[^']*SUPER/);
    expect(sql).toContain("CASE (@added & 15)");
  });

  it("reports incomplete unless every stage and every release succeeded", () => {
    const sql = batch();

    expect(sql).toContain("'prepare_incomplete'");
    for (const variable of [
      "@passed=1",
      "@released_main=1",
      "@released_pre_wait=1",
      "@released_decision_wait=1",
      "@released_finish_wait=1",
      "@released_ready=1",
      "@released_applied=1",
      "@released_settled=1",
    ]) {
      expect(sql).toContain(variable);
    }
  });

  it("stays a single bounded statement list with no escape characters", () => {
    const sql = batch();

    expect(Buffer.byteLength(sql)).toBeLessThan(16_384);
    expect(sql.includes("\\")).toBe(false);
    expect(sql.includes("\0")).toBe(false);
    expect(sql.endsWith(";\n")).toBe(true);
  });
});

describe("principal prepare response", () => {
  it.each(["repaired", "already_ready", "rolled_back"])(
    "accepts the %s marker for this nonce only",
    (result) => {
      expect(
        parsePrincipalPrepareExecStdout(
          `__lb_principal_prepare_${NONCE}:${result}\n`,
          NONCE,
        ),
      ).toBe(result);
      expect(() =>
        parsePrincipalPrepareExecStdout(
          `__lb_principal_prepare_${"b".repeat(32)}:${result}\n`,
          NONCE,
        ),
      ).toThrow();
    },
  );

  it.each([
    ["an incomplete batch", "prepare_incomplete\n"],
    ["a truncated marker", `__lb_principal_prepare_${NONCE}:repaired`],
    ["empty output", ""],
    ["a non-string", null],
  ])("refuses %s", (_label, stdout) => {
    expect(() => parsePrincipalPrepareExecStdout(stdout, NONCE)).toThrow();
  });

  it("refuses an aborted signal before requesting anything", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      requestPrincipalPrepareExec({
        ...TARGET,
        sql: "DO 0;",
        nonce: NONCE,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});

// A small MySQL advisory-lock simulator. It is deliberately faithful about the
// two properties the protocol depends on: a lock belongs to exactly one
// connection, and the root batch is a different connection from the controller.
// Real SHOW GRANTS output for each starting state, so the driver exercises
// the production privilege detector instead of a hand-written missing list.
function grantsFor(present) {
  if (present === 0) return [...BASE_GRANTS];
  if (present === 15) return [...BASE_GRANTS, COMPLETE_SCHEMA_GRANT];
  if (present === 31)
    return [...BASE_GRANTS, COMPLETE_SCHEMA_GRANT, SUPER_GRANT];
  throw new Error(`no grant fixture for mask ${present}`);
}

function harness({
  present = 0,
  verifyThrows = false,
  rootIsController = false,
  rootSkipsLock = false,
} = {}) {
  const CONTROLLER_ID = 100;
  const ROOT_ID = rootIsController ? CONTROLLER_ID : 200;
  const locks = new Map();
  const state = { mask: present };
  const acquire = (name, id) => {
    if (locks.has(name)) return 0;
    locks.set(name, id);
    return 1;
  };
  const release = (name, id) => {
    if (locks.get(name) !== id) return 0;
    locks.delete(name);
    return 1;
  };
  const usedBy = (name) => locks.get(name) ?? 0;

  const connection = {
    query: vi.fn(async ({ sql }, values = []) => {
      const [name] = values;
      if (sql === "SELECT CONNECTION_ID()")
        return [[{ id: CONTROLLER_ID }], []];
      if (sql === "SELECT GET_LOCK(?,0)")
        return [[{ v: acquire(name, CONTROLLER_ID) }], []];
      if (sql === "SELECT RELEASE_LOCK(?)")
        return [[{ v: release(name, CONTROLLER_ID) }], []];
      if (sql === "SELECT IS_USED_LOCK(?)") return [[{ v: usedBy(name) }], []];
      throw new Error(`unexpected query ${sql}`);
    }),
    destroy: vi.fn(),
  };

  const rootBatch = async ({ nonce }) => {
    const l = principalPrepareLockNames(nonce);
    const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
    const until = async (predicate) => {
      for (let i = 0; i < 400; i += 1) {
        if (predicate()) return true;
        await settle();
      }
      return false;
    };
    if (!rootSkipsLock && acquire(LOCK, ROOT_ID) !== 1) throw new Error("lock");
    acquire(l.ready, ROOT_ID);
    if (!(await until(() => !locks.has(l.preWait)))) throw new Error("pre");
    const delta = PRIVILEGES.reduce(
      (mask, _privilege, index) =>
        mask + (usedBy(l[`delta${index}`]) === CONTROLLER_ID ? 1 << index : 0),
      0,
    );
    const allowed =
      usedBy(l.preApprove) === CONTROLLER_ID && (delta & state.mask) === 0;
    const before = state.mask;
    if (allowed) state.mask |= delta;
    acquire(l.applied, ROOT_ID);
    if (!(await until(() => !locks.has(l.decisionWait))))
      throw new Error("decision");
    const accepted = allowed && usedBy(l.accept) === CONTROLLER_ID;
    if (!accepted) state.mask = before;
    acquire(l.settled, ROOT_ID);
    if (!(await until(() => !locks.has(l.finishWait))))
      throw new Error("finish");
    if (usedBy(l.finishApprove) !== CONTROLLER_ID) throw new Error("approve");
    for (const key of ["ready", "applied", "settled"]) release(l[key], ROOT_ID);
    release(LOCK, ROOT_ID);
    if (!accepted) return "rolled_back";
    return delta === 0 ? "already_ready" : "repaired";
  };

  const missing = detectMissingCreditMigrationPrivileges({
    databaseName: "leaderbot",
    grants: grantsFor(present),
    requireSuper: true,
  });

  return {
    connection,
    state,
    locks,
    request: vi.fn(rootBatch),
    input: {
      ...TARGET,
      connection,
      account: ACCOUNT,
      databaseName: "leaderbot",
      requireSuper: true,
      readState: async () => ({
        account: ACCOUNT,
        databaseName: "leaderbot",
        requireSuper: true,
        grants: grantsFor(present),
      }),
      verify: async () => {
        if (verifyThrows) throw new Error("verification failed");
      },
      verifyRollback: vi.fn(async () => {}),
      signal: new AbortController().signal,
    },
    missing,
  };
}

describe("principal prepare driver", () => {
  it("grants exactly the missing privileges and reports repaired", async () => {
    const h = harness({ present: 0 });

    await expect(
      prepareCreditMigrationPrincipalViaExec(h.input, {
        request: h.request,
        pause: (ms) => new Promise((r) => setTimeout(r, 1)),
      }),
    ).resolves.toBe("repaired");

    expect(h.state.mask).toBe(31);
    expect(h.request).toHaveBeenCalledTimes(1);
    // Every controller lock is released on the happy path.
    expect([...h.locks.keys()]).toHaveLength(0);
  });

  it("reports already_ready and approves nothing when rights are present", async () => {
    const h = harness({ present: 31 });

    await expect(
      prepareCreditMigrationPrincipalViaExec(h.input, {
        request: h.request,
        pause: () => new Promise((r) => setTimeout(r, 1)),
      }),
    ).resolves.toBe("already_ready");

    expect(h.state.mask).toBe(31);
    expect([...h.locks.keys()]).toHaveLength(0);
  });

  it("rolls the grant back and rejects when verification fails", async () => {
    const h = harness({ present: 0, verifyThrows: true });

    await expect(
      prepareCreditMigrationPrincipalViaExec(h.input, {
        request: h.request,
        pause: () => new Promise((r) => setTimeout(r, 1)),
      }),
    ).rejects.toThrow("credit migration principal repair rejected");

    // The account is left exactly as it was found.
    expect(h.state.mask).toBe(0);
    expect(h.input.verifyRollback).toHaveBeenCalledWith(h.missing);
    expect(h.request).toHaveBeenCalledTimes(1);
  });

  it("refuses a root batch that shares the controller connection", async () => {
    const h = harness({ present: 0, rootIsController: true });

    await expect(
      prepareCreditMigrationPrincipalViaExec(h.input, {
        request: h.request,
        pause: () => new Promise((r) => setTimeout(r, 1)),
      }),
    ).rejects.toThrow();
    expect(h.connection.destroy).toHaveBeenCalled();
  });

  it("refuses a root batch that never took the repair lock", async () => {
    const h = harness({ present: 0, rootSkipsLock: true });

    await expect(
      prepareCreditMigrationPrincipalViaExec(h.input, {
        request: h.request,
        pause: () => new Promise((r) => setTimeout(r, 1)),
      }),
    ).rejects.toThrow();
    expect(h.connection.destroy).toHaveBeenCalled();
  });

  it("never opens a second mutating request when the first fails", async () => {
    const h = harness({ present: 0 });
    const request = vi.fn(async () => {
      throw new Error("transport");
    });

    await expect(
      prepareCreditMigrationPrincipalViaExec(h.input, {
        request,
        pause: () => new Promise((r) => setTimeout(r, 1)),
      }),
    ).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
    expect(h.connection.destroy).toHaveBeenCalled();
  });

  it.each([
    ["a foreign database", { databaseName: "other" }],
    ["a missing verifier", { verify: undefined }],
    ["a missing rollback verifier", { verifyRollback: undefined }],
    [
      "superOnly together with incomplete definer rights",
      {
        superOnly: true,
        allowIncompleteDefinerTablePrivileges: true,
      },
    ],
    ["an already aborted signal", { signal: AbortSignal.abort() }],
  ])("refuses %s before requesting anything", async (_label, overrides) => {
    const h = harness({ present: 0 });

    await expect(
      prepareCreditMigrationPrincipalViaExec(
        { ...h.input, ...overrides },
        { request: h.request },
      ),
    ).rejects.toThrow();
    expect(h.request).not.toHaveBeenCalled();
  });

  it("refuses superOnly when a non-SUPER privilege is missing", async () => {
    const h = harness({ present: 0 });

    await expect(
      prepareCreditMigrationPrincipalViaExec(
        { ...h.input, superOnly: true },
        {
          request: h.request,
          pause: () => new Promise((r) => setTimeout(r, 1)),
        },
      ),
    ).rejects.toThrow();
    expect(h.state.mask).toBe(0);
  });
});
