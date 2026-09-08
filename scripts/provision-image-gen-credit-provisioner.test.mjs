import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  MANAGED_ACCOUNT_INVENTORY_QUERY,
  PINNED_FLYCTL_VERSION,
  ROOT_MYSQL_REMOTE_COMMAND,
  ROOT_MYSQL_REMOTE_COMMAND_FLYCTL_CSV,
  RootMysqlSession,
  attachChildStdinFailureHandler,
  bootstrapCreditProvisioner,
  buildFlyProxyArgs,
  buildRootMysqlSshArgs,
  buildSourceCiEnvironment,
  githubAuthTokenArgs,
  normalizeBootstrapMarker,
  observeStableSecretState,
  parseCliArguments,
  parseFlyProxyPort,
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
    size: 4096,
    status: "created",
    volumeSize: 10 * 1024 ** 3,
  }),
  volume: Object.freeze({ id: "vol_49165px70nx9ylzr" }),
});

function createHarness({
  failAt,
  abortAt,
  accountUsable = true,
  grantsValid = true,
  initialAccountPresent = false,
  initialExtraAccountPresent = false,
  initialSecretPresent = false,
  proxyStopFails = false,
  repositoryChangesAfterSecret = false,
  secretAppearsAfterObservation = false,
  secretAppearsBeforePublication = false,
  secretSetRemainsInvisible = false,
} = {}) {
  const calls = [];
  let created = initialAccountPresent;
  let extraCreated = initialExtraAccountPresent;
  let secretPresent = initialSecretPresent;
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
    async assertAccountUsable() {
      calls.push("account-usable");
      if (!created || !accountUsable) throw new Error("synthetic");
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
    async disableAndDrop(account) {
      calls.push("account-cleanup");
      if (account.username === USERNAME) created = false;
      else extraCreated = false;
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
      return [
        ...(created ? [{ hostname: "%", username: USERNAME }] : []),
        ...(extraCreated
          ? [{ hostname: "%", username: "lbcp_fedcba9876543210" }]
          : []),
      ];
    },
    async showGrants() {
      calls.push("grants-show");
      return grantsValid
        ? grants
        : [...grants, `GRANT SUPER ON *.* TO \`${USERNAME}\`@\`%\``];
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
      if (
        secretAppearsBeforePublication &&
        !expected &&
        !secretPresent &&
        calls.includes("repository-proof")
      ) {
        secretPresent = true;
      }
      if (secretPresent !== expected) {
        throw new Error("synthetic");
      }
    },
    createCleanupSignal: () => new AbortController().signal,
    async deleteSecretIfPresent() {
      calls.push("secret-cleanup");
      throw new Error("unexpected secret deletion");
    },
    async inspectProductionContext() {
      calls.push("context-proof");
      if (failAt === "preflight") throw new Error("synthetic");
      return CONTEXT;
    },
    async observeSecretState() {
      calls.push("secret-state");
      const observed = secretPresent ? "present" : "absent";
      if (secretAppearsAfterObservation) secretPresent = true;
      return observed;
    },
    async openRootSession() {
      calls.push("root-open");
      root.closed = false;
      return root;
    },
    randomHex(bytes) {
      return bytes === 8 ? "0123456789abcdef" : "b".repeat(96);
    },
    async readSecretPresence() {
      calls.push("secret-read");
      return secretPresent;
    },
    async setSecret(value) {
      calls.push("secret-set");
      expect(value).toMatch(
        /^mysql:\/\/lbcp_0123456789abcdef:Aa1!b{96}@127\.0\.0\.1:13306\/leaderbot$/,
      );
      if (!secretSetRemainsInvisible) secretPresent = true;
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
  return {
    calls,
    controller,
    deps,
    makeSecretVisible() {
      secretPresent = true;
    },
    root,
  };
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

function createRootSessionChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.stdinWrites = [];
  child.stderr = new PassThrough();
  child.stdout = new PassThrough();
  child.stdin = new EventEmitter();
  child.stdin.write = vi.fn((value, callback) => {
    child.stdinWrites.push(String(value));
    callback?.();
    return true;
  });
  child.stdin.end = vi.fn();
  child.kill = vi.fn(() => {
    child.killed = true;
    queueMicrotask(() => {
      child.exitCode ??= 0;
      child.emit("close", child.exitCode);
    });
    return true;
  });
  return child;
}

function rootSessionWithChild() {
  const child = createRootSessionChild();
  const spawnChild = vi.fn(() => child);
  const session = new RootMysqlSession({
    app: CONTEXT.recovery.app,
    machineId: CONTEXT.machine.id,
    signal: new AbortController().signal,
    spawnChild,
  });
  return { child, session, spawnChild };
}

function writtenMarker(child) {
  const statement = child.stdinWrites.at(-1);
  const marker = /SELECT '(__lbcp_[a-f0-9]{32}__)';/.exec(statement)?.[1];
  expect(marker).toBeTruthy();
  return marker;
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

  it("rejects unmanaged identities before account-state queries", async () => {
    const { child, session } = rootSessionWithChild();
    const unmanaged = { hostname: "%", username: "root" };

    await expect(session.accountExists(unmanaged)).rejects.toThrow(
      "managed account identity is invalid",
    );
    await expect(session.assertAccountUsable(unmanaged)).rejects.toThrow(
      "managed account identity is invalid",
    );
    expect(child.stdinWrites).toEqual([]);
    await session.close({ releaseLock: false });
  });

  it("runs the remote MySQL client through the explicit Fly shell boundary", () => {
    expect(ROOT_MYSQL_REMOTE_COMMAND).toBe(
      "/bin/sh -lc 'exec env MYSQL_PWD=\"$MYSQL_ROOT_PASSWORD\" mysql --protocol=socket --batch --raw --skip-column-names --silent --unbuffered -uroot leaderbot'",
    );
    expect(ROOT_MYSQL_REMOTE_COMMAND).not.toContain("MYSQL_ROOT_PASSWORD=");
    expect(ROOT_MYSQL_REMOTE_COMMAND_FLYCTL_CSV).toBe(
      `"/bin/sh -lc 'exec env MYSQL_PWD=""$MYSQL_ROOT_PASSWORD"" mysql --protocol=socket --batch --raw --skip-column-names --silent --unbuffered -uroot leaderbot'"`,
    );
    expect(
      ROOT_MYSQL_REMOTE_COMMAND_FLYCTL_CSV.slice(1, -1).replaceAll(
        '""',
        '"',
      ),
    ).toBe(ROOT_MYSQL_REMOTE_COMMAND);
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

  it("resolves the root MySQL marker protocol", async () => {
    const { child, session, spawnChild } = rootSessionWithChild();
    const result = session.execute("SELECT 1");
    const marker = writtenMarker(child);
    child.stdout.write(`1\n${marker}\n`);
    await expect(result).resolves.toEqual(["1"]);
    expect(spawnChild).toHaveBeenCalledOnce();
    await session.close({ releaseLock: false });
  });

  it("frames root MySQL rows and markers split across chunks", async () => {
    const { child, session } = rootSessionWithChild();
    const result = session.execute("SELECT 1");
    const marker = writtenMarker(child);
    child.stdout.write(`row-one\r\n${marker.slice(0, 12)}`);
    child.stdout.write(`${marker.slice(12)}\n`);
    await expect(result).resolves.toEqual(["row-one"]);
    await session.close({ releaseLock: false });
  });

  it("terminates root MySQL output that exceeds the fixed limit", async () => {
    const { child, session } = rootSessionWithChild();
    const result = session.execute("SELECT 1");
    child.stdout.write("x".repeat(2 * 1024 * 1024 + 1));
    await expect(result).rejects.toThrow("database command failed");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await session.close({ releaseLock: false });
  });

  it("times out a root MySQL command without a marker", async () => {
    const { child, session } = rootSessionWithChild();
    await expect(
      session.execute("SELECT SLEEP(10)", { timeoutMs: 5 }),
    ).rejects.toThrow("database command failed");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await session.close({ releaseLock: false });
  });

  it("rejects a pending root MySQL command when the child closes early", async () => {
    const { child, session } = rootSessionWithChild();
    const result = session.execute("SELECT 1");
    child.exitCode = 1;
    child.emit("close", 1);
    await expect(result).rejects.toThrow("database command failed");
    await session.close({ releaseLock: false });
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
    expect(calls.indexOf("secret-state")).toBeGreaterThan(
      calls.indexOf("lock-acquire"),
    );
    expect(
      calls.filter((call) => call === "create-user-preflight"),
    ).toHaveLength(1);
    expect(calls.indexOf("create-user-preflight")).toBeGreaterThan(
      calls.indexOf("lock-acquire"),
    );
    expect(calls.indexOf("create-user-preflight")).toBeLessThan(
      calls.indexOf("secret-state"),
    );
    expect(calls.indexOf("secret-state")).toBeLessThan(calls.indexOf("create"));
    expect(calls.lastIndexOf("secret-absent")).toBeLessThan(
      calls.indexOf("secret-set"),
    );
    expect(calls.lastIndexOf("secret-absent")).toBeGreaterThan(
      calls.indexOf("repository-proof"),
    );
  });

  it("fails closed without mutating an account-only crash artifact", async () => {
    const { calls, deps } = createHarness({ initialAccountPresent: true });
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
    expect(calls).not.toContain("account-cleanup");
    expect(calls).not.toContain("secret-cleanup");
    expect(calls).not.toContain("create");
    expect(calls).not.toContain("secret-set");
  });

  it("does not overwrite or delete a secret that appears before publication", async () => {
    const { calls, deps } = createHarness({
      secretAppearsBeforePublication: true,
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
    expect(calls).not.toContain("secret-set");
    expect(calls).not.toContain("secret-cleanup");
    expect(calls).not.toContain("account-cleanup");
  });

  it("reconciles an interrupted exact publication without rotating it", async () => {
    const { calls, deps } = createHarness({
      initialAccountPresent: true,
      initialSecretPresent: true,
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
    ).resolves.toBe(CREDIT_PROVISIONER_SUCCESS_MARKER);

    expect(calls.indexOf("secret-state")).toBeGreaterThan(
      calls.indexOf("lock-acquire"),
    );
    expect(calls.filter((call) => call === "context-proof")).toHaveLength(2);
    expect(calls.filter((call) => call === "account-usable")).toHaveLength(2);
    expect(calls).toContain("secret-read");
    expect(calls).not.toContain("account-cleanup");
    expect(calls).not.toContain("secret-cleanup");
    expect(calls).not.toContain("create");
    expect(calls).not.toContain("secret-set");
  });

  it.each([
    ["missing account", { initialAccountPresent: false }],
    [
      "multiple accounts",
      { initialAccountPresent: true, initialExtraAccountPresent: true },
    ],
    ["locked account", { initialAccountPresent: true, accountUsable: false }],
    ["wrong grants", { initialAccountPresent: true, grantsValid: false }],
  ])(
    "does not mutate inconsistent pre-existing publication state: %s",
    async (_label, options) => {
      const { calls, deps } = createHarness({
        ...options,
        initialSecretPresent: true,
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

      expect(calls).not.toContain("account-cleanup");
      expect(calls).not.toContain("secret-cleanup");
      expect(calls).not.toContain("create");
      expect(calls).not.toContain("secret-set");
    },
  );

  it.each(["grant", "proxy", "authentication"])(
    "removes the temporary account after pre-publication %s failure",
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
    expect(calls).not.toContain("secret-cleanup");
    expect(calls).not.toContain("account-cleanup");
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

  it("preserves an invisible delayed publication until it can be reconciled", async () => {
    const { calls, deps, makeSecretVisible } = createHarness({
      secretSetRemainsInvisible: true,
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
    const retryStart = calls.length;
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
    const ambiguousRetryCalls = calls.slice(retryStart);
    expect(ambiguousRetryCalls).not.toContain("account-cleanup");
    expect(ambiguousRetryCalls).not.toContain("secret-cleanup");
    expect(ambiguousRetryCalls).not.toContain("create");
    expect(ambiguousRetryCalls).not.toContain("secret-set");

    makeSecretVisible();
    const visibleRetryStart = calls.length;
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
    const retryCalls = calls.slice(visibleRetryStart);
    expect(retryCalls).not.toContain("account-cleanup");
    expect(retryCalls).not.toContain("secret-cleanup");
    expect(retryCalls).not.toContain("create");
    expect(retryCalls).not.toContain("secret-set");
  });

  it("keeps an orphan when a secret appears after the observation window", async () => {
    const { calls, deps } = createHarness({
      initialAccountPresent: true,
      secretAppearsAfterObservation: true,
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
    expect(calls).not.toContain("account-cleanup");
    expect(calls).not.toContain("secret-cleanup");
    expect(calls).not.toContain("create");
    expect(calls).not.toContain("secret-set");
  });

  it("preserves the account and secret when proxy shutdown fails after publication", async () => {
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
    ).resolves.toBe(CREDIT_PROVISIONER_CLEANUP_FAILURE_MARKER);
    expect(calls).not.toContain("secret-cleanup");
    expect(calls).not.toContain("account-cleanup");
  });

  it("preserves published state if remote main moves during publication", async () => {
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
    ).resolves.toBe(CREDIT_PROVISIONER_CLEANUP_FAILURE_MARKER);
    expect(calls).toContain("secret-set");
    expect(calls).not.toContain("secret-cleanup");
    expect(calls).not.toContain("account-cleanup");
  });

  it.each([
    ["account", true, CREDIT_PROVISIONER_FAILURE_MARKER],
    ["secret", false, CREDIT_PROVISIONER_CLEANUP_FAILURE_MARKER],
  ])(
    "handles an interruption at %s without unsafe remote cleanup",
    async (abortAt, shouldCleanAccount, expectedMarker) => {
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
      expect(calls.includes("account-cleanup")).toBe(shouldCleanAccount);
      expect(calls).not.toContain("secret-cleanup");
      if (shouldCleanAccount) expect(calls).toContain("secret-absent");
    },
  );

  it("observes stable absence without deleting a delayed published secret", async () => {
    let currentTime = 0;
    await expect(
      observeStableSecretState({
        listSecretNames: async () =>
          currentTime >= 2_000 ? [CREDIT_PROVISIONER_SECRET_NAME] : [],
        now: () => currentTime,
        stabilizationWindowMs: 3_000,
        timeoutMs: 10_000,
        wait: async (milliseconds) => {
          currentTime += milliseconds;
        },
      }),
    ).resolves.toBe("present");
    expect(currentTime).toBe(2_000);
  });

  it("accepts absence only after the full stabilization window", async () => {
    let currentTime = 0;
    await expect(
      observeStableSecretState({
        listSecretNames: async () => [],
        now: () => currentTime,
        stabilizationWindowMs: 3_000,
        timeoutMs: 10_000,
        wait: async (milliseconds) => {
          currentTime += milliseconds;
        },
      }),
    ).resolves.toBe("absent");
    expect(currentTime).toBe(3_000);
  });

  it("rejects secret observation on abort or duplicate inventory", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      observeStableSecretState({
        listSecretNames: async () => [],
        signal: controller.signal,
        stabilizationWindowMs: 1,
        timeoutMs: 1,
      }),
    ).rejects.toThrow();
    await expect(
      observeStableSecretState({
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
