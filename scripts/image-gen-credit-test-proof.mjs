import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildFlyProxyArgs,
  waitForFlyProxyStartup,
} from "./provision-image-gen-credit-provisioner.mjs";
import {
  assertProvisionerUrl,
  selectReviewedDatabaseTarget,
} from "./image-gen-credit-provisioner-bootstrap-contract.mjs";
import { assertCreditProvisionerGrantScope } from "../apps/image-gen/scripts/production-schema-contract.mjs";
import { collectCreditTestSessionInventory } from "./credit-test-session-inventory.mjs";
import { inspectCommittedTestPaymentActivation } from "./image-gen-test-payment-activation-audit.mjs";
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

// Account state is separate from the complete, stable metadata-only census.
export function obsoletePrincipalProofQueries(principalSha256) {
  if (!sha(principalSha256)) fail();
  return [
    `SELECT COUNT(*),COALESCE(SUM(Host='%' AND account_locked='Y'),0) FROM mysql.user WHERE SHA2(User,256)='${principalSha256}'`,
  ];
}

export async function inspectLockedObsoletePrincipal(
  session,
  principalSha256,
  signal,
) {
  const queries = obsoletePrincipalProofQueries(principalSha256);
  const account = await session.execute(queries[0], { signal });
  if (account.length !== 1 || !["1\t1", "0\t0"].includes(account[0])) fail();
  const census = await collectCreditTestSessionInventory(session, {
    obsoletePrincipalSha256: principalSha256,
    expectedSessionId: session.expectedSessionId,
  });
  if (!census.verified) fail();
  const after = await session.execute(queries[0], { signal });
  if (JSON.stringify(after) !== JSON.stringify(account)) fail();
  return {
    obsoleteAccountState: account[0] === "1\t1" ? "locked" : "absent",
    obsoleteSessionCount: 0,
  };
}

// Existing provisioner credential, exact selected Machine IP, no SSH/root path.
export async function openCreditTestProvisionerSession({
  recovery,
  machine,
  url,
  env,
  signal,
  spawnChild = spawn,
  mysql = createRequire(
    new URL("../apps/image-gen/package.json", import.meta.url),
  )("mysql2/promise"),
}) {
  let child, connection, expectedSessionId;
  const childEnv = { ...env };
  delete childEnv.DATABASE_PROVISIONER_URL;
  delete childEnv.IMAGE_GEN_DATABASE_PROVISIONER_URL;
  const abort = () => {
    connection?.destroy();
    child?.kill("SIGTERM");
  };
  const close = async () => {
    signal?.removeEventListener("abort", abort);
    connection?.destroy();
    if (child && child.exitCode === null && child.signalCode == null) {
      const closed = new Promise((resolve) => child.once("close", resolve));
      let timer;
      child.kill("SIGTERM");
      await Promise.race([
        closed,
        new Promise((resolve) => {
          timer = setTimeout(resolve, 1000);
        }),
      ]);
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode == null) {
        child.kill("SIGKILL");
        await Promise.race([
          closed,
          new Promise((resolve) => {
            timer = setTimeout(resolve, 1000);
          }),
        ]);
        clearTimeout(timer);
        if (child.exitCode === null && child.signalCode == null) fail();
      }
    }
  };
  try {
    if (signal?.aborted) fail();
    const parsed = new URL(url);
    assertProvisionerUrl(url, {
      databaseName: recovery.databaseName,
      username: parsed.username,
    });
    child = spawnChild("flyctl", buildFlyProxyArgs({ recovery, machine }), {
      env: childEnv,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.on("error", abort);
    child.on("close", () => connection?.destroy());
    signal?.addEventListener("abort", abort, { once: true });
    const port = await waitForFlyProxyStartup({
      child,
      expectedPrivateIp: machine.private_ip,
      signal,
    });
    parsed.port = String(port);
    connection = await mysql.createConnection(parsed.toString());
    if (
      signal?.aborted ||
      child.exitCode !== null ||
      child.signalCode != null ||
      child.killed
    )
      fail();
    const execute = async (sql) => {
      if (
        signal?.aborted ||
        child.exitCode !== null ||
        child.signalCode != null ||
        child.killed
      )
        fail();
      try {
        const [rows] = await connection.query({
          sql,
          timeout: 10_000,
          rowsAsArray: true,
        });
        if (
          signal?.aborted ||
          child.exitCode !== null ||
          child.signalCode != null ||
          child.killed
        )
          fail();
        if (!Array.isArray(rows) || rows.some((row) => !Array.isArray(row)))
          fail();
        return rows.map((row) =>
          row
            .map((value) => (value === null ? "NULL" : String(value)))
            .join("\t"),
        );
      } catch {
        fail();
      }
    };
    return {
      execute,
      get expectedSessionId() {
        return expectedSessionId;
      },
      async initialize() {
        const rows = await execute(
          "SELECT CURRENT_USER(),DATABASE(),CONNECTION_ID()",
        );
        const identity = rows.length === 1 ? rows[0].split("\t") : [];
        if (
          identity.length !== 3 ||
          identity[0] !== `${parsed.username}@%` ||
          identity[1] !== recovery.databaseName ||
          !/^[1-9][0-9]*$/.test(identity[2]) ||
          (expectedSessionId !== undefined && expectedSessionId !== identity[2])
        )
          fail();
        expectedSessionId = identity[2];
        assertCreditProvisionerGrantScope(
          await execute("SHOW GRANTS FOR CURRENT_USER()"),
          recovery.databaseName,
          { requireSessionInventory: true },
        );
      },
      close,
    };
  } catch {
    await close();
    fail();
  }
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
  sessionFactory = openCreditTestProvisionerSession,
  fetchImpl = fetch,
  now = Date.now,
}) {
  const runContext = await assertProtectedCreditTestRun(env, fetchImpl);
  if (
    !env.CREDIT_TEST_IMAGE_TOKEN ||
    !env.CREDIT_TEST_DATABASE_TOKEN ||
    !env.DATABASE_PROVISIONER_URL ||
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
    delete context.DATABASE_PROVISIONER_URL;
    delete context.IMAGE_GEN_DATABASE_PROVISIONER_URL;
  }
  delete databaseEnv.GITHUB_TOKEN;
  if (execute("git", ["rev-parse", "HEAD"], imageEnv) !== runContext.sourceHead)
    fail();
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
  let session;
  let state;
  let activation;
  try {
    session = await sessionFactory({
      recovery,
      machine: target.machine,
      url: env.DATABASE_PROVISIONER_URL,
      signal: controller.signal,
      env: databaseEnv,
    });
    await session.initialize(controller.signal);
    state = await inspectLockedObsoletePrincipal(
      session,
      app.creditTestActivation.obsoletePrincipalSha256,
      controller.signal,
    );
    activation = await inspectCommittedTestPaymentActivation(session, {
      workspaceId: 1,
      app,
      baseline,
      signal: controller.signal,
      githubToken: env.GITHUB_TOKEN,
      fetchImpl,
    });
    await session.initialize(controller.signal);
  } finally {
    clearTimeout(timeout);
    await session?.close();
  }
  const afterTarget = databaseTarget();
  if (
    JSON.stringify(settled()) !== JSON.stringify(baseline) ||
    afterTarget.machine.id !== target.machine.id ||
    afterTarget.machine.private_ip !== target.machine.private_ip ||
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
    activation,
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
