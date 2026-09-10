import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { RootMysqlSession } from "./provision-image-gen-credit-provisioner.mjs";
import { selectReviewedDatabaseTarget } from "./image-gen-credit-provisioner-bootstrap-contract.mjs";
import { readCreditTestActivation } from "./validate-production-deployment.mjs";

const REPOSITORY = "Dj-Shortcut/openclaw-facebook";
const WORKFLOW = ".github/workflows/deploy-production.yml";
const MAX_AGE_MS = 15 * 60_000;
const sha = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const fail = () => {
  throw new Error("credit_test_proof_rejected");
};
const digest = (value) => createHash("sha256").update(value).digest("hex");

export function assertCreditTestRun(env) {
  if (
    env.GITHUB_REPOSITORY !== REPOSITORY ||
    env.GITHUB_REF !== "refs/heads/main" ||
    env.GITHUB_EVENT_NAME !== "workflow_dispatch" ||
    env.GITHUB_WORKFLOW_REF !== `${REPOSITORY}/${WORKFLOW}@refs/heads/main` ||
    !/^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? "") ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? "") ||
    !/^[1-9][0-9]*$/.test(env.GITHUB_RUN_ATTEMPT ?? "")
  )
    fail();
  return {
    sourceHead: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
  };
}

export async function assertProtectedCreditTestRun(env, fetchImpl = fetch) {
  const run = assertCreditTestRun(env);
  if (!env.GITHUB_TOKEN) fail();
  const response = await fetchImpl(
    `https://api.github.com/repos/${REPOSITORY}/actions/runs/${run.runId}/attempts/${run.runAttempt}`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    },
  );
  if (!response.ok) fail();
  const body = await response.json();
  if (
    String(body.id) !== run.runId ||
    String(body.run_attempt) !== run.runAttempt ||
    body.head_sha !== run.sourceHead ||
    body.head_branch !== "main" ||
    body.head_repository?.full_name !== REPOSITORY ||
    body.event !== "workflow_dispatch" ||
    body.path !== WORKFLOW ||
    body.status !== "in_progress" ||
    body.conclusion !== null
  )
    fail();
  return run;
}

// Fixed metadata-only queries, never PROCESSLIST.INFO. Use MySQL 8.4's legacy
// process inventory: Performance Schema instrumentation/capacity can omit rows.
// Require effective PROCESS visibility and our own session before accepting 0.
export function obsoletePrincipalProofQueries(principalSha256) {
  if (!sha(principalSha256)) fail();
  return [
    `SELECT COUNT(*),COALESCE(SUM(Host='%' AND account_locked='Y'),0) FROM mysql.user WHERE SHA2(User,256)='${principalSha256}'`,
    "SELECT COUNT(*) FROM mysql.user WHERE CONCAT(User,'@',Host)=CURRENT_USER() AND Process_priv='Y'",
    "SELECT COUNT(*) FROM INFORMATION_SCHEMA.PROCESSLIST WHERE ID=CONNECTION_ID()",
    `SELECT COUNT(*) FROM INFORMATION_SCHEMA.PROCESSLIST WHERE SHA2(USER,256)='${principalSha256}'`,
  ];
}

export async function inspectLockedObsoletePrincipal(
  session,
  principalSha256,
  signal,
) {
  const queries = obsoletePrincipalProofQueries(principalSha256);
  const account = await session.execute(queries[0], { signal });
  const privileges = await session.execute(queries[1], { signal });
  const visibility = await session.execute(queries[2], { signal });
  if (
    privileges.length !== 1 ||
    privileges[0] !== "1" ||
    visibility.length !== 1 ||
    visibility[0] !== "1"
  )
    fail();
  const sessions = await session.execute(queries[3], { signal });
  if (
    account.length !== 1 ||
    !["1\t1", "0\t0"].includes(account[0]) ||
    sessions.length !== 1 ||
    sessions[0] !== "0"
  )
    fail();
  return {
    obsoleteAccountState: account[0] === "1\t1" ? "locked" : "absent",
    obsoleteSessionCount: 0,
  };
}

export function selectCreditTestRuntimeMachines(
  machines,
  app,
  identity,
  image,
) {
  if (
    !Array.isArray(machines) ||
    !/^deploy-[1-9][0-9]*-[1-9][0-9]*$/.test(identity ?? "") ||
    !app.reviewedRollbackImages.includes(image) ||
    app.reviewedRollbackArtifactKinds[image] !== "runtime"
  )
    fail();
  const expected = Object.values(app.desiredScale).reduce(
    (total, group) => total + group.count,
    0,
  );
  if (
    machines.length !== expected ||
    new Set(machines.map((m) => m.id)).size !== expected
  )
    fail();
  for (const [group, scale] of Object.entries(app.desiredScale)) {
    if (
      machines.filter((m) => m.config?.metadata?.fly_process_group === group)
        .length !== scale.count
    )
      fail();
  }
  for (const machine of machines) {
    if (
      machine.state !== "started" ||
      !/^[a-f0-9]{14}$/.test(machine.id ?? "") ||
      machine.config?.env?.LEADERBOT_DEPLOYMENT_IDENTITY !== identity ||
      machine.image_ref?.digest !== image.slice(image.indexOf("@") + 1)
    )
      fail();
  }
  return machines.map((m) => m.id).sort();
}

