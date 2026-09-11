import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertCreditTestEvidence,
  assertCreditTestRun,
  assertCreditTestUnlockAllowed,
  assertProtectedCreditTestRun,
  collectCreditTestProof,
  inspectLockedObsoletePrincipal,
  obsoletePrincipalProofQueries,
  openCreditTestProvisionerSession,
  selectCreditTestRuntimeMachines,
} from "./image-gen-credit-test-proof.mjs";
import { validateCreditTestActivation } from "./validate-production-deployment.mjs";
import { buildExpectedProvisionerGrants } from "./image-gen-credit-provisioner-bootstrap-contract.mjs";

const repo = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
const SOURCE = "a".repeat(40);
const OLD = "b".repeat(64);
const NOW = Date.parse("2026-09-10T12:00:00Z");
const env = {
  GITHUB_REPOSITORY: "Dj-Shortcut/openclaw-facebook",
  GITHUB_REF: "refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_SHA: SOURCE,
  GITHUB_WORKFLOW_REF:
    "Dj-Shortcut/openclaw-facebook/.github/workflows/deploy-production.yml@refs/heads/main",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "2",
  GITHUB_TOKEN: "test-github",
  CREDIT_TEST_IMAGE_TOKEN: "test-image",
  CREDIT_TEST_DATABASE_TOKEN: "test-database",
  DATABASE_PROVISIONER_URL: `mysql://lbcp_0123456789abcdef:Aa1!${"c".repeat(96)}@127.0.0.1:13306/leaderbot`,
};
const remoteRun = {
  id: 123,
  run_attempt: 2,
  head_sha: SOURCE,
  head_branch: "main",
  head_repository: { full_name: env.GITHUB_REPOSITORY },
  event: "workflow_dispatch",
  path: ".github/workflows/deploy-production.yml",
  status: "in_progress",
  conclusion: null,
};
const fetchRun = (override = {}) =>
  vi.fn(async () => ({
    ok: true,
    json: async () => ({ ...remoteRun, ...override }),
  }));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "credit-test-proof-"));
  dirs.push(root);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repo, "deploy/production/apps.json")),
  );
  const app = manifest.apps["image-gen"];
  const image = app.reviewedImage;
  app.databaseSchemaTransition.state = "complete";
  app.creditTestActivation = {
    state: "bounded_test",
    obsoletePrincipalSha256: OLD,
  };
  app.reviewedRollbackImages = [image];
  app.reviewedRollbackArtifactKinds = { [image]: "runtime" };
  app.reviewedRollbackSourceCommits = { [image]: app.reviewedSourceCommit };
  app.reviewedRollbackImageSchemaPhases = {
    [image]: [app.databaseSchemaPhase],
  };
  let config = fs.readFileSync(path.join(repo, app.config), "utf8");
  const changes = {
    MESSENGER_PAID_CREDITS_ENABLED: "true",
    MOLLIE_CREDIT_CHECKOUT_ENABLED: "true",
    MOLLIE_BILLING_DRAIN_ENABLED: "true",
    BILLING_NOTIFICATION_PLANE_ENABLED: "true",
    MOLLIE_RECONCILIATION_ENABLED: "true",
    MOLLIE_CREDIT_TEST_CHANNEL_CONNECTION_ID: "",
    MOLLIE_CREDIT_TEST_BINDING_EPOCH: "",
    MOLLIE_CREDIT_TEST_PRIVACY_EPOCH: "",
    MOLLIE_CREDIT_TEST_USER_KEY_HASH: "",
  };
  for (const [key, value] of Object.entries(changes))
    config = config.replace(
      new RegExp(`${key} = "[^"]*"`),
      `${key} = "${value}"`,
    );
  const configEnv = Object.fromEntries(
    [...config.matchAll(/^\s+([A-Z][A-Z0-9_]+) = "([^"]*)"/gm)].map((m) => [
      m[1],
      m[2],
    ]),
  );
  const rollbackPath = "deploy/production/rollback-configs/test-runtime.toml";
  const rollback = config
    .replace(
      'MOLLIE_CREDIT_CHECKOUT_ENABLED = "true"',
      'MOLLIE_CREDIT_CHECKOUT_ENABLED = "false"',
    )
    .replace(
      'MESSENGER_PAID_CREDITS_ENABLED = "true"',
      'MESSENGER_PAID_CREDITS_ENABLED = "false"',
    );
  app.reviewedRollbackConfigs = {
    [image]: {
      path: rollbackPath,
      sha256: createHash("sha256").update(rollback).digest("hex"),
    },
  };
  app.reviewedSettledPredecessor = {
    image,
    identity: "deploy-100-1",
    ...app.reviewedRollbackConfigs[image],
  };
  app.creditTestActivation.operator = {
    requestId: "12345678-1234-4234-8234-123456789012",
    previousEpoch: 1,
    epoch: 2,
    operatorImage: app.reviewedImage,
    artifactSourceSha: app.reviewedSourceCommit,
    runtimeImage: image,
    deploymentIdentity: app.reviewedSettledPredecessor.identity,
  };
  for (const [relative, content] of [
    [app.config, config],
    [rollbackPath, rollback],
    ["deploy/production/apps.json", JSON.stringify(manifest)],
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
  return { root, app, configEnv };
}

function runtimeMachines(app) {
  return Object.entries(app.desiredScale).flatMap(([group, scale], index) =>
    Array.from({ length: scale.count }, (_, i) => ({
      id: `${index + 1}${i + 1}`.padEnd(14, "a"),
      state: "started",
      image_ref: { digest: app.reviewedImage.split("@")[1] },
      config: {
        env: {
          LEADERBOT_DEPLOYMENT_IDENTITY: "deploy-100-1",
          MESSENGER_PAID_CREDITS_ENABLED: "false",
          MOLLIE_CREDIT_CHECKOUT_ENABLED: "false",
        },
        metadata: { fly_process_group: group },
      },
    })),
  );
}

function collectorFixture(overrides = {}) {
  const { root, app } = fixture();
  const recovery = app.databaseRecovery;
  const machine = {
    id: "a".repeat(14),
    state: "started",
    private_ip: "fdaa:1::1",
    region: recovery.region,
    host_status: "ok",
    cordoned: false,
    image_ref: { digest: recovery.mysqlImage.split("@")[1] },
    config: {
      image: recovery.mysqlImage,
      mounts: [
        {
          volume: recovery.volumeId,
          path: "/var/lib/mysql",
          encrypted: true,
          size_gb: recovery.sizeGb,
        },
      ],
    },
  };
  const volume = {
    id: recovery.volumeId,
    encrypted: true,
    region: recovery.region,
    size_gb: recovery.sizeGb,
    attached_machine_id: machine.id,
    auto_backup_enabled: true,
  };
  const baseline = {
    identity: "deploy-100-1",
    expectedImage: app.reviewedImage,
    releaseVersion: "10",
    releaseWatermark: "d".repeat(64),
  };
  const operator = {
    source: "protected_workflow",
    githubActorId: "11",
    githubRunId: "120",
    githubRunAttempt: 1,
    sourceSha: SOURCE,
    deploymentIdentity: baseline.identity,
    runtimePrincipalSha256: app.databaseSchemaTransition.runtimePrincipalSha256,
    operatorImage: app.reviewedImage,
    artifactSourceSha: app.reviewedSourceCommit,
    bundleSha256: "e".repeat(64),
    runtimeImage: baseline.expectedImage,
  };
  const requestId = "12345678-1234-4234-8234-123456789012";
  const reason = "protected workflow test payment preparation";
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        "billing-scheduler-enable-v1",
        1,
        "test",
        7,
        1,
        reason,
        operator,
      ]),
    )
    .digest("hex");
  const activation = {
    controls: [{ workspaceId: 1, mode: "test", enabled: 1, epoch: 2 }],
    lanes: [
      "ai_finalization",
      "outbox",
      "profile_expiry",
      "reconciliation",
    ].map((kind) => ({
      workspaceId: 1,
      mode: "test",
      kind,
      enabled: 1,
      epoch: 2,
      requestId,
      fingerprint,
      ownerUserId: 7,
    })),
    audits: [
      {
        id: 9,
        workspaceId: 1,
        ownerUserId: 7,
        event: "billing_scheduler_enabled",
        metadataFieldCount: 7,
        operatorFieldCount: 11,
        mode: "test",
        requestId,
        previousEpoch: 1,
        epoch: 2,
        reason,
        onBehalfOfOwnerUserId: 7,
        operator,
      },
    ],
  };
  let settledReads = 0;
  const execute = vi.fn((command, args, childEnv) => {
    expect(childEnv.DATABASE_PROVISIONER_URL).toBeUndefined();
    expect(childEnv.IMAGE_GEN_DATABASE_PROVISIONER_URL).toBeUndefined();
    if (command === "git") return SOURCE;
    if (command === "node") {
      if (args.includes("--settled-live"))
        return JSON.stringify({
          ...baseline,
          ...(settledReads++ ? overrides.afterBaseline : {}),
        });
      return "";
    }
    expect(childEnv.CREDIT_TEST_DATABASE_TOKEN).toBeUndefined();
    expect(childEnv.CREDIT_TEST_IMAGE_TOKEN).toBeUndefined();
    if (args[0] === "ssh")
      return (
        overrides.probeOutput ?? "Billing trigger runtime preflight passed."
      );
    if (args.includes(app.app))
      return JSON.stringify(overrides.runtimeMachines ?? runtimeMachines(app));
    expect(childEnv.FLY_API_TOKEN).toBe("test-database");
    expect(childEnv.GITHUB_TOKEN).toBeUndefined();
    return JSON.stringify(args[0] === "volumes" ? [volume] : [machine]);
  });
  let accountReads = 0;
  let activationReads = 0;
  const session = {
    expectedSessionId: "7",
    initialize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    execute: vi.fn(async (sql) => {
      expect(sql).toMatch(/^(SELECT|SHOW GLOBAL) /);
      if (sql.startsWith("SELECT CAST(JSON_OBJECT("))
        return [
          JSON.stringify(
            (activationReads++ ? overrides.afterActivation : undefined) ??
              overrides.activation ??
              activation,
          ),
        ];
      if (sql.includes("mysql.user"))
        return [
          (accountReads++ ? overrides.afterAccount : undefined) ??
            overrides.account ??
            "1\t1",
        ];
      if (sql.startsWith("SELECT @@"))
        return ["1\tone-thread-per-connection\t7"];
      if (sql.includes("LIKE 'Connections'")) return ["Connections\t10"];
      if (sql.includes("LIKE 'Threads_connected'"))
        return ["Threads_connected\t2"];
      return [
        `${overrides.total ?? "2"}\t2\t${overrides.visibility ?? "1"}\t${overrides.sessions ?? "0"}\t0\t0`,
      ];
    }),
  };
  return {
    app,
    env,
    rootDir: root,
    execute,
    sessionFactory: () => session,
    fetchImpl: vi.fn(async (url) => ({
      ok: true,
      json: async () =>
        url.includes("/runs/120/attempts/1")
          ? {
              ...remoteRun,
              id: 120,
              run_attempt: 1,
              path: ".github/workflows/enable-image-gen-test-payments.yml",
              status: "completed",
              conclusion: "success",
              actor: { id: 11 },
              triggering_actor: { id: 11 },
              ...overrides.operatorRun,
            }
          : remoteRun,
    })),
    now: () => NOW,
    session,
    activation,
  };
}

