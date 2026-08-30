import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import {
  MANAGED_ACCOUNT_INVENTORY_QUERY,
  PINNED_FLYCTL_VERSION,
  ROOT_MYSQL_REMOTE_COMMAND,
  attachChildStdinFailureHandler,
  bootstrapCreditProvisioner,
  buildFlyProxyArgs,
  buildRootMysqlSshArgs,
  buildSourceCiEnvironment,
  githubAuthTokenArgs,
  normalizeBootstrapMarker,
  parseCliArguments,
  parseFlyProxyPort,
  reconcileSecretAbsence,
  runCli,
  waitForFlyProxyStartup,
} from "./provision-image-gen-credit-provisioner.mjs";
import {
  CREDIT_PROVISIONER_CLEANUP_FAILURE_MARKER,
  CREDIT_PROVISIONER_FAILURE_MARKER,
  CREDIT_PROVISIONER_SECRET_NAME,
  CREDIT_PROVISIONER_SUCCESS_MARKER,
  buildExpectedProvisionerGrants,
} from "./image-gen-credit-provisioner-bootstrap-contract.mjs";

const EXPECTED_HEAD = "a".repeat(40);
const SNAPSHOT_ID = "vs_01K39M7A7WEXAMPLE3";
const USERNAME = "lbcp_0123456789abcdef";
const CONTEXT = Object.freeze({
  machine: Object.freeze({
    id: "28607e7c932038",
    private_ip: "fdaa:0:1234:a7b:42:1:abcd:2",
  }),
  recovery: Object.freeze({
    app: "leaderbot-portal-mysql",
    databaseName: "leaderbot",
  }),
  snapshot: Object.freeze({
    createdAt: "2026-08-30T07:55:00.000Z",
    digest: "d".repeat(64),
    id: SNAPSHOT_ID,
  }),
  volume: Object.freeze({ id: "vol_49165px70nx9ylzr" }),
});

function createHarness({
  failAt,
  abortAt,
  cleanupFails = false,
  proxyStopFails = false,
  repositoryChangesAfterSecret = false,
} = {}) {
  const calls = [];
  let created = false;
  let secretPresent = false;
  const controller = new AbortController();
  const grants = buildExpectedProvisionerGrants({
    databaseName: CONTEXT.recovery.databaseName,
    username: USERNAME,
  });
  const root = {
    closed: false,
    async accountExists() {
      calls.push("account-exists");
      return created;
    },
    async acquireLock() {
      calls.push("lock-acquire");
    },
    async assertLockHeld() {
      calls.push("lock-held");
    },
    async assertNoUnexpectedCreateUserPrincipal() {
      calls.push("create-user-preflight");
    },
    async close() {
      calls.push("root-close");
      this.closed = true;
    },
    async disableAndDrop() {
      calls.push("account-cleanup");
      created = false;
    },
    async execute(statement, { signal } = {}) {
      if (signal?.aborted) throw new Error("synthetic");
      calls.push(statement.startsWith("CREATE USER") ? "create" : "grant");
      if (statement.startsWith("CREATE USER")) {
        created = true;
        if (abortAt === "account") controller.abort();
      }
      if (failAt === "grant" && statement.startsWith("GRANT ")) {
        throw new Error("synthetic");
      }
      return [];
    },
    async listManagedAccounts() {
      calls.push("accounts-list");
      return created ? [{ hostname: "%", username: USERNAME }] : [];
    },
    async showGrants() {
      calls.push("grants-show");
      return grants;
    },
  };
  const deps = {
    async assertExactRepository() {
      calls.push("repository-proof");
      if (repositoryChangesAfterSecret && secretPresent) {
        throw new Error("synthetic");
      }
    },
    async assertSecretPresence(expected) {
      calls.push(`secret-${expected ? "present" : "absent"}`);
      if (secretPresent !== expected || (cleanupFails && !expected)) {
        throw new Error("synthetic");
      }
    },
    createCleanupSignal: () => new AbortController().signal,
    async deleteSecretIfPresent() {
      calls.push("secret-cleanup");
      if (cleanupFails) throw new Error("synthetic");
      secretPresent = false;
    },
    async inspectProductionContext() {
      calls.push("context-proof");
      if (failAt === "preflight") throw new Error("synthetic");
      return CONTEXT;
    },
    async openRootSession() {
      calls.push("root-open");
      root.closed = false;
      return root;
    },
    randomHex(bytes) {
      return bytes === 8 ? "0123456789abcdef" : "b".repeat(96);
    },
    async setSecret(value) {
      calls.push("secret-set");
      expect(value).toMatch(
        /^mysql:\/\/lbcp_0123456789abcdef:Aa1!b{96}@127\.0\.0\.1:13306\/leaderbot$/,
      );
      secretPresent = true;
      if (abortAt === "secret") controller.abort();
      if (failAt === "secret-set") throw new Error("synthetic");
      if (abortAt === "secret") throw new Error("synthetic");
    },
    async startProxy() {
      calls.push("proxy-start");
      if (failAt === "proxy") throw new Error("synthetic");
      return {
        port: 24_321,
        async stop() {
          calls.push("proxy-stop");
          if (proxyStopFails) throw new Error("synthetic");
        },
      };
    },
    async verifyProvisionerConnection() {
      calls.push("provisioner-proof");
      if (failAt === "authentication") throw new Error("synthetic");
    },
  };
  return { calls, controller, deps };
}

function createProxyChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.stderr = new PassThrough();
  child.stdout = new PassThrough();
  child.kill = () => {
    child.killed = true;
    return true;
  };
  return child;
}

describe("credit provisioner bootstrap runner", () => {
  it("pins the flyctl version used for the reviewed live metadata shape", () => {
    expect(PINNED_FLYCTL_VERSION).toBe("0.4.94");
  });

  it("routes an early child stdin close through the bounded failure seam", () => {
    const stdin = new EventEmitter();
    let failures = 0;
    attachChildStdinFailureHandler({ stdin }, () => {
      failures += 1;
    });
    expect(() =>
      stdin.emit("error", new Error("synthetic EPIPE")),
    ).not.toThrow();
    expect(failures).toBe(1);
  });

  it("requires exactly the reviewed head and recovery snapshot CLI inputs", () => {
    expect(
      parseCliArguments([
        "--expected-head",
        EXPECTED_HEAD,
        "--recovery-snapshot-id",
        SNAPSHOT_ID,
      ]),
    ).toEqual({ expectedHead: EXPECTED_HEAD, snapshotId: SNAPSHOT_ID });
    expect(() =>
      parseCliArguments(["--recovery-snapshot-id", SNAPSHOT_ID]),
    ).toThrow();
    expect(() =>
      parseCliArguments([
        "--expected-head",
        EXPECTED_HEAD,
        "--recovery-snapshot-id",
        SNAPSHOT_ID,
        "--repo",
        "fork/repo",
      ]),
    ).toThrow();
  });

  it("passes the logged-in gh token only through the exact CI child environment", () => {
    const token = `github_pat_${"x".repeat(40)}`;
    const args = githubAuthTokenArgs();
    const environment = buildSourceCiEnvironment(token, { PATH: "/bin" });

    expect(args).toEqual(["auth", "token", "--hostname", "github.com"]);
    expect(args.join(" ")).not.toContain(token);
    expect(environment).toEqual({
      GITHUB_REPOSITORY: "Dj-Shortcut/openclaw-facebook",
      GITHUB_TOKEN: token,
      PATH: "/bin",
    });
    expect(() => buildSourceCiEnvironment("token with spaces", {})).toThrow();
    const isolatedEnvironment = buildSourceCiEnvironment(token, {});
    expect(Object.keys(isolatedEnvironment).sort()).toEqual([
      "GITHUB_REPOSITORY",
      "GITHUB_TOKEN",
    ]);
    expect(isolatedEnvironment).not.toHaveProperty("NODE_OPTIONS");
    expect(isolatedEnvironment).not.toHaveProperty("FLY_API_TOKEN");
  });

  it("pins the exact loopback Fly proxy command shape", () => {
    expect(buildFlyProxyArgs(CONTEXT)).toEqual([
      "proxy",
      "0:3306",
      CONTEXT.machine.private_ip,
      "--app",
      "leaderbot-portal-mysql",
      "--bind-addr",
      "127.0.0.1",
      "--quiet",
    ]);
  });

  it("accepts only the exact atomic Fly proxy binding announcement", () => {
    const line = `Proxying localhost:62626 to remote [${CONTEXT.machine.private_ip}]:3306\n`;
    expect(parseFlyProxyPort(line, CONTEXT.machine.private_ip)).toBe(62_626);
    expect(() =>
      parseFlyProxyPort(
        "Proxying localhost:62626 to remote [fdaa:0:1234::9]:3306\n",
        CONTEXT.machine.private_ip,
      ),
    ).toThrow();
    expect(() =>
      parseFlyProxyPort(`${line}${line}`, CONTEXT.machine.private_ip),
    ).toThrow();
    expect(() =>
      parseFlyProxyPort(
        `Proxying localhost:0 to remote [${CONTEXT.machine.private_ip}]:3306\n`,
        CONTEXT.machine.private_ip,
      ),
    ).toThrow();
  });

  it("rejects an early-closing Fly proxy before accepting a port", async () => {
    const child = createProxyChild();
    const startup = waitForFlyProxyStartup({
      child,
      expectedPrivateIp: CONTEXT.machine.private_ip,
      signal: new AbortController().signal,
      startupTimeoutMs: 1_000,
    });
    child.emit("close", 1);
    await expect(startup).rejects.toThrow("proxy failed");
  });

  it("accepts the reported port only while the Fly proxy child stays alive", async () => {
    const child = createProxyChild();
    const startup = waitForFlyProxyStartup({
      child,
      expectedPrivateIp: CONTEXT.machine.private_ip,
      signal: new AbortController().signal,
      startupTimeoutMs: 1_000,
    });
    child.stdout.write(
      `Proxying localhost:62626 to remote [${CONTEXT.machine.private_ip}]:3306\n`,
    );
    await expect(startup).resolves.toBe(62_626);
  });

  it("escapes the managed-account prefix for an exact MySQL LIKE inventory", () => {
    expect(MANAGED_ACCOUNT_INVENTORY_QUERY).toBe(
      "SELECT CONCAT(User,0x09,Host) FROM mysql.user WHERE User LIKE 'lbcp\\\\_%' ESCAPE '\\\\' ORDER BY User,Host",
    );
  });

  it("runs the remote MySQL client through the explicit Fly shell boundary", () => {
    expect(ROOT_MYSQL_REMOTE_COMMAND).toBe(
      "/bin/sh -lc 'exec env MYSQL_PWD=\"$MYSQL_ROOT_PASSWORD\" mysql --protocol=socket --batch --raw --skip-column-names --silent --unbuffered -uroot leaderbot'",
    );
    expect(ROOT_MYSQL_REMOTE_COMMAND).not.toContain("MYSQL_ROOT_PASSWORD=");
    expect(
      buildRootMysqlSshArgs({
        app: CONTEXT.recovery.app,
        machineId: CONTEXT.machine.id,
      }),
    ).toEqual([
      "ssh",
      "console",
      "--app",
      "leaderbot-portal-mysql",
      "--machine",
      "28607e7c932038",
      "--quiet",
      "--command",
      ROOT_MYSQL_REMOTE_COMMAND,
    ]);
  });

  it("passes through only the three fixed result markers", () => {
    expect(normalizeBootstrapMarker(CREDIT_PROVISIONER_SUCCESS_MARKER)).toBe(
      CREDIT_PROVISIONER_SUCCESS_MARKER,
    );
    expect(normalizeBootstrapMarker(CREDIT_PROVISIONER_FAILURE_MARKER)).toBe(
      CREDIT_PROVISIONER_FAILURE_MARKER,
    );
    expect(
      normalizeBootstrapMarker(CREDIT_PROVISIONER_CLEANUP_FAILURE_MARKER),
    ).toBe(CREDIT_PROVISIONER_CLEANUP_FAILURE_MARKER);
    expect(normalizeBootstrapMarker("dynamic failure")).toBe(
      CREDIT_PROVISIONER_FAILURE_MARKER,
    );
  });

  it("passes cleanup-incomplete through the CLI without dynamic output", async () => {
    const output = [];
    await expect(
      runCli(
        [
          "--expected-head",
          EXPECTED_HEAD,
          "--recovery-snapshot-id",
          SNAPSHOT_ID,
        ],
        {
          bootstrap: async () => CREDIT_PROVISIONER_CLEANUP_FAILURE_MARKER,
          output: (marker) => output.push(marker),
        },
      ),
    ).resolves.toBe(CREDIT_PROVISIONER_CLEANUP_FAILURE_MARKER);
    expect(output).toEqual([CREDIT_PROVISIONER_CLEANUP_FAILURE_MARKER]);
  });

  it("creates and verifies the account before setting the secret", async () => {
    const { calls, deps } = createHarness();
    await expect(
      bootstrapCreditProvisioner(
        {
          expectedHead: EXPECTED_HEAD,
          signal: new AbortController().signal,
          snapshotId: SNAPSHOT_ID,
        },
        deps,
      ),
    ).resolves.toBe(CREDIT_PROVISIONER_SUCCESS_MARKER);

    expect(calls.filter((call) => call === "context-proof")).toHaveLength(2);
    expect(calls.indexOf("create")).toBeLessThan(calls.indexOf("grant"));
    expect(calls.filter((call) => call === "provisioner-proof")).toHaveLength(
      3,
    );
    expect(calls.indexOf("secret-set")).toBeGreaterThan(
      calls.lastIndexOf("context-proof"),
    );
    expect(calls.filter((call) => call === "repository-proof")).toHaveLength(2);
    expect(calls).not.toContain("account-cleanup");
    expect(calls).not.toContain("secret-cleanup");
  });

  it.each(["grant", "proxy", "authentication"])(
    "removes the managed account and protected secret after %s failure",
    async (failAt) => {
      const { calls, deps } = createHarness({ failAt });
      await expect(
        bootstrapCreditProvisioner(
          {
            expectedHead: EXPECTED_HEAD,
            signal: new AbortController().signal,
            snapshotId: SNAPSHOT_ID,
          },
          deps,
        ),
      ).resolves.toBe(CREDIT_PROVISIONER_FAILURE_MARKER);
      expect(calls).toContain("account-cleanup");
      expect(calls).toContain("secret-absent");
    },
  );

  it("keeps an interrupted secret publication cleanup-incomplete despite immediate absence proof", async () => {
    const { calls, deps } = createHarness({ failAt: "secret-set" });
    await expect(
      bootstrapCreditProvisioner(
        {
          expectedHead: EXPECTED_HEAD,
          signal: new AbortController().signal,
          snapshotId: SNAPSHOT_ID,
        },
        deps,
      ),
    ).resolves.toBe(CREDIT_PROVISIONER_CLEANUP_FAILURE_MARKER);
    expect(calls).toContain("secret-cleanup");
    expect(calls).toContain("secret-absent");
    expect(calls).toContain("account-cleanup");
  });

  it("does not start cleanup mutations when the read-only preflight fails", async () => {
    const { calls, deps } = createHarness({ failAt: "preflight" });
    await expect(
      bootstrapCreditProvisioner(
        {
          expectedHead: EXPECTED_HEAD,
          signal: new AbortController().signal,
          snapshotId: SNAPSHOT_ID,
        },
        deps,
      ),
    ).resolves.toBe(CREDIT_PROVISIONER_FAILURE_MARKER);
    expect(calls).toEqual(["context-proof"]);
  });

  it("returns only the fixed cleanup marker when absence cannot be proved", async () => {
    const { calls, deps } = createHarness({
      cleanupFails: true,
      failAt: "secret-set",
    });
    await expect(
      bootstrapCreditProvisioner(
        {
          expectedHead: EXPECTED_HEAD,
          signal: new AbortController().signal,
          snapshotId: SNAPSHOT_ID,
        },
        deps,
      ),
    ).resolves.toBe(CREDIT_PROVISIONER_CLEANUP_FAILURE_MARKER);
    expect(calls.indexOf("account-cleanup")).toBeLessThan(
      calls.indexOf("secret-cleanup"),
    );
  });

  it("removes the account and secret when proxy shutdown fails after publication", async () => {
    const { calls, deps } = createHarness({ proxyStopFails: true });
    await expect(
      bootstrapCreditProvisioner(
        {
          expectedHead: EXPECTED_HEAD,
          signal: new AbortController().signal,
          snapshotId: SNAPSHOT_ID,
        },
        deps,
      ),
    ).resolves.toBe(CREDIT_PROVISIONER_FAILURE_MARKER);
    expect(calls).toContain("secret-cleanup");
    expect(calls).toContain("account-cleanup");
    expect(calls).toContain("secret-absent");
  });

  it("rolls back the account and secret if remote main moves during publication", async () => {
    const { calls, deps } = createHarness({
      repositoryChangesAfterSecret: true,
    });
    await expect(
      bootstrapCreditProvisioner(
        {
          expectedHead: EXPECTED_HEAD,
          signal: new AbortController().signal,
          snapshotId: SNAPSHOT_ID,
        },
        deps,
      ),
    ).resolves.toBe(CREDIT_PROVISIONER_FAILURE_MARKER);
    expect(calls).toContain("secret-set");
    expect(calls).toContain("secret-cleanup");
    expect(calls).toContain("account-cleanup");
  });

  it.each([
    ["account", false, CREDIT_PROVISIONER_FAILURE_MARKER],
    ["secret", true, CREDIT_PROVISIONER_CLEANUP_FAILURE_MARKER],
  ])(
    "cleans all possibly mutated state when interrupted at %s",
    async (abortAt, secretWasAttempted, expectedMarker) => {
      const { calls, controller, deps } = createHarness({ abortAt });
      await expect(
        bootstrapCreditProvisioner(
          {
            expectedHead: EXPECTED_HEAD,
            signal: controller.signal,
            snapshotId: SNAPSHOT_ID,
          },
          deps,
        ),
      ).resolves.toBe(expectedMarker);
      expect(calls).toContain("account-cleanup");
      expect(calls).toContain("secret-absent");
      if (secretWasAttempted) expect(calls).toContain("secret-cleanup");
    },
  );

  it("reconciles a delayed-visible secret and then proves stable absence", async () => {
    let currentTime = 0;
    let deleted = false;
    let deleteCalls = 0;
    await expect(
      reconcileSecretAbsence({
        deleteSecret: async () => {
          deleteCalls += 1;
          deleted = true;
        },
        listSecretNames: async () =>
          currentTime >= 2_000 && !deleted
            ? [CREDIT_PROVISIONER_SECRET_NAME]
            : [],
        now: () => currentTime,
        stabilizationWindowMs: 3_000,
        timeoutMs: 10_000,
        wait: async (milliseconds) => {
          currentTime += milliseconds;
        },
      }),
    ).resolves.toBeUndefined();
    expect(deleteCalls).toBe(1);
    expect(currentTime).toBeGreaterThanOrEqual(5_000);
  });

  it("rejects when a secret remains visible throughout reconciliation", async () => {
    let currentTime = 0;
    await expect(
      reconcileSecretAbsence({
        deleteSecret: async () => undefined,
        listSecretNames: async () => [CREDIT_PROVISIONER_SECRET_NAME],
        now: () => currentTime,
        stabilizationWindowMs: 2_000,
        timeoutMs: 3_000,
        wait: async (milliseconds) => {
          currentTime += milliseconds;
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects secret reconciliation on abort or duplicate inventory", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      reconcileSecretAbsence({
        deleteSecret: async () => undefined,
        listSecretNames: async () => [],
        signal: controller.signal,
        stabilizationWindowMs: 1,
        timeoutMs: 1,
      }),
    ).rejects.toThrow();
    await expect(
      reconcileSecretAbsence({
        deleteSecret: async () => undefined,
        listSecretNames: async () => [
          CREDIT_PROVISIONER_SECRET_NAME,
          CREDIT_PROVISIONER_SECRET_NAME,
        ],
        stabilizationWindowMs: 1,
        timeoutMs: 1,
      }),
    ).rejects.toThrow();
  });
});
