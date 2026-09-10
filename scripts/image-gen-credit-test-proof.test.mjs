import { createHash } from "node:crypto";
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
  selectCreditTestRuntimeMachines,
} from "./image-gen-credit-test-proof.mjs";
import { validateCreditTestActivation } from "./validate-production-deployment.mjs";

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
    MOLLIE_CREDIT_TEST_CHANNEL_CONNECTION_ID: "2",
    MOLLIE_CREDIT_TEST_BINDING_EPOCH: "3",
    MOLLIE_CREDIT_TEST_PRIVACY_EPOCH: "4",
    MOLLIE_CREDIT_TEST_USER_KEY_HASH: "c".repeat(64),
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
  const rollback = config.replace(
    'MOLLIE_CREDIT_CHECKOUT_ENABLED = "true"',
    'MOLLIE_CREDIT_CHECKOUT_ENABLED = "false"',
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
  let settledReads = 0;
  const execute = vi.fn((command, args, childEnv) => {
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
  const session = {
    initialize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    execute: vi.fn(async (sql) => {
      expect(sql.startsWith("SELECT ")).toBe(true);
      if (sql.includes("Process_priv"))
        return [overrides.processPrivilege ?? "1"];
      if (sql.includes("CONNECTION_ID()")) return [overrides.visibility ?? "1"];
      return sql.includes("mysql.user")
        ? [overrides.account ?? "1\t1"]
        : [overrides.sessions ?? "0"];
    }),
  };
  return {
    app,
    env,
    rootDir: root,
    execute,
    sessionFactory: () => session,
    fetchImpl: fetchRun(),
    now: () => NOW,
    session,
  };
}

describe("bounded credit Test activation", () => {
  it("accepts an explicit scoped Test contract with final runtime and draining rollback", () => {
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
    ["tester hash", "MOLLIE_CREDIT_TEST_USER_KEY_HASH", ""],
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
    const session = {
      execute: vi
        .fn()
        .mockResolvedValueOnce([account])
        .mockResolvedValueOnce(["1"])
        .mockResolvedValueOnce(["1"])
        .mockResolvedValueOnce([sessions]),
    };
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
    });
    expect(f.session.close).toHaveBeenCalledWith({ releaseLock: false });
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
    { processPrivilege: "0" },
    { visibility: "0" },
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
    ])
      expect(() =>
        assertCreditTestEvidence({ ...proof, ...change }, proof, NOW),
      ).toThrow();
    const incomplete = { ...proof };
    delete incomplete.runtimePrincipalSha256;
    expect(() => assertCreditTestEvidence(incomplete, proof, NOW)).toThrow();
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