export function assertCreditTestUnlockAllowed({ app, machines }) {
  if (
    app.creditTestActivation !== undefined ||
    !Array.isArray(machines) ||
    machines.length === 0
  )
    fail();
  // Check all Machines, including stopped ones which could later reconnect.
  for (const machine of machines) {
    if (
      !["app", "worker"].includes(machine.config?.metadata?.fly_process_group)
    )
      fail();
    for (const key of [
      "MESSENGER_PAID_CREDITS_ENABLED",
      "MOLLIE_CREDIT_CHECKOUT_ENABLED",
    ]) {
      if (machine.config?.env?.[key] !== "false") fail();
    }
  }
}

export function assertCreditTestEvidence(evidence, current, now = Date.now()) {
  if (
    !evidence ||
    typeof evidence !== "object" ||
    Array.isArray(evidence) ||
    Object.keys(evidence).sort().join(",") !==
      Object.keys(current).sort().join(",")
  )
    fail();
  const checkedAt = Date.parse(evidence.checkedAt);
  if (
    !Number.isFinite(checkedAt) ||
    now < checkedAt ||
    now - checkedAt > MAX_AGE_MS
  )
    fail();
  for (const key of Object.keys(current)) {
    if (
      key !== "checkedAt" &&
      JSON.stringify(evidence[key]) !== JSON.stringify(current[key])
    )
      fail();
  }
  if (
    !["locked", "absent"].includes(evidence.obsoleteAccountState) ||
    evidence.obsoleteSessionCount !== 0
  )
    fail();
}