function provisionerTransportFixture(overrides = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = vi.fn(() => {
    child.killed = true;
    child.signalCode = "SIGTERM";
    queueMicrotask(() => child.emit("close", null, "SIGTERM"));
  });
  const username = "lbcp_0123456789abcdef";
  const grants = [
    ...buildExpectedProvisionerGrants({ databaseName: "leaderbot", username }),
    `GRANT SELECT (NAME, TYPE, PROCESSLIST_ID, PROCESSLIST_USER) ON \`performance_schema\`.\`threads\` TO '${username}'@'%'`,
  ];
  let identityReads = 0;
  const connection = {
    destroy: vi.fn(),
    query: vi.fn(async ({ sql, timeout, rowsAsArray }) => {
      expect(timeout).toBe(10_000);
      expect(rowsAsArray).toBe(true);
      if (sql.startsWith("SELECT CURRENT_USER"))
        return [
          [
            [
              overrides.currentUser ?? `${username}@%`,
              overrides.databaseName ?? "leaderbot",
              (identityReads++ ? overrides.afterSessionId : undefined) ?? "7",
            ],
          ],
        ];
      if (sql.startsWith("SHOW GRANTS"))
        return [(overrides.grants ?? grants).map((value) => [value])];
      return [[[1]]];
    }),
  };
  const spawnChild = vi.fn(() => {
    queueMicrotask(() =>
      child.stdout.write(
        `Proxying localhost:15432 to remote [${overrides.proxyIp ?? "fdaa:1::1"}]:3306\n`,
      ),
    );
    return child;
  });
  const mysql = {
    createConnection: vi.fn(async () => {
      if (overrides.connectionFailure)
        throw new Error("sensitive connection error");
      return connection;
    }),
  };
  const controller = new AbortController();
  return {
    child,
    connection,
    mysql,
    spawnChild,
    controller,
    options: {
      recovery: { app: "leaderbot-portal-mysql", databaseName: "leaderbot" },
      machine: { private_ip: "fdaa:1::1" },
      url: overrides.url ?? env.DATABASE_PROVISIONER_URL,
      env: {
        FLY_API_TOKEN: "test-database",
        DATABASE_PROVISIONER_URL: env.DATABASE_PROVISIONER_URL,
      },
      signal: controller.signal,
      spawnChild,
      mysql,
    },
  };
}

