import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  checkSettledLiveFlyDrift,
  loadProductionManifest,
  verifyReviewedArtifactCi,
  verifySourceCi,
} from "./validate-production-deployment.mjs";

const REPOSITORY = "Dj-Shortcut/openclaw-facebook";
const WORKFLOW = ".github/workflows/enable-image-gen-test-payments.yml";
const APP = "leaderbot-fb-image-gen";
const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const positive = (value) =>
  typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value);
const reject = () => {
  throw new Error("test_payment_operator_rejected");
};
const digest = (value) => createHash("sha256").update(value).digest("hex");

function execute(command, args, env) {
  return execFileSync(command, args, {
    env,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function parseOperatorInputs(env) {
  if (
    env.GITHUB_REPOSITORY !== REPOSITORY ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/${WORKFLOW}@refs/heads/main` ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") ||
    !positive(env.GITHUB_RUN_ID) ||
    !positive(env.GITHUB_RUN_ATTEMPT) ||
    Number(env.GITHUB_RUN_ATTEMPT) > 2147483647 ||
    !positive(env.GITHUB_ACTOR_ID) ||
    !/^registry\.fly\.io\/leaderbot-fb-image-gen@sha256:[a-f0-9]{64}$/.test(
      env.OPERATOR_IMAGE ?? "",
    ) ||
    !/^[a-f0-9]{40}$/.test(env.OPERATOR_SOURCE_SHA ?? "") ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      env.OPERATOR_REQUEST_ID ?? "",
    ) ||
    !positive(env.OPERATOR_EXPECTED_EPOCH) ||
    Number(env.OPERATOR_EXPECTED_EPOCH) >= 2147483647 ||
    !env.GITHUB_TOKEN ||
    !env.FLY_API_TOKEN
  )
    reject();
  return {
    workflowSourceSha: env.GITHUB_SHA,
    artifactSourceSha: env.OPERATOR_SOURCE_SHA,
    image: env.OPERATOR_IMAGE,
    requestId: env.OPERATOR_REQUEST_ID,
    expectedEpoch: Number(env.OPERATOR_EXPECTED_EPOCH),
    actorId: env.GITHUB_ACTOR_ID,
    runId: env.GITHUB_RUN_ID,
    runAttempt: Number(env.GITHUB_RUN_ATTEMPT),
  };
}

export async function verifyOperatorRun(env, fetchImpl = fetch) {
  const input = parseOperatorInputs(env);
  const get = async (suffix) => {
    const response = await fetchImpl(
      `https://api.github.com/repos/${REPOSITORY}/${suffix}`,
      {
        headers: {
          Authorization: `Bearer ${env.GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
        },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (!response.ok) reject();
    return response.json();
  };
  const run = await get(
    `actions/runs/${input.runId}/attempts/${input.runAttempt}`,
  );
  if (
    String(run.id) !== input.runId ||
    run.run_attempt !== input.runAttempt ||
    run.head_sha !== input.workflowSourceSha ||
    run.head_branch !== "main" ||
    run.head_repository?.full_name !== REPOSITORY ||
    run.event !== "workflow_dispatch" ||
    run.path !== WORKFLOW ||
    run.status !== "in_progress" ||
    run.conclusion !== null ||
    String(run.actor?.id) !== input.actorId ||
    String(run.triggering_actor?.id) !== input.actorId
  )
    reject();
  const main = await get("git/ref/heads/main");
  if (main.object?.sha !== input.workflowSourceSha) reject();
  return input;
}

export function assertPreparedMachines(machines, baseline, app) {
  const expected = {
    MOLLIE_MODE: "test",
    MOLLIE_CREDIT_WORKSPACE_ID: "1",
    MOLLIE_BILLING_SCHEDULER_MODE: "pilot_pin",
    MOLLIE_BILLING_WORKER_WORKSPACE_ID: "1",
    MOLLIE_CREDIT_CHECKOUT_ENABLED: "false",
    MESSENGER_PAID_CREDITS_ENABLED: "false",
    MOLLIE_BILLING_ENABLED: "false",
    MOLLIE_LIVE_BILLING_ENABLED: "false",
    MOLLIE_ACCOUNTING_IMPORT_ENABLED: "false",
    MOLLIE_BILLING_DRAIN_ENABLED: "true",
    BILLING_NOTIFICATION_PLANE_ENABLED: "true",
    MOLLIE_RECONCILIATION_ENABLED: "true",
  };
  if (
    !Array.isArray(machines) ||
    machines.length !== 4 ||
    new Set(machines.map((m) => m.id)).size !== 4
  )
    reject();
  for (const machine of machines) {
    const config = machine.config;
    if (
      !/^[a-f0-9]{14}$/.test(machine.id) ||
      machine.state !== "started" ||
      !["app", "worker"].includes(config?.metadata?.fly_process_group) ||
      config.image !== baseline.expectedImage ||
      machine.image_ref?.digest !== baseline.expectedImage.split("@")[1] ||
      config.env?.LEADERBOT_DEPLOYMENT_IDENTITY !== baseline.identity ||
      Object.entries(expected).some(
        ([key, value]) => config.env?.[key] !== value,
      ) ||
      [
        "MOLLIE_CREDIT_TEST_CHANNEL_CONNECTION_ID",
        "MOLLIE_CREDIT_TEST_BINDING_EPOCH",
        "MOLLIE_CREDIT_TEST_PRIVACY_EPOCH",
        "MOLLIE_CREDIT_TEST_USER_KEY_HASH",
      ].some(
        (key) =>
          typeof config.env?.[key] !== "undefined" && config.env[key] !== "",
      )
    )
      reject();
  }
  for (const group of ["app", "worker"]) {
    if (
      app.desiredScale?.[group]?.count !== 2 ||
      machines.filter((m) => m.config.metadata.fly_process_group === group)
        .length !== 2
    )
      reject();
  }
  return machines
    .filter((m) => m.config.metadata.fly_process_group === "app")
    .sort((a, b) => a.id.localeCompare(b.id))[0];
}

export function parseOperatorResult(
  raw,
  input,
  baseline,
  principal,
  bundleSha256,
) {
  const result = JSON.parse(raw);
  const expected = {
    event: "test_payment_operator_completed",
    status: "enabled",
    mode: "test",
    workspaceId: 1,
    requestId: input.requestId,
    executionEpoch: input.expectedEpoch + 1,
    committed: true,
    source: "protected_workflow",
    githubActorId: input.actorId,
    githubRunId: input.runId,
    githubRunAttempt: input.runAttempt,
    sourceSha: input.workflowSourceSha,
    deploymentIdentity: baseline.identity,
    runtimePrincipalSha256: principal,
    operatorImage: input.image,
    artifactSourceSha: input.artifactSourceSha,
    bundleSha256,
    runtimeImage: baseline.expectedImage,
  };
  if (
    !result ||
    Object.keys(result).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, value]) => result[key] !== value)
  )
    reject();
  return expected;
}

function reportedCommitted(error, input, baseline, principal, bundleSha256) {
  // Inspect only a strict receipt schema in memory. Never return raw command
  // diagnostics, even when the trusted CLI closed its pool after committing.
  const text = (value) =>
    typeof value === "string"
      ? value
      : Buffer.isBuffer(value)
        ? value.toString("utf8")
        : "";
  try {
    parseOperatorResult(
      text(error?.stdout).trim(),
      input,
      baseline,
      principal,
      bundleSha256,
    );
    return true;
  } catch {
    /* A missing success receipt is not proof of rollback. */
  }
  try {
    const lines = text(error?.stderr)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    if (
      !lines.length ||
      lines.some((value) => {
        if (!value || typeof value.committed !== "boolean") return true;
        if (value.event === "test_payment_operator_cleanup_failed")
          return Object.keys(value).sort().join(",") !== "committed,event";
        return (
          value.event !== "test_payment_operator_failed" ||
          Object.keys(value).sort().join(",") !==
            "committed,event,failedStage,outcome" ||
          ![
            "config",
            "owner",
            "registration",
            "activation",
            "readback",
          ].includes(value.failedStage) ||
          !["not_started", "unknown"].includes(value.outcome) ||
          (value.committed && value.outcome !== "unknown")
        );
      })
    )
      return false;
    return lines.some((value) => value.committed);
  } catch {
    return false;
  }
}

// Only fixed code and already validated opaque values enter the SSH command.
export function operatorCommand(
  remotePath,
  input,
  baseline,
  principal,
  bundleSha256,
) {
  if (
    !/^\/tmp\/leaderbot-test-payment-operator-[1-9][0-9]*-[1-9][0-9]*\.cjs$/.test(
      remotePath,
    ) ||
    !/^deploy-[0-9]+-[0-9]+$/.test(baseline.identity) ||
    !sha(principal) ||
    !sha(bundleSha256) ||
    !/^[a-f0-9]{40}$/.test(input.artifactSourceSha ?? "") ||
    ![input.image, baseline.expectedImage].every(
      (value) =>
        typeof value === "string" &&
        /^registry\.fly\.io\/leaderbot-fb-image-gen@sha256:[a-f0-9]{64}$/.test(
          value,
        ),
    )
  )
    reject();
  const values = {
    REQUEST_ID: input.requestId,
    EXPECTED_EPOCH: input.expectedEpoch,
    WORKSPACE_ID: 1,
    GITHUB_ACTOR_ID: input.actorId,
    GITHUB_RUN_ID: input.runId,
    GITHUB_RUN_ATTEMPT: input.runAttempt,
    SOURCE_SHA: input.workflowSourceSha,
    DEPLOYMENT_IDENTITY: baseline.identity,
    OPERATOR_IMAGE: input.image,
    ARTIFACT_SOURCE_SHA: input.artifactSourceSha,
    BUNDLE_SHA256: bundleSha256,
    RUNTIME_IMAGE: baseline.expectedImage,
  };
  if (Object.values(values).some((v) => !/^[A-Za-z0-9:/@.-]+$/.test(String(v))))
    reject();
  return [
    "env",
    `EXPECTED_RUNTIME_PRINCIPAL_SHA256=${principal}`,
    ...Object.entries(values).map(
      ([key, value]) => `LEADERBOT_TEST_PAYMENT_OPERATOR_${key}=${value}`,
    ),
    "node",
    remotePath,
  ].join(" ");
}

export async function runTestPaymentOperator(options = {}, dependencies = {}) {
  const env = options.env ?? process.env;
  const rootDir = options.rootDir ?? process.cwd();
  const run = dependencies.execute ?? execute;
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const settled = dependencies.settled ?? checkSettledLiveFlyDrift;
  const sourceCi = dependencies.sourceCi ?? verifySourceCi;
  const artifactCi = dependencies.artifactCi ?? verifyReviewedArtifactCi;
  const readManifest = dependencies.readManifest ?? loadProductionManifest;
  const evidence = {
    event: "test_payment_operator_evidence",
    success: false,
    stage: "inputs",
    outcome: "not_started",
    committed: false,
    remoteRemoved: false,
    containerRemoved: false,
    baselineUnchanged: false,
  };
  let container, remote, machine, localBundle, input, baseline;
  let uploadStarted = false;
  const baseEnv = Object.fromEntries(
    ["PATH", "HOME", "DOCKER_CONFIG", "TMPDIR"]
      .filter((k) => env[k])
      .map((k) => [k, env[k]]),
  );
  const flyEnv = { ...baseEnv, FLY_API_TOKEN: env.FLY_API_TOKEN };
  const githubEnv = { ...baseEnv, GH_TOKEN: env.GITHUB_TOKEN };
  const fly = (args) => run("flyctl", args, flyEnv);
  const ssh = (command) =>
    fly([
      "ssh",
      "console",
      "--app",
      APP,
      "--machine",
      machine.id,
      "--quiet",
      "--command",
      command,
    ]);
  const ready = () => {
    const code =
      'Promise.all(["/healthz","/readyz"].map(async p=>{const r=await fetch("http://127.0.0.1:8080"+p,{signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error();if(p==="/readyz"){const b=await r.json();if(b.phase!=="operational"||b.ok!==true||!Array.isArray(b.checks)||b.checks.length===0||!b.checks.every(v=>v.ok===true))throw Error();}})).then(()=>process.stdout.write("operator_machine_ready")).catch(()=>{process.exitCode=1;})';
    if (ssh(`node -e '${code}'`) !== "operator_machine_ready") reject();
  };
  const verify = {
    rootDir,
    repository: REPOSITORY,
    token: env.GITHUB_TOKEN,
    fetchImpl,
    runFly: fly,
  };
  const readBaseline = async () => {
    const value = await settled("image-gen", verify);
    if (
      value.blockingErrors?.length ||
      value.reconcilableDrift?.length ||
      !/^deploy-[0-9]+-[0-9]+$/.test(value.identity ?? "") ||
      !sha(value.releaseWatermark)
    )
      reject();
    return value;
  };
  try {
    input = await verifyOperatorRun(env, fetchImpl);
    if (run("git", ["rev-parse", "HEAD"], baseEnv) !== input.workflowSourceSha)
      reject();
    const app = readManifest(rootDir).apps["image-gen"];
    const activation = app.creditTestActivation?.operator;
    if (
      app.app !== APP ||
      app.reviewedImage !== input.image ||
      app.reviewedSourceCommit !== input.artifactSourceSha ||
      app.reviewedArtifactKind !== "runtime" ||
      app.databaseSchemaPhase !== "0018_credit_checkout_reservation" ||
      app.databaseSchemaTransition?.state !== "complete" ||
      !sha(app.databaseSchemaTransition.runtimePrincipalSha256)
    )
      reject();
    // This workflow prepares only the reviewed initial 1 -> 2 activation.
    // A later release or disable must never become another enable request.
    if (
      !activation ||
      activation.requestId !== input.requestId ||
      activation.previousEpoch !== 1 ||
      activation.epoch !== 2 ||
      input.expectedEpoch !== activation.previousEpoch ||
      activation.operatorImage !== input.image ||
      activation.artifactSourceSha !== input.artifactSourceSha
    )
      reject();
    evidence.stage = "source_ci";
    await sourceCi(input.workflowSourceSha, verify);
    await artifactCi("image-gen", input.image, verify);
    evidence.stage = "baseline";
    baseline = await readBaseline();
    if (
      baseline.identity !== app.reviewedSettledPredecessor?.identity ||
      baseline.expectedImage !== app.reviewedSettledPredecessor?.image ||
      baseline.identity !== activation.deploymentIdentity ||
      baseline.expectedImage !== activation.runtimeImage
    )
      reject();
    machine = assertPreparedMachines(
      JSON.parse(fly(["machine", "list", "--app", APP, "--json"])),
      baseline,
      app,
    );
    ready();
    Object.assign(evidence, {
      workflowSourceSha: input.workflowSourceSha,
      artifactSourceSha: input.artifactSourceSha,
      operatorImage: input.image,
      requestId: input.requestId,
      runId: input.runId,
      runAttempt: input.runAttempt,
      githubActorId: input.actorId,
      machineId: machine.id,
      deploymentIdentity: baseline.identity,
      runtimeImage: baseline.expectedImage,
      releaseWatermark: baseline.releaseWatermark,
      checkoutEnabled: false,
      paidImageUseEnabled: false,
      liveBillingEnabled: false,
    });
    evidence.stage = "artifact";
    fly(["auth", "docker"]);
    run("docker", ["pull", input.image], baseEnv);
    const labels = JSON.parse(
      run(
        "docker",
        [
          "image",
          "inspect",
          "--format",
          "{{json .Config.Labels}}",
          input.image,
        ],
        baseEnv,
      ),
    );
    if (
      labels["org.opencontainers.image.revision"] !== input.artifactSourceSha ||
      labels["io.leaderbot.artifact.kind"] !== "runtime" ||
      labels["io.leaderbot.schema.minimum"] !==
        "0018_credit_checkout_reservation" ||
      labels["io.leaderbot.schema.maximum"] !==
        "0018_credit_checkout_reservation"
    )
      reject();
    run(
      "gh",
      [
        "attestation",
        "verify",
        `oci://${input.image}`,
        "--repo",
        REPOSITORY,
        "--signer-workflow",
        `${REPOSITORY}/.github/workflows/build-production-artifacts.yml`,
        "--source-digest",
        input.artifactSourceSha,
        "--source-ref",
        "refs/heads/main",
        "--deny-self-hosted-runners",
      ],
      githubEnv,
    );
    container = run("docker", ["create", input.image], baseEnv);
    if (!/^[a-f0-9]{64}$/.test(container)) reject();
    const localDir = fs.mkdtempSync(
      path.join(
        options.tempDir ?? env.RUNNER_TEMP ?? "/tmp",
        "leaderbot-test-payment-operator-",
      ),
    );
    localBundle = path.join(localDir, "enable-test-payments.cjs");
    run(
      "docker",
      ["cp", `${container}:/app/dist/enable-test-payments.cjs`, localBundle],
      baseEnv,
    );
    const stat = fs.lstatSync(localBundle);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !stat.size ||
      stat.size > 32 * 1024 * 1024
    )
      reject();
    evidence.bundleSha256 = digest(fs.readFileSync(localBundle));
    remote = `/tmp/leaderbot-test-payment-operator-${input.runId}-${input.runAttempt}.cjs`;
    evidence.stage = "upload";
    ssh(`test ! -e ${remote}`);
    uploadStarted = true;
    fly([
      "ssh",
      "sftp",
      "put",
      localBundle,
      remote,
      "--app",
      APP,
      "--machine",
      machine.id,
      "--mode",
      "0400",
    ]);
    const remoteHash = ssh(`sha256sum ${remote}`);
    if (remoteHash !== `${evidence.bundleSha256}  ${remote}`) reject();
    evidence.stage = "pre_mutation";
    await verifyOperatorRun(env, fetchImpl);
    const fresh = await readBaseline();
    if (
      fresh.identity !== baseline.identity ||
      fresh.expectedImage !== baseline.expectedImage ||
      fresh.releaseWatermark !== baseline.releaseWatermark
    )
      reject();
    const selected = assertPreparedMachines(
      JSON.parse(fly(["machine", "list", "--app", APP, "--json"])),
      baseline,
      app,
    );
    if (selected.id !== machine.id) reject();
    ready();
    evidence.stage = "activation";
    evidence.outcome = "unknown";
    // Do not retry: a lost SSH response can follow a committed transaction.
    let raw;
    try {
      raw = ssh(
        operatorCommand(
          remote,
          input,
          baseline,
          app.databaseSchemaTransition.runtimePrincipalSha256,
          evidence.bundleSha256,
        ),
      );
    } catch (error) {
      evidence.committed = reportedCommitted(
        error,
        input,
        baseline,
        app.databaseSchemaTransition.runtimePrincipalSha256,
        evidence.bundleSha256,
      );
      reject();
    }
    evidence.result = parseOperatorResult(
      raw,
      input,
      baseline,
      app.databaseSchemaTransition.runtimePrincipalSha256,
      evidence.bundleSha256,
    );
    evidence.committed = true;
    evidence.outcome = "committed";
    evidence.stage = "readback";
    const after = await readBaseline();
    if (
      after.identity !== baseline.identity ||
      after.expectedImage !== baseline.expectedImage ||
      after.releaseWatermark !== baseline.releaseWatermark
    )
      reject();
    assertPreparedMachines(
      JSON.parse(fly(["machine", "list", "--app", APP, "--json"])),
      baseline,
      app,
    );
    ready();
    evidence.baselineUnchanged = true;
    evidence.success = true;
    evidence.stage = "complete";
  } catch {
    // Never serialize command errors, stdout, stderr or causes: they may carry secrets.
    evidence.success = false;
  } finally {
    if (uploadStarted) {
      try {
        ssh(`/bin/rm -f ${remote}`);
        ssh(`test ! -e ${remote}`);
        evidence.remoteRemoved = true;
      } catch {
        evidence.success = false;
        evidence.cleanupFailed = true;
      }
    }
    if (container && /^[a-f0-9]{64}$/.test(container)) {
      try {
        run("docker", ["rm", "-f", container], baseEnv);
        evidence.containerRemoved = true;
      } catch {
        evidence.success = false;
        evidence.cleanupFailed = true;
      }
    }
    try {
      run("docker", ["logout", "registry.fly.io"], baseEnv);
    } catch {
      evidence.success = false;
      evidence.cleanupFailed = true;
    }
    if (localBundle) {
      try {
        fs.rmSync(localBundle, { force: true });
      } catch {
        evidence.success = false;
        evidence.cleanupFailed = true;
      }
    }
  }
  return evidence;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const evidence = await runTestPaymentOperator();
  const output = `${JSON.stringify(evidence)}\n`;
  if (process.env.RUNNER_TEMP)
    fs.writeFileSync(
      path.join(process.env.RUNNER_TEMP, "test-payment-operator-evidence.json"),
      output,
      { mode: 0o600 },
    );
  process.stdout.write(output);
  if (!evidence.success) process.exitCode = 1;
}
