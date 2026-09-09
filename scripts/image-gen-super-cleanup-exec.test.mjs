import { afterEach, describe, expect, it, vi } from "vitest";

import { ROOT_MYSQL_REMOTE_COMMAND } from "./provision-image-gen-credit-provisioner.mjs";
import {
  CREDIT_MIGRATION_PRINCIPAL_REPAIR_LOCK as LOCK,
  CreditMigrationPrincipalCleanupError,
} from "./image-gen-credit-migration-principal-repair-contract.mjs";
import {
  buildSuperCleanupExecBatch,
  parseSuperCleanupExecResponse,
  requestSuperCleanupExec,
  revokeTemporaryCreditMigrationSuperViaExec,
  superCleanupLockNames,
} from "./image-gen-super-cleanup-exec.mjs";
import { executeSuperCleanup } from "./repair-image-gen-credit-migration-principal.mjs";

const NONCE = "a".repeat(32);
const ACCOUNT = { username: "credit_migrator", hostname: "%" };
const TARGET = { app: "leaderbot-portal-mysql", machineId: "080d3ddb5099e8" };
const GRANTS = [
  "GRANT USAGE ON *.* TO `credit_migrator`@`%`",
  "GRANT CREATE TEMPORARY TABLES, ALTER, INDEX, REFERENCES, SELECT, INSERT, UPDATE ON `leaderbot`.* TO `credit_migrator`@`%`",
];
const SUPER = "GRANT SUPER ON *.* TO `credit_migrator`@`%`";
const marker = (result = "revoked", nonce = NONCE) =>
  `__lb_super_cleanup_${nonce}:${result}\n`;
const responseBody = (changes = {}) => ({
  exit_code: 0,
  exit_signal: 0,
  stdout: marker(),
  stderr: "",
  ...changes,
});
const response = (value = responseBody()) =>
  new Response(JSON.stringify(value));

afterEach(() => vi.restoreAllMocks());