describe("pinned provisioner proof transport", () => {
  it("uses exact Fly IP, ephemeral local port and one restricted MySQL session, never database SSH", async () => {
    const f = provisionerTransportFixture();
    const session = await openCreditTestProvisionerSession(f.options);
    try {
      await session.initialize();
      await session.initialize();
      expect(session.expectedSessionId).toBe("7");
      expect(await session.execute("SELECT 1")).toEqual(["1"]);
      expect(f.mysql.createConnection).toHaveBeenCalledTimes(1);
      expect(new URL(f.mysql.createConnection.mock.calls[0][0]).port).toBe(
        "15432",
      );
      expect(f.spawnChild.mock.calls[0][1]).toEqual([
        "proxy",
        "0:3306",
        "fdaa:1::1",
        "--app",
        "leaderbot-portal-mysql",
        "--bind-addr",
        "127.0.0.1",
        "--quiet",
      ]);
      expect(
        f.spawnChild.mock.calls[0][2].env.DATABASE_PROVISIONER_URL,
      ).toBeUndefined();
      expect(JSON.stringify(f.spawnChild.mock.calls)).not.toContain("Aa1!");
      expect(
        f.connection.query.mock.calls.map(([query]) => query.sql).join("\n"),
      ).not.toMatch(/ALTER|GRANT SELECT|INSERT|UPDATE|DELETE|PROCESSLIST_INFO/);
    } finally {
      await session.close();
    }
    expect(f.connection.destroy).toHaveBeenCalled();
    expect(f.child.kill).toHaveBeenCalled();
  });
  it.each([
    { currentUser: "different@%" },
    { databaseName: "different" },
    { afterSessionId: "8" },
    { grants: [] },
  ])("rejects identity or privilege drift %j", async (overrides) => {
    const f = provisionerTransportFixture(overrides);
    const session = await openCreditTestProvisionerSession(f.options);
    try {
      await expect(
        (async () => {
          await session.initialize();
          await session.initialize();
        })(),
      ).rejects.toThrow();
    } finally {
      await session.close();
    }
  });
  it("requires the additional exact metadata grant, not the base maintenance profile", async () => {
    const f = provisionerTransportFixture({
      grants: buildExpectedProvisionerGrants({
        databaseName: "leaderbot",
        username: "lbcp_0123456789abcdef",
      }),
    });
    const session = await openCreditTestProvisionerSession(f.options);
    try {
      await expect(session.initialize()).rejects.toThrow();
    } finally {
      await session.close();
    }
  });
  it.each([{ proxyIp: "fdaa:2::2" }, { connectionFailure: true }])(
    "closes a failed tunnel/connection without exposing errors %j",
    async (overrides) => {
      const f = provisionerTransportFixture(overrides);
      await expect(openCreditTestProvisionerSession(f.options)).rejects.toThrow(
        "credit_test_proof_rejected",
      );
      expect(f.child.kill).toHaveBeenCalled();
    },
  );
  it("rejects a non-local stored URL before spawning a tunnel", async () => {
    const f = provisionerTransportFixture({
      url: env.DATABASE_PROVISIONER_URL.replace("127.0.0.1", "db.internal"),
    });
    await expect(openCreditTestProvisionerSession(f.options)).rejects.toThrow(
      "credit_test_proof_rejected",
    );
    expect(f.spawnChild).not.toHaveBeenCalled();
  });
  it("fails closed and cleans up when the deadline aborts", async () => {
    const f = provisionerTransportFixture();
    const session = await openCreditTestProvisionerSession(f.options);
    f.controller.abort();
    await expect(session.execute("SELECT 1")).rejects.toThrow();
    await session.close();
    expect(f.connection.destroy).toHaveBeenCalled();
    expect(f.child.kill).toHaveBeenCalled();
  });
});

