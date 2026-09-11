import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPreparedMachines,
  operatorCommand,
  parseOperatorInputs,
  parseOperatorResult,
  runTestPaymentOperator,
  verifyOperatorRun,
} from "./image-gen-test-payment-operator.mjs";

const folders = [];
afterEach(() => {
  for (const folder of folders.splice(0))
    fs.rmSync(folder, { recursive: true, force: true });
});
const image = `registry.fly.io/leaderbot-fb-image-gen@sha256:${"a".repeat(64)}`;
const runtimeImage = `registry.fly.io/leaderbot-fb-image-gen@sha256:${"b".repeat(64)}`;
const principal = "c".repeat(64);
const source = "d".repeat(40);
const artifactSource = "e".repeat(40);
const bundle = 'process.stdout.write("fixture");\n';
const bundleSha = createHash("sha256").update(bundle).digest("hex");
const baseEnv = {
  GITHUB_REPOSITORY: "Dj-Shortcut/openclaw-facebook",
  GITHUB_REF: "refs/heads/main",
  GITHUB_WORKFLOW_REF:
    "Dj-Shortcut/openclaw-facebook/.github/workflows/enable-image-gen-test-payments.yml@refs/heads/main",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_SHA: source,
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
  GITHUB_ACTOR_ID: "456",
  OPERATOR_IMAGE: image,
  OPERATOR_SOURCE_SHA: artifactSource,
  OPERATOR_REQUEST_ID: "3e26bd30-d2de-40ae-aa1b-ade9c5bc9b09",
  OPERATOR_EXPECTED_EPOCH: "1",
  GITHUB_TOKEN: "github-secret",
  FLY_API_TOKEN: "fly-secret",
  DATABASE_URL: "never-forward-this",
  PATH: process.env.PATH,
};
const baseline = {
  identity: "deploy-99-1",
  expectedImage: runtimeImage,
  releaseWatermark: "f".repeat(64),
  releaseVersion: "383",
  blockingErrors: [],
  reconcilableDrift: [],
};
function fixture(overrides = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "operator-test-"));
  folders.push(folder);
  const env = { ...baseEnv, ...overrides.env };
  const input = parseOperatorInputs(env);
  const app = {
    app: "leaderbot-fb-image-gen",
    reviewedImage: image,
    reviewedSourceCommit: artifactSource,
    reviewedArtifactKind: "runtime",
    databaseSchemaPhase: "0018_credit_checkout_reservation",
    databaseSchemaTransition: {
      state: "complete",
      runtimePrincipalSha256: principal,
    },
    reviewedSettledPredecessor: {
      identity: baseline.identity,
      image: runtimeImage,
    },
    desiredScale: { app: { count: 2 }, worker: { count: 2 } },
  };
  const machines = ["app", "app", "worker", "worker"].map((group, index) => ({
    id: `${index + 1}`.padEnd(14, "a"),
    state: "started",
    image_ref: { digest: runtimeImage.split("@")[1] },
    config: {
      image: runtimeImage,
      metadata: { fly_process_group: group },
      env: {
        LEADERBOT_DEPLOYMENT_IDENTITY: baseline.identity,
        MOLLIE_MODE: "test",
        MOLLIE_CREDIT_WORKSPACE_ID: "1",
        MOLLIE_BILLING_WORKER_WORKSPACE_ID: "1",
        MOLLIE_BILLING_SCHEDULER_MODE: "pilot_pin",
        MOLLIE_BILLING_ENABLED: "false",
        MOLLIE_LIVE_BILLING_ENABLED: "false",
        MOLLIE_CREDIT_CHECKOUT_ENABLED: "false",
        MESSENGER_PAID_CREDITS_ENABLED: "false",
        MOLLIE_ACCOUNTING_IMPORT_ENABLED: "false",
        MOLLIE_BILLING_DRAIN_ENABLED: "true",
        BILLING_NOTIFICATION_PLANE_ENABLED: "true",
        MOLLIE_RECONCILIATION_ENABLED: "true",
      },
    },
  }));
  overrides.mutateMachines?.(machines);
  const result = {
    event: "test_payment_operator_completed",
    status: "enabled",
    mode: "test",
    workspaceId: 1,
    requestId: input.requestId,
    executionEpoch: 2,
    committed: true,
    source: "protected_workflow",
    githubActorId: "456",
    githubRunId: "123",
    githubRunAttempt: 1,
    sourceSha: source,
    deploymentIdentity: baseline.identity,
    runtimePrincipalSha256: principal,
  };
  const fetchImpl = vi.fn(async (url) => ({
    ok: true,
    json: async () =>
      url.endsWith("git/ref/heads/main")
        ? { object: { sha: overrides.mainSha ?? source } }
        : {
            id: 123,
            run_attempt: 1,
            head_sha: source,
            head_branch: "main",
            head_repository: { full_name: baseEnv.GITHUB_REPOSITORY },
            event: "workflow_dispatch",
            path: ".github/workflows/enable-image-gen-test-payments.yml",
            status: "in_progress",
            conclusion: null,
            actor: { id: 456 },
            triggering_actor: { id: overrides.actorId ?? 456 },
          },
  }));
  let settledCalls = 0;
  const settled = vi.fn(async () => ({
    ...baseline,
    ...(overrides.baselineAt?.(++settledCalls) ?? {}),
  }));
  const execute = vi.fn((command, args, childEnv) => {
    expect(childEnv.DATABASE_URL).toBeUndefined();
    if (command === "flyctl") {
      expect(childEnv.GH_TOKEN).toBeUndefined();
      expect(childEnv.GITHUB_TOKEN).toBeUndefined();
      expect(childEnv.FLY_API_TOKEN).toBe("fly-secret");
    } else expect(childEnv.FLY_API_TOKEN).toBeUndefined();
    if (command === "git") return source;
    if (command === "gh") {
      if (overrides.attestationFailure) throw Error("secret-output");
      return "";
    }
    if (command === "docker") {
      if (args[0] === "image")
        return JSON.stringify({
          "org.opencontainers.image.revision": artifactSource,
          "io.leaderbot.artifact.kind": "runtime",
          "io.leaderbot.schema.minimum": "0018_credit_checkout_reservation",
          "io.leaderbot.schema.maximum": "0018_credit_checkout_reservation",
        });
      if (args[0] === "create") return "a".repeat(64);
      if (args[0] === "cp") fs.writeFileSync(args[2], bundle);
      return "";
    }
    if (args[0] === "machine") return JSON.stringify(machines);
    if (args[0] === "auth") return "";
    if (args[1] === "sftp") {
      if (overrides.uploadFailure) throw Error("private-upload");
      return "";
    }
    const remote = args.at(-1);
    if (remote.startsWith("node -e"))
      return overrides.readinessFailure ? "" : "operator_machine_ready";
    if (remote.startsWith("sha256sum"))
      return `${overrides.remoteHash ?? bundleSha}  ${remote.split(" ")[1]}`;
    if (remote.startsWith("env ")) {
      if (overrides.activationError) throw overrides.activationError;
      if (overrides.activationFailure)
        throw Object.assign(Error("private-db-secret"), {
          stdout: "private-customer",
          stderr: "secret",
        });
      return JSON.stringify({ ...result, ...overrides.result });
    }
    if (remote.startsWith("/bin/rm") && overrides.cleanupFailure)
      throw Error("cleanup-private");
    return "";
  });
  const deps = {
    execute,
    fetchImpl,
    settled,
    readManifest: () => ({ apps: { "image-gen": app } }),
    sourceCi: vi.fn(async () => {}),
    artifactCi: vi.fn(async () => {}),
  };
  return {
    input,
    app,
    machines,
    result,
    deps,
    execute,
    run: () => runTestPaymentOperator({ env, tempDir: folder }, deps),
  };
}
const mutations = (f) =>
  f.execute.mock.calls.filter(
    ([command, args]) =>
      command === "flyctl" && args.at(-1)?.startsWith("env "),
  );