function run(command, args, env) {
  return execFileSync(command, args, {
    env,
    encoding: "utf8",
    timeout: 50_000,
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export async function collectCreditTestProof({
  app,
  env = process.env,
  rootDir = process.cwd(),
  execute = run,
  sessionFactory = (options) => new RootMysqlSession(options),
  fetchImpl = fetch,
  now = Date.now,
}) {
  const runContext = await assertProtectedCreditTestRun(env, fetchImpl);
  if (
    execute("git", ["rev-parse", "HEAD"], env) !== runContext.sourceHead ||
    !env.CREDIT_TEST_IMAGE_TOKEN ||
    !env.CREDIT_TEST_DATABASE_TOKEN ||
    !sha(app.databaseSchemaTransition?.runtimePrincipalSha256) ||
    !sha(app.creditTestActivation?.obsoletePrincipalSha256) ||
    app.databaseSchemaTransition.runtimePrincipalSha256 ===
      app.creditTestActivation.obsoletePrincipalSha256
  )
    fail();
  const imageEnv = { ...env, FLY_API_TOKEN: env.CREDIT_TEST_IMAGE_TOKEN };
  const databaseEnv = { ...env, FLY_API_TOKEN: env.CREDIT_TEST_DATABASE_TOKEN };
  for (const context of [imageEnv, databaseEnv]) {
    delete context.CREDIT_TEST_IMAGE_TOKEN;
    delete context.CREDIT_TEST_DATABASE_TOKEN;
  }
  delete databaseEnv.GITHUB_TOKEN;
  const flyJson = (args, context) =>
    JSON.parse(execute("flyctl", args, context));
  const settled = () =>
    JSON.parse(
      execute(
        "node",
        [
          "scripts/validate-production-deployment.mjs",
          "--settled-live",
          "image-gen",
          "--output-json",
        ],
        imageEnv,
      ),
    );
  const baseline = settled();
  const predecessor = app.reviewedSettledPredecessor;
  if (
    !predecessor ||
    baseline.identity !== predecessor.identity ||
    baseline.expectedImage !== predecessor.image
  )
    fail();
  execute(
    "node",
    [
      "scripts/validate-production-deployment.mjs",
      "--verify-settled-baseline",
      "image-gen",
      baseline.identity,
      "--expected-image",
      baseline.expectedImage,
    ],
    imageEnv,
  );
  const runtimeIds = selectCreditTestRuntimeMachines(
    flyJson(["machine", "list", "--app", app.app, "--json"], imageEnv),
    app,
    baseline.identity,
    baseline.expectedImage,
  );
  for (const id of runtimeIds) {
    const output = execute(
      "flyctl",
      [
        "ssh",
        "console",
        "--app",
        app.app,
        "--machine",
        id,
        "--quiet",
        "--command",
        `/usr/bin/env EXPECTED_RUNTIME_PRINCIPAL_SHA256=${app.databaseSchemaTransition.runtimePrincipalSha256} node /app/dist/billing-trigger-runtime-preflight.cjs`,
      ],
      imageEnv,
    );
    if (output !== "Billing trigger runtime preflight passed.") fail();
  }
  const recovery = app.databaseRecovery;
  if (
    recovery.app !== "leaderbot-portal-mysql" ||
    recovery.databaseName !== "leaderbot"
  )
    fail();
  const databaseTarget = () =>
    selectReviewedDatabaseTarget({
      machines: flyJson(
        ["machine", "list", "--app", recovery.app, "--json"],
        databaseEnv,
      ),
      volumes: flyJson(
        ["volumes", "list", "--app", recovery.app, "--json"],
        databaseEnv,
      ),
      recovery,
    });
  const target = databaseTarget();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 90_000);
  const session = sessionFactory({
    app: recovery.app,
    machineId: target.machine.id,
    signal: controller.signal,
    env: databaseEnv,
  });
  let state;
  try {
    await session.initialize(controller.signal);
    state = await inspectLockedObsoletePrincipal(
      session,
      app.creditTestActivation.obsoletePrincipalSha256,
      controller.signal,
    );
  } finally {
    clearTimeout(timeout);
    await session.close({ releaseLock: false });
  }
  if (
    JSON.stringify(settled()) !== JSON.stringify(baseline) ||
    databaseTarget().machine.id !== target.machine.id ||
    JSON.stringify(
      selectCreditTestRuntimeMachines(
        flyJson(["machine", "list", "--app", app.app, "--json"], imageEnv),
        app,
        baseline.identity,
        baseline.expectedImage,
      ),
    ) !== JSON.stringify(runtimeIds)
  )
    fail();
  return {
    version: 1,
    repository: REPOSITORY,
    workflow: WORKFLOW,
    ...runContext,
    candidateIdentity: `deploy-${runContext.runId}-${runContext.runAttempt}`,
    predecessor: baseline,
    runtimeMachineIds: runtimeIds,
    databaseApp: recovery.app,
    databaseName: recovery.databaseName,
    databaseMachineId: target.machine.id,
    databaseVolumeId: recovery.volumeId,
    schemaPhase: app.databaseSchemaPhase,
    runtimePrincipalSha256: app.databaseSchemaTransition.runtimePrincipalSha256,
    obsoletePrincipalSha256: app.creditTestActivation.obsoletePrincipalSha256,
    manifestSha256: digest(
      fs.readFileSync(path.join(rootDir, "deploy/production/apps.json")),
    ),
    configSha256: digest(fs.readFileSync(path.join(rootDir, app.config))),
    ...state,
    checkedAt: new Date(now()).toISOString(),
  };
}

async function main() {
  const operation = process.argv[2];
  if (
    !["request", "prove", "consume", "guard-unlock"].includes(operation) ||
    process.argv.length !== 3
  )
    fail();
  const { app, active } = readCreditTestActivation();
  if (operation === "request") {
    if (!process.env.GITHUB_OUTPUT) fail();
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `active=${active}\n`);
    return;
  }
  if (operation === "guard-unlock") {
    const machines = JSON.parse(
      run(
        "flyctl",
        ["machine", "list", "--app", app.app, "--json"],
        process.env,
      ),
    );
    assertCreditTestUnlockAllowed({ app, machines });
    process.stdout.write("credit_test_unlock_guard_passed\n");
    return;
  }
  if (!active) {
    process.stdout.write("credit_test_activation_disabled\n");
    return;
  }
  assertCreditTestRun(process.env);
  const directory = path.join(
    process.env.RUNNER_TEMP,
    "leaderbot-credit-test-proof",
  );
  const evidencePath = path.join(directory, "evidence.json");
  const current = await collectCreditTestProof({ app });
  if (operation === "prove") {
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.writeFileSync(evidencePath, `${JSON.stringify(current)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
  } else {
    const stat = fs.lstatSync(evidencePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 32_768) fail();
    assertCreditTestEvidence(
      JSON.parse(fs.readFileSync(evidencePath, "utf8")),
      current,
    );
  }
  process.stdout.write(
    `credit_test_proof_${operation === "prove" ? "recorded" : "consumed"}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch(() => {
    process.stderr.write("credit_test_proof_rejected\n");
    process.exitCode = 1;
  });
}