describe("bounded credit Test activation", () => {
  it("accepts Test Mode without tester registration with final runtime and draining rollback", () => {
    const f = fixture();
    expect(validateCreditTestActivation(f.app, f.configEnv, f.root)).toBe(true);
  });
  it.each([
    ["live mode", "MOLLIE_MODE", "live"],
    ["live switch", "MOLLIE_LIVE_BILLING_ENABLED", "true"],
    ["legacy creation", "MOLLIE_BILLING_ENABLED", "true"],
    ["drain", "MOLLIE_BILLING_DRAIN_ENABLED", "false"],
    ["notifications", "BILLING_NOTIFICATION_PLANE_ENABLED", "false"],
    ["reconciliation", "MOLLIE_RECONCILIATION_ENABLED", "false"],
    ["manual tester hash", "MOLLIE_CREDIT_TEST_USER_KEY_HASH", "c".repeat(64)],
    ["manual tester channel", "MOLLIE_CREDIT_TEST_CHANNEL_CONNECTION_ID", "2"],
    ["manual tester privacy epoch", "MOLLIE_CREDIT_TEST_PRIVACY_EPOCH", "4"],
    ["binding", "MOLLIE_CREDIT_TEST_BINDING_EPOCH", "0"],
    ["cost policy", "MESSENGER_PAID_IMAGE_PROVIDER_MAX_COST_USD", "0.01"],
    ["daily cap", "MESSENGER_GLOBAL_DAILY_SPEND_CAP_USD", "100.00"],
  ])("rejects invalid %s", (_, key, value) => {
    const f = fixture();
    expect(() =>
      validateCreditTestActivation(
        f.app,
        { ...f.configEnv, [key]: value },
        f.root,
      ),
    ).toThrow();
  });
  it("rejects exposure with no request and self-attested proof booleans", () => {
    const f = fixture();
    const request = f.app.creditTestActivation;
    delete f.app.creditTestActivation;
    expect(() =>
      validateCreditTestActivation(f.app, f.configEnv, f.root),
    ).toThrow();
    f.app.creditTestActivation = { ...request, verified: true };
    expect(() =>
      validateCreditTestActivation(f.app, f.configEnv, f.root),
    ).toThrow();
  });
  it("rejects a retained bridge and incomplete cutover", () => {
    const f = fixture();
    f.app.databaseSchemaTransition.state = "runtime_reviewed";
    expect(() =>
      validateCreditTestActivation(f.app, f.configEnv, f.root),
    ).toThrow();
    f.app.databaseSchemaTransition.state = "complete";
    f.app.reviewedRollbackImages.push(
      f.app.databaseSchemaTransition.bridgeImage,
    );
    expect(() =>
      validateCreditTestActivation(f.app, f.configEnv, f.root),
    ).toThrow();
  });
  it("rejects a hash-valid rollback with the durable drain disabled", () => {
    const f = fixture();
    const entry = f.app.reviewedRollbackConfigs[f.app.reviewedImage];
    const file = path.join(f.root, entry.path);
    const changed = fs
      .readFileSync(file, "utf8")
      .replace(
        'MOLLIE_BILLING_DRAIN_ENABLED = "true"',
        'MOLLIE_BILLING_DRAIN_ENABLED = "false"',
      );
    fs.writeFileSync(file, changed);
    entry.sha256 = createHash("sha256").update(changed).digest("hex");
    fs.writeFileSync(
      path.join(f.root, "deploy/production/apps.json"),
      JSON.stringify({ schemaVersion: 1, apps: { "image-gen": f.app } }),
    );
    expect(() =>
      validateCreditTestActivation(f.app, f.configEnv, f.root),
    ).toThrow("Test rollback requires MOLLIE_BILLING_DRAIN_ENABLED=true");
  });

  it.each([
    ["missing tester pin", 'MOLLIE_CREDIT_TEST_USER_KEY_HASH = ""'],
    [
      "different tester pin",
      `MOLLIE_CREDIT_TEST_USER_KEY_HASH = "${"f".repeat(64)}"`,
    ],
    [
      "different cost cap",
      'MESSENGER_PAID_IMAGE_PROVIDER_MAX_COST_USD = "100.00"',
    ],
  ])(
    "rejects paid admission in a hash-reviewed rollback with %s",
    (_, replacement) => {
      const f = fixture();
      const entry = f.app.reviewedRollbackConfigs[f.app.reviewedImage];
      const file = path.join(f.root, entry.path);
      const key = replacement.split(" = ")[0];
      const changed = fs
        .readFileSync(file, "utf8")
        .replace(
          'MESSENGER_PAID_CREDITS_ENABLED = "false"',
          'MESSENGER_PAID_CREDITS_ENABLED = "true"',
        )
        .replace(new RegExp(`${key} = "[^"]*"`), replacement);
      fs.writeFileSync(file, changed);
      entry.sha256 = createHash("sha256").update(changed).digest("hex");
      fs.writeFileSync(
        path.join(f.root, "deploy/production/apps.json"),
        JSON.stringify({ schemaVersion: 1, apps: { "image-gen": f.app } }),
      );
      expect(() =>
        validateCreditTestActivation(f.app, f.configEnv, f.root),
      ).toThrow("Test rollback requires MESSENGER_PAID_CREDITS_ENABLED=false");
    },
  );
});