describe("protected Test payment operator", () => {
  it("verifies actor and exact run through GitHub, not only supplied environment", async () => {
    const f = fixture({ actorId: 999 });
    await expect(verifyOperatorRun(baseEnv, f.deps.fetchImpl)).rejects.toThrow(
      "rejected",
    );
  });
  it.each([
    "GITHUB_REF",
    "GITHUB_WORKFLOW_REF",
    "GITHUB_SHA",
    "OPERATOR_IMAGE",
    "OPERATOR_SOURCE_SHA",
    "OPERATOR_REQUEST_ID",
    "OPERATOR_EXPECTED_EPOCH",
  ])("rejects malformed %s before interpolation", (field) => {
    expect(() =>
      parseOperatorInputs({
        ...baseEnv,
        [field]: "unsafe; touch /tmp/example",
      }),
    ).toThrow("rejected");
  });
  it("binds the operator artifact separately from the running predecessor and workflow source", async () => {
    const f = fixture();
    const result = await f.run();
    expect(result).toMatchObject({
      success: true,
      committed: true,
      outcome: "committed",
      baselineUnchanged: true,
      remoteRemoved: true,
      containerRemoved: true,
      operatorImage: image,
      artifactSourceSha: artifactSource,
      workflowSourceSha: source,
      runtimeImage,
      deploymentIdentity: baseline.identity,
      bundleSha256: bundleSha,
    });
    expect(mutations(f)).toHaveLength(1);
    expect(mutations(f)[0][1].at(-1)).toContain(
      `LEADERBOT_TEST_PAYMENT_OPERATOR_SOURCE_SHA=${source}`,
    );
    expect(f.deps.sourceCi).toHaveBeenCalledWith(source, expect.any(Object));
    expect(f.deps.artifactCi).toHaveBeenCalledWith(
      "image-gen",
      image,
      expect.any(Object),
    );
    expect(f.execute.mock.calls.find(([c]) => c === "gh")[1]).toContain(
      artifactSource,
    );
  });
  it.each([
    ["main moved", { mainSha: "a".repeat(40) }],
    ["attestation denied", { attestationFailure: true }],
    ["upload failed", { uploadFailure: true }],
    ["remote bytes differ", { remoteHash: "0".repeat(64) }],
    ["readiness failed", { readinessFailure: true }],
    [
      "baseline moved",
      {
        baselineAt: (n) =>
          n === 2 ? { releaseWatermark: "0".repeat(64) } : {},
      },
    ],
    [
      "live mode",
      {
        mutateMachines: (m) => {
          m[0].config.env.MOLLIE_MODE = "live";
        },
      },
    ],
    [
      "checkout open",
      {
        mutateMachines: (m) => {
          m[0].config.env.MOLLIE_CREDIT_CHECKOUT_ENABLED = "true";
        },
      },
    ],
    [
      "machine stopped",
      {
        mutateMachines: (m) => {
          m[0].state = "stopped";
        },
      },
    ],
    [
      "wrong image",
      {
        mutateMachines: (m) => {
          m[0].config.image = image;
        },
      },
    ],
  ])("refuses %s without executing a mutation", async (_label, options) => {
    const f = fixture(options);
    const result = await f.run();
    expect(result.success).toBe(false);
    expect(result.outcome).toBe("not_started");
    expect(mutations(f)).toHaveLength(0);
  });
  it("does not retry an ambiguous mutation and redacts command errors", async () => {
    const f = fixture({ activationFailure: true });
    const result = await f.run();
    expect(result).toMatchObject({
      success: false,
      outcome: "unknown",
      remoteRemoved: true,
      containerRemoved: true,
    });
    expect(mutations(f)).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(
      /private|secret|stderr|stdout|cause/,
    );
  });

  it("retains a strictly reported commit when the CLI's persisted readback fails", async () => {
    const f = fixture({
      activationError: Object.assign(Error("private"), {
        stderr: JSON.stringify({
          event: "test_payment_operator_failed",
          failedStage: "readback",
          outcome: "unknown",
          committed: true,
        }),
      }),
    });
    const result = await f.run();
    expect(result).toMatchObject({
      success: false,
      outcome: "unknown",
      committed: true,
    });
    expect(mutations(f)).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it("does not trust a failed receipt carrying unreviewed fields", async () => {
    const f = fixture({
      activationError: Object.assign(Error("private"), {
        stderr: JSON.stringify({
          event: "test_payment_operator_failed",
          failedStage: "readback",
          outcome: "unknown",
          committed: true,
          secret: "private",
        }),
      }),
    });
    expect(await f.run()).toMatchObject({
      success: false,
      outcome: "unknown",
      committed: false,
    });
    expect(mutations(f)).toHaveLength(1);
  });
  it.each([
    { result: { executionEpoch: 77 } },
    { result: { extra: "private-secret" } },
  ])(
    "rejects malformed mutation receipts without repeating the action",
    async (options) => {
      const f = fixture(options);
      const result = await f.run();
      expect(result).toMatchObject({
        success: false,
        outcome: "unknown",
        committed: false,
      });
      expect(mutations(f)).toHaveLength(1);
      expect(JSON.stringify(result)).not.toContain("private-secret");
    },
  );
  it.each([
    { cleanupFailure: true },
    {
      baselineAt: (n) => (n === 3 ? { releaseWatermark: "0".repeat(64) } : {}),
    },
  ])(
    "retains committed evidence when cleanup or readback fails",
    async (options) => {
      const f = fixture(options);
      const result = await f.run();
      expect(result).toMatchObject({
        success: false,
        outcome: "committed",
        committed: true,
      });
      expect(mutations(f)).toHaveLength(1);
    },
  );
  it("always removes a partially uploaded run-scoped bundle", async () => {
    const f = fixture({ uploadFailure: true });
    const result = await f.run();
    expect(result.remoteRemoved).toBe(true);
    expect(
      f.execute.mock.calls.some(
        ([, args]) =>
          args.at(-1) ===
          "/bin/rm -f /tmp/leaderbot-test-payment-operator-123-1.cjs",
      ),
    ).toBe(true);
  });
  it("uses env as a real executable without shell assignment semantics", () => {
    const f = fixture();
    const cmd = operatorCommand(
      "/tmp/leaderbot-test-payment-operator-123-1.cjs",
      f.input,
      baseline,
      principal,
    ).split(" ");
    expect(cmd.shift()).toBe("env");
    const assignments = cmd.slice(0, cmd.indexOf("node"));
    const result = execFileSync(
      "env",
      [
        ...assignments,
        process.execPath,
        "-e",
        "process.stdout.write(process.env.LEADERBOT_TEST_PAYMENT_OPERATOR_REQUEST_ID)",
      ],
      { encoding: "utf8", shell: false },
    );
    expect(result).toBe(f.input.requestId);
  });
  it("requires all four desired runtime Machines and exact result provenance", () => {
    const f = fixture();
    expect(() =>
      assertPreparedMachines(f.machines.slice(1), baseline, f.app),
    ).toThrow();
    expect(() =>
      parseOperatorResult(
        JSON.stringify({ ...f.result, sourceSha: artifactSource }),
        f.input,
        baseline,
        principal,
      ),
    ).toThrow();
  });

  it.each([
    "MOLLIE_CREDIT_TEST_CHANNEL_CONNECTION_ID",
    "MOLLIE_CREDIT_TEST_BINDING_EPOCH",
    "MOLLIE_CREDIT_TEST_PRIVACY_EPOCH",
    "MOLLIE_CREDIT_TEST_USER_KEY_HASH",
  ])("refuses a manually pinned tester through %s", async (key) => {
    const f = fixture({
      mutateMachines: (machines) => {
        machines[0].config.env[key] = "1";
      },
    });
    expect((await f.run()).success).toBe(false);
    expect(mutations(f)).toHaveLength(0);
  });

  it("executes the actual readiness command against the runtime response shape without networking", async () => {
    const f = fixture();
    await f.run();
    const command = f.execute.mock.calls
      .map(([, args]) => args.at(-1))
      .find((value) => value.startsWith("node -e '"));
    const code = command.slice(
      command.indexOf("'") + 1,
      command.lastIndexOf("'"),
    );
    const run = (response) =>
      execFileSync(
        process.execPath,
        [
          "-e",
          "global.fetch=async()=>({ok:true,json:async()=>JSON.parse(process.env.FIXTURE_READY)});" +
            code,
        ],
        {
          encoding: "utf8",
          env: { FIXTURE_READY: JSON.stringify(response) },
          stdio: "pipe",
        },
      );
    expect(
      run({
        phase: "operational",
        ok: true,
        checks: [{ name: "database", ok: true }],
      }),
    ).toBe("operator_machine_ready");
    for (const response of [
      { phase: "offline", ok: true, checks: [{ ok: true }] },
      { phase: "operational", ok: false, checks: [{ ok: true }] },
      { phase: "operational", ok: true, checks: [{ ok: false }] },
      { phase: "operational", ok: true, checks: [] },
    ])
      expect(() => run(response)).toThrow();
  });
});