describe("fixed one-request Fly cleanup transport", () => {
  function input() {
    return {
      ...TARGET,
      stdin: "DO 0;\n",
      nonce: NONCE,
      signal: new AbortController().signal,
    };
  }

  it("sends bounded stdin through the unchanged exact command and fixed API URL", async () => {
    const fetchImpl = vi.fn(async () => response());
    await expect(
      requestSuperCleanupExec(input(), {
        fetchImpl,
        token: "synthetic-test-token",
      }),
    ).resolves.toBe("revoked");
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      "https://api.machines.dev/v1/apps/leaderbot-portal-mysql/machines/080d3ddb5099e8/exec",
    );
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(JSON.parse(init.body)).toEqual({
      cmd: ROOT_MYSQL_REMOTE_COMMAND,
      stdin: "DO 0;\n",
      timeout: 40,
    });
    expect(init.body).not.toContain("synthetic-test-token");
  });

  it.each([
    { app: "another-app" },
    { machineId: null },
    { machineId: 12345678901234 },
    { machineId: [TARGET.machineId] },
    { machineId: "../different" },
    { stdin: "" },
    { stdin: "x".repeat(16_385) },
    { nonce: "wrong" },
  ])(
    "rejects malformed request identity/size before dispatch: %j",
    async (changes) => {
      const fetchImpl = vi.fn();
      await expect(
        requestSuperCleanupExec(
          { ...input(), ...changes },
          { fetchImpl, token: "synthetic" },
        ),
      ).rejects.toBeInstanceOf(CreditMigrationPrincipalCleanupError);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    [],
    { exit_code: "0" },
    { exit_code: null },
    { exit_code: 1 },
    { exit_signal: 9 },
    { exit_signal: "0" },
    { exit_signal: null },
    { stderr: "private provider diagnostic" },
    { stdout: marker("revoked", "b".repeat(32)) },
    { stdout: `extra\n${marker()}` },
    { stdout: marker().trim() },
    { stdout: "cleanup_incomplete\n" },
  ])(
    "rejects malformed/non-success remote output without echoing it: %j",
    async (changes) => {
      const body =
        changes === null || Array.isArray(changes)
          ? changes
          : { ...responseBody(), ...changes };
      const fetchImpl = vi.fn(async () => response(body));
      let caught;
      try {
        await requestSuperCleanupExec(input(), {
          fetchImpl,
          token: "synthetic",
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(CreditMigrationPrincipalCleanupError);
      expect(String(caught)).not.toContain("private provider diagnostic");
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("requires an own exit code and permits only absent or zero exit signal", () => {
    const inherited = Object.assign(Object.create({ exit_code: 0 }), {
      stdout: marker(),
      stderr: "",
    });
    expect(() => parseSuperCleanupExecResponse(inherited, NONCE)).toThrow();
    const oldShape = responseBody();
    delete oldShape.exit_signal;
    expect(parseSuperCleanupExecResponse(oldShape, NONCE)).toBe("revoked");
  });

  it.each([
    () =>
      new Response("redirect", {
        status: 302,
        headers: { location: "https://untrusted.invalid" },
      }),
    () => new Response("error", { status: 503 }),
    () => new Response("not-json"),
    () => new Response("x".repeat(4_097)),
    () => new Response("{}", { headers: { "content-length": "4097" } }),
    () => new Response("{}", { headers: { "content-length": "unknown" } }),
  ])(
    "rejects invalid HTTP/body responses with no automatic retry",
    async (makeResponse) => {
      const fetchImpl = vi.fn(async () => makeResponse());
      await expect(
        requestSuperCleanupExec(input(), { fetchImpl, token: "synthetic" }),
      ).rejects.toBeInstanceOf(CreditMigrationPrincipalCleanupError);
      expect(fetchImpl).toHaveBeenCalledOnce();
    },
  );

  it("does not retry an ambiguous transport rejection", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("private network response");
    });
    await expect(
      requestSuperCleanupExec(input(), { fetchImpl, token: "synthetic" }),
    ).rejects.toThrow("cleanup incomplete");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not accept force-mode error output even beside a success marker and exit zero", async () => {
    const fetchImpl = vi.fn(async () =>
      response(responseBody({ stderr: "ERROR 1064 (42000)" })),
    );
    await expect(
      requestSuperCleanupExec(input(), { fetchImpl, token: "synthetic" }),
    ).rejects.toThrow("cleanup incomplete");
  });
});

function protocolHarness({
  noSuper = false,
  otherSuper = false,
  wrongRoot = false,
  missingApproval = false,
} = {}) {
  const locks = superCleanupLockNames(NONCE);
  const owners = new Map();
  let superPresent = !noSuper;
  let complete;
  const controller = new AbortController();
  const rootId = 99;
  const controllerId = 17;
  const stages = [];
  const connection = {
    query: vi.fn(async ({ sql }, values = []) => {
      const name = values[0];
      let value;
      if (sql === "SELECT CONNECTION_ID()") value = controllerId;
      else if (sql === "SELECT GET_LOCK(?,0)") {
        value = owners.has(name) ? 0 : 1;
        if (value && !(missingApproval && name === locks.preApprove))
          owners.set(name, controllerId);
      } else if (sql === "SELECT IS_USED_LOCK(?)")
        value = owners.get(name) ?? null;
      else if (sql === "SELECT RELEASE_LOCK(?)") {
        value = owners.get(name) === controllerId ? 1 : 0;
        if (value) owners.delete(name);
        if (name === locks.preWait) {
          if (owners.get(locks.preApprove) !== controllerId) {
            for (const [lock, owner] of owners)
              if (owner === rootId) owners.delete(lock);
            complete(
              Promise.reject(new CreditMigrationPrincipalCleanupError()),
            );
          } else {
            superPresent = false;
            owners.set(locks.preWait, rootId);
            owners.set(locks.done, rootId);
          }
        }
        if (name === locks.postWait) {
          for (const [lock, owner] of owners)
            if (owner === rootId) owners.delete(lock);
          complete(
            otherSuper
              ? Promise.reject(new CreditMigrationPrincipalCleanupError())
              : noSuper
                ? "already_revoked"
                : "revoked",
          );
        }
      } else throw new Error("unexpected fixture query");
      return [[{ value }]];
    }),
    destroy: vi.fn(() => {
      for (const [lock, owner] of owners)
        if (owner === controllerId) owners.delete(lock);
    }),
    end: vi.fn(async () => undefined),
  };
  const request = vi.fn(async () => {
    owners.set(LOCK, wrongRoot ? 123 : rootId);
    owners.set(locks.ready, rootId);
    return new Promise((resolve) => {
      complete = resolve;
    });
  });
  const readState = vi.fn(async () => ({
    account: ACCOUNT,
    databaseName: "leaderbot",
    grants: [...GRANTS, ...(superPresent ? [SUPER] : [])],
  }));
  const verify = vi.fn(async () => {
    expect(superPresent).toBe(false);
  });
  const options = {
    ...TARGET,
    connection,
    account: ACCOUNT,
    databaseName: "leaderbot",
    allowIncompleteDefinerTablePrivileges: true,
    readState,
    verify,
    signal: controller.signal,
    onStage: (stage) => stages.push(stage),
  };
  return {
    connection,
    request,
    readState,
    verify,
    controller,
    owners,
    locks,
    stages,
    options,
    superPresent: () => superPresent,
    execute: () =>
      revokeTemporaryCreditMigrationSuperViaExec(options, {
        request,
        nonce: NONCE,
        pause: async () => undefined,
      }),
  };
}

describe("one-root-session approval protocol", () => {
  it.each([false, true])(
    "checks old-0016 scope under the same root lock, then verifies before completion (no-op: %s)",
    async (noSuper) => {
      const h = protocolHarness({ noSuper });
      await expect(h.execute()).resolves.toBe(
        noSuper ? "already_revoked" : "revoked",
      );
      expect(h.request).toHaveBeenCalledOnce();
      expect(h.readState).toHaveBeenCalledOnce();
      expect(h.verify).toHaveBeenCalledOnce();
      expect(h.owners.size).toBe(0);
      expect(h.connection.destroy).not.toHaveBeenCalled();
      expect(h.stages).toEqual([
        "root_exec_request",
        "root_lock",
        "super_cleanup",
        "root_exec_response",
      ]);
    },
  );

  it.each([
    { wrongRoot: true },
    { missingApproval: true },
    { otherSuper: true },
  ])("refuses broken lock/aggregate proof: %j", async (options) => {
    const h = protocolHarness(options);
    await expect(h.execute()).rejects.toBeInstanceOf(
      CreditMigrationPrincipalCleanupError,
    );
    expect(h.connection.destroy).toHaveBeenCalledOnce();
    expect(h.request).toHaveBeenCalledOnce();
    if (options.wrongRoot || options.missingApproval)
      expect(h.superPresent()).toBe(true);
  });

  it.each(["account", "databaseName", "grants"])(
    "rejects changed %s before approval",
    async (key) => {
      const h = protocolHarness();
      const changed =
        key === "account"
          ? { ...ACCOUNT, username: "other" }
          : key === "databaseName"
            ? "other"
            : [...GRANTS, "GRANT PROCESS ON *.* TO `credit_migrator`@`%`"];
      h.readState.mockResolvedValue({
        account: ACCOUNT,
        databaseName: "leaderbot",
        grants: GRANTS,
        [key]: changed,
      });
      await expect(h.execute()).rejects.toThrow("cleanup incomplete");
      expect(h.superPresent()).toBe(true);
      expect(h.verify).not.toHaveBeenCalled();
      expect(h.connection.destroy).toHaveBeenCalledOnce();
    },
  );

  it.each(["pre", "post"])(
    "abort cancels a hanging %s verifier without subsequent queries or retry",
    async (stage) => {
      const h = protocolHarness();
      let reached;
      const entered = new Promise((resolve) => {
        reached = resolve;
      });
      (stage === "pre" ? h.readState : h.verify).mockImplementation(
        async () => {
          reached();
          return new Promise(() => {});
        },
      );
      const run = h.execute();
      await entered;
      const calls = h.connection.query.mock.calls.length;
      h.controller.abort();
      await expect(run).rejects.toThrow("cleanup incomplete");
      expect(h.connection.destroy).toHaveBeenCalledOnce();
      expect(h.connection.query.mock.calls.length).toBe(calls);
      expect([...h.owners.values()]).not.toContain(17);
      expect(h.request).toHaveBeenCalledOnce();
      expect(h.superPresent()).toBe(stage === "pre");
    },
  );

  it("the total deadline cancels a hanging verifier", async () => {
    const h = protocolHarness();
    const expiry = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(expiry.signal);
    let reached;
    const entered = new Promise((resolve) => {
      reached = resolve;
    });
    h.readState.mockImplementation(async () => {
      reached();
      return new Promise(() => {});
    });
    const run = h.execute();
    await entered;
    expiry.abort();
    await expect(run).rejects.toThrow("cleanup incomplete");
    expect(AbortSignal.timeout).toHaveBeenCalledWith(45_000);
    expect(h.connection.destroy).toHaveBeenCalledOnce();
    expect(h.superPresent()).toBe(true);
  });

  it("a throwing destroy cannot escape abort or turn a hanging check into success", async () => {
    const h = protocolHarness();
    let reached;
    const entered = new Promise((resolve) => {
      reached = resolve;
    });
    h.readState.mockImplementation(async () => {
      reached();
      return new Promise(() => {});
    });
    h.connection.destroy.mockImplementation(() => {
      throw new Error("synthetic teardown failure");
    });
    const run = h.execute();
    await entered;
    const calls = h.connection.query.mock.calls.length;
    expect(() => h.controller.abort()).not.toThrow();
    await expect(run).rejects.toThrow("cleanup incomplete");
    expect(h.connection.query.mock.calls.length).toBe(calls);
    expect(h.connection.destroy).toHaveBeenCalledOnce();
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.superPresent()).toBe(true);
  });

  it.each([
    "root_exec_request",
    "root_lock",
    "super_cleanup",
    "root_exec_response",
  ])(
    "a failed %s stage never produces cleanup success",
    async (failedStage) => {
      const h = protocolHarness();
      h.options.onStage = (stage) => {
        if (stage === failedStage) throw new Error("synthetic stage failure");
      };
      await expect(h.execute()).rejects.toThrow("cleanup incomplete");
      expect(h.connection.destroy).toHaveBeenCalledOnce();
      expect([...h.owners.values()]).not.toContain(17);
      expect(h.request).toHaveBeenCalledTimes(
        ["root_exec_request", "root_lock"].includes(failedStage) ? 0 : 1,
      );
      expect(h.superPresent()).toBe(failedStage !== "root_exec_response");
    },
  );

  it("serializes exactly one specific REVOKE and no grants, procedures or credentials", () => {
    const sql = buildSuperCleanupExecBatch({
      account: ACCOUNT,
      databaseName: "leaderbot",
      controllerId: 17,
      nonce: NONCE,
    });
    expect(sql.match(/REVOKE SUPER ON \*\.\* FROM/g)).toHaveLength(1);
    expect(sql).not.toMatch(
      /GRANT |CREATE PROCEDURE|CREATE TABLE|MYSQL_PWD|PASSWORD/,
    );
    expect(sql).toContain(
      "IS_USED_LOCK('leaderbot_credit_migration_principal_repair_v1')=@root_id",
    );
    expect(sql).toContain(
      "User NOT IN ('root','mysql.infoschema','mysql.session','mysql.sys')",
    );
    expect(sql).toContain("cleanup_incomplete");
  });

  it("driver retains phase/identity/grant verification and delegates only cleanup to Exec", async () => {
    const h = protocolHarness();
    const readPhase = vi.fn(async () => "0016_expand");
    const runCleanup = vi.fn(async (input) =>
      revokeTemporaryCreditMigrationSuperViaExec(input, {
        request: h.request,
        nonce: NONCE,
      }),
    );
    await expect(
      executeSuperCleanup(
        { ...TARGET, operation: "revoke-super" },
        {
          migrationUrl:
            "mysql://credit_migrator:synthetic@127.0.0.1:13306/leaderbot",
          mysql: { createConnection: async () => h.connection },
          runCleanup,
          readPhase,
          readState: h.readState,
          signal: h.controller.signal,
        },
      ),
    ).resolves.toBe("revoked");
    expect(runCleanup).toHaveBeenCalledOnce();
    expect(
      runCleanup.mock.calls[0][0].allowIncompleteDefinerTablePrivileges,
    ).toBe(true);
    expect(readPhase).toHaveBeenCalledTimes(3);
    expect(h.connection.end).toHaveBeenCalledOnce();
  });
});