describe("protected metadata proof", () => {
  it("binds the exact in-progress protected workflow attempt", async () => {
    expect(assertCreditTestRun(env).runAttempt).toBe("2");
    await expect(
      assertProtectedCreditTestRun(env, fetchRun()),
    ).resolves.toMatchObject({ sourceHead: SOURCE });
  });
  it.each([
    { head_sha: "c".repeat(40) },
    { run_attempt: 1 },
    { status: "completed" },
    { path: "other.yml" },
    { head_branch: "branch" },
    { head_repository: { full_name: "attacker/repo" } },
  ])("rejects stale or foreign source %j", async (change) => {
    await expect(
      assertProtectedCreditTestRun(env, fetchRun(change)),
    ).rejects.toThrow();
  });
  it.each([
    "GITHUB_REF",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_REPOSITORY",
    "GITHUB_RUN_ATTEMPT",
  ])("rejects invalid %s before API access", (key) => {
    expect(() => assertCreditTestRun({ ...env, [key]: "invalid" })).toThrow();
  });
  it("only accepts a canonical hash in fixed read-only SQL", () => {
    expect(
      obsoletePrincipalProofQueries(OLD).every((q) => q.startsWith("SELECT ")),
    ).toBe(true);
    expect(() => obsoletePrincipalProofQueries("'; DROP USER")).toThrow();
  });
  it.each([
    ["0\t0", "1"],
    ["1\t0", "0"],
    ["2\t1", "0"],
    ["1\t1", "1"],
    ["1\t1", ""],
  ])("rejects account/session inventory %s / %s", async (account, sessions) => {
    const { session } = collectorFixture({ account, sessions });
    await expect(
      inspectLockedObsoletePrincipal(session, OLD),
    ).rejects.toThrow();
  });
  it("collects independently checked exact runtime/DB evidence without customer content", async () => {
    const f = collectorFixture();
    const proof = await collectCreditTestProof(f);
    expect(proof).toMatchObject({
      obsoleteAccountState: "locked",
      obsoleteSessionCount: 0,
      candidateIdentity: "deploy-123-2",
      databaseName: "leaderbot",
      activation: {
        verified: true,
        committed: true,
        readOnly: true,
        workspaceId: 1,
        executionEpoch: 2,
        operator: { githubRunId: "120" },
      },
    });
    expect(f.session.close).toHaveBeenCalledWith();
    expect(f.session.initialize).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(proof)).not.toContain("test-database");
    expect(() =>
      assertCreditTestEvidence(
        proof,
        { ...proof, checkedAt: new Date(NOW + 1000).toISOString() },
        NOW + 1000,
      ),
    ).not.toThrow();
  });
  it.each([
    { afterBaseline: { identity: "deploy-101-1" } },
    { afterBaseline: { releaseWatermark: "f".repeat(64) } },
    { probeOutput: "failed" },
    { sessions: "1" },
    { account: "1\t0" },
    { total: "1" },
    { visibility: "0" },
    { afterAccount: "1\t0" },
    { afterAccount: "0\t0" },
    { activation: { controls: [], lanes: [], audits: [] } },
    { afterActivation: { controls: [], lanes: [], audits: [] } },
    { operatorRun: { actor: { id: 99 } } },
  ])(
    "rejects drift, incomplete visibility or failed probe %j",
    async (change) => {
      await expect(
        collectCreditTestProof(collectorFixture(change)),
      ).rejects.toThrow();
    },
  );
  it("rejects stale, future, superseded, tampered and incomplete evidence", async () => {
    const proof = await collectCreditTestProof(collectorFixture());
    for (const change of [
      { checkedAt: new Date(NOW - 900_001).toISOString() },
      { checkedAt: new Date(NOW + 1).toISOString() },
      { sourceHead: "f".repeat(40) },
      { runAttempt: "1" },
      { databaseMachineId: "f".repeat(14) },
      { obsoleteAccountState: "unlocked" },
      { obsoleteSessionCount: 1 },
      { runtimeMachineIds: [] },
      { activation: { ...proof.activation, executionEpoch: 3 } },
      {
        activation: {
          ...proof.activation,
          operator: { ...proof.activation.operator, githubRunId: "121" },
        },
      },
    ])
      expect(() =>
        assertCreditTestEvidence({ ...proof, ...change }, proof, NOW),
      ).toThrow();
    const incomplete = { ...proof };
    delete incomplete.runtimePrincipalSha256;
    expect(() => assertCreditTestEvidence(incomplete, proof, NOW)).toThrow();
    const missingActivation = { ...proof };
    delete missingActivation.activation;
    expect(() =>
      assertCreditTestEvidence(missingActivation, proof, NOW),
    ).toThrow();
  });
  it("rechecks persisted activation on every consume, refusing later disable", async () => {
    const f = collectorFixture();
    const recorded = await collectCreditTestProof(f);
    const current = await collectCreditTestProof(f);
    expect(() =>
      assertCreditTestEvidence(recorded, current, NOW),
    ).not.toThrow();
    f.activation.controls[0].enabled = 0;
    await expect(collectCreditTestProof(f)).rejects.toThrow(
      "credit_test_activation_audit_rejected",
    );
    expect(f.session.close).toHaveBeenCalledTimes(3);
  });
  it("recovers original persisted execution after a failed operator response without retrying it", async () => {
    const f = collectorFixture({ operatorRun: { conclusion: "failure" } });
    const proof = await collectCreditTestProof(f);
    expect(proof.activation.operator.githubRunId).toBe("120");
    expect(proof.runId).toBe("123");
    expect(proof.activation.readOnly).toBe(true);
    expect(
      f.session.execute.mock.calls.every(([sql]) =>
        /^(SELECT|SHOW GLOBAL) /.test(sql),
      ),
    ).toBe(true);
    expect(
      f.execute.mock.calls.some(([, args]) =>
        args.some((value) => String(value).includes("enable-test-payments")),
      ),
    ).toBe(false);
  });
  it("proves absent plus zero sessions distinctly after the separately approved drop", async () => {
    const proof = await collectCreditTestProof(
      collectorFixture({ account: "0\t0" }),
    );
    expect(proof.obsoleteAccountState).toBe("absent");
    expect(proof.obsoleteSessionCount).toBe(0);
    expect(() =>
      assertCreditTestEvidence(
        { ...proof, obsoleteAccountState: "locked" },
        proof,
        NOW,
      ),
    ).toThrow();
  });
  it("rejects missing, duplicate, mixed-identity and stopped runtime Machines", () => {
    const { app } = fixture();
    const machines = runtimeMachines(app);
    for (const altered of [
      machines.slice(1),
      [...machines, machines[0]],
      machines.map((m, i) => (i ? m : { ...m, state: "stopped" })),
      machines.map((m, i) =>
        i ? m : { ...m, image_ref: { digest: "sha256:" + "f".repeat(64) } },
      ),
    ]) {
      expect(() =>
        selectCreditTestRuntimeMachines(
          altered,
          app,
          "deploy-100-1",
          app.reviewedImage,
        ),
      ).toThrow();
    }
  });
  it("allows unlock only after reviewed request removal and all live exposure flags are off", () => {
    const { app } = fixture();
    const machines = runtimeMachines(app);
    expect(() => assertCreditTestUnlockAllowed({ app, machines })).toThrow();
    delete app.creditTestActivation;
    expect(() =>
      assertCreditTestUnlockAllowed({ app, machines }),
    ).not.toThrow();
    machines[0].config.env.MOLLIE_CREDIT_CHECKOUT_ENABLED = "true";
    expect(() => assertCreditTestUnlockAllowed({ app, machines })).toThrow();
    machines[0].state = "stopped";
    expect(() => assertCreditTestUnlockAllowed({ app, machines })).toThrow();
  });
});
