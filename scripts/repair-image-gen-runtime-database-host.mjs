import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import { isIP } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  checkSettledLiveFlyDrift,
  verifySourceCi,
} from "./validate-production-deployment.mjs";

const APP = "leaderbot-fb-image-gen";
const REPOSITORY = "Dj-Shortcut/openclaw-facebook";

// Also executed verbatim in the isolated probe. Never include the URL in errors.
function normalizeWithTools(value, binding, { isIP, createHash }) {
  const reject = () => {
    throw new Error("runtime_database_host_rejected");
  };
  if (
    !binding ||
    !/^[a-f0-9]{14}$/.test(binding.machineId) ||
    binding.app !== "leaderbot-portal-mysql" ||
    binding.database !== "leaderbot" ||
    isIP(binding.privateIp) !== 6 ||
    !binding.privateIp.startsWith("fdaa:") ||
    !/^[a-f0-9]{64}$/.test(binding.principalSha256)
  )
    reject();
  let url;
  try {
    url = new URL(value);
  } catch {
    reject();
  }
  const host = `${binding.machineId}.vm.${binding.app}.internal`;
  if (
    url.protocol !== "mysql:" ||
    url.port !== "3306" ||
    url.pathname !== `/${binding.database}` ||
    url.search ||
    url.hash ||
    !url.password ||
    !/^lbcr_[a-z0-9_]+$/.test(url.username) ||
    createHash("sha256").update(url.username).digest("hex") !==
      binding.principalSha256 ||
    ![`[${binding.privateIp}]`, host].includes(url.hostname)
  )
    reject();
  const changed = url.hostname !== host;
  url.hostname = host;
  if (url.hostname !== host) reject();
  return { url: url.href, changed, host };
}

export function normalizeRuntimeDatabaseUrl(value, binding) {
  return normalizeWithTools(value, binding, { isIP, createHash });
}

export function buildRuntimeHostProbe(binding) {
  return `
    const { createHash } = require("node:crypto");
    const { isIP } = require("node:net");
    const { resolve6 } = require("node:dns/promises");
    const { spawnSync } = require("node:child_process");
    const normalize = ${normalizeWithTools.toString()};
    const binding = ${JSON.stringify(binding)};
    (async () => {
      const normalized = normalize(process.env.DATABASE_URL, binding, { isIP, createHash });
      const addresses = await resolve6(normalized.host);
      if (addresses.length !== 1 || addresses[0] !== binding.privateIp) throw new Error();
      const env = {
        ...process.env, DATABASE_URL: normalized.url,
        LEADERBOT_PRODUCTION_MIGRATION_MODE: "verify-artifact",
        EXPECTED_RUNTIME_PRINCIPAL_SHA256: binding.principalSha256,
        MOLLIE_MODE: "test"
      };
      for (const file of ["migrate-production.cjs", "billing-trigger-runtime-preflight.cjs"]) {
        const result = spawnSync(process.execPath, ["/app/dist/" + file], {
          env, cwd: "/app", timeout: 60000, maxBuffer: 1048576,
          stdio: ["ignore", "pipe", "pipe"]
        });
        if (result.error || result.status !== 0) throw new Error();
      }
      // SSH command stdout is consumed in runner memory, never by app logs.
      process.stdout.write(normalized.url);
    })().catch(() => { process.stderr.write("runtime_database_host_probe_failed\\n"); process.exitCode = 1; });
  `;
}

function executeCommand(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 1048576,
    stdio: ["pipe", "pipe", "pipe"],
    ...options,
  }).trim();
}

function failureMarker(error) {
  return /^runtime_database_host_[a-z_]+$/.test(error?.message ?? "")
    ? error.message
    : "runtime_database_host_repair_failed";
}

// Inspect captured subprocess output only in memory. Never attach it as a cause:
// SSH stdout can contain the repaired database URL, even on a failed command.
export function classifyRuntimeHostFailure(error, stage) {
  const marker = failureMarker(error);
  if (marker !== "runtime_database_host_repair_failed") return marker;
  if (
    !new Set([
      "probe_create",
      "probe_inventory",
      "probe_start",
      "probe_verify",
      "secret_read",
      "secret_stage",
    ]).has(stage)
  )
    return marker;
  if (stage === "probe_create") {
    const stderr =
      typeof error?.stderr === "string"
        ? error.stderr
        : Buffer.isBuffer(error?.stderr)
          ? error.stderr.toString("utf8")
          : "";
    if (error?.code === "ETIMEDOUT")
      return "runtime_database_host_probe_create_timeout";
    if (
      /not authorized|unauthorized|permission denied|access denied/i.test(
        stderr,
      )
    )
      return "runtime_database_host_probe_create_access_denied";
    if (
      /invalid machine config|invalid restart provided|unknown flag/i.test(
        stderr,
      )
    )
      return "runtime_database_host_probe_create_config_rejected";
    if (
      /failed to (?:pull|resolve) image|manifest unknown|image not found/i.test(
        stderr,
      )
    )
      return "runtime_database_host_probe_create_image_unavailable";
  }
  return `runtime_database_host_${stage}_failed`;
}

export async function cleanupRuntimeHostProbe({ name, probeId, runFly, wait }) {
  const diagnostics = new Set();
  let seenProbe = Boolean(probeId);
  let absentReads = 0;
  const list = () => {
    try {
      const rows = JSON.parse(
        runFly(["machine", "list", "--app", APP, "--json"]),
      );
      if (!Array.isArray(rows)) throw new Error();
      return rows;
    } catch {
      diagnostics.add("runtime_database_host_cleanup_list_failed");
      return null;
    }
  };
  // Allow delayed create visibility; require two separated absent reads after
  // seeing/removing the probe. Unknown creation is never success evidence.
  for (let attempt = 0; attempt < 25; attempt++) {
    const rows = list();
    const probes = rows?.filter(
      (row) => row?.name === name || (probeId && row?.id === probeId),
    );
    for (const row of probes ?? []) {
      if (
        !/^[a-f0-9]{14}$/.test(row.id) ||
        row.name !== name ||
        row.config?.metadata?.leaderbot_database_host_probe !== name ||
        (probeId && row.id !== probeId)
      ) {
        diagnostics.add("runtime_database_host_cleanup_rejected");
        continue;
      }
      seenProbe = true;
      probeId = row.id;
      try {
        runFly(["machine", "destroy", row.id, "--app", APP, "--force"]);
      } catch {
        diagnostics.add("runtime_database_host_cleanup_destroy_failed");
      }
    }
    absentReads = probes?.length === 0 ? absentReads + 1 : 0;
    if (seenProbe && absentReads >= 2) break;
    if (attempt < 24) await wait(5000);
  }
  // Always make a final observation, even after rejected or failed rows.
  const remaining = list();
  if (
    !seenProbe ||
    absentReads < 2 ||
    !remaining ||
    remaining.some(
      (row) => row?.name === name || (probeId && row?.id === probeId),
    )
  )
    diagnostics.add("runtime_database_host_cleanup_incomplete");
  return [...diagnostics];
}

export async function repairRuntimeDatabaseHost(
  { flyctl = "flyctl", stage = false } = {},
  dependencies = {},
) {
  const execute = dependencies.execute ?? executeCommand;
  const settled = dependencies.checkSettled ?? checkSettledLiveFlyDrift;
  const verifyCi = dependencies.verifyCi ?? verifySourceCi;
  const wait = dependencies.wait ?? delay;
  const rootDir = process.cwd();
  const manifest =
    dependencies.manifest ??
    JSON.parse(fs.readFileSync("deploy/production/apps.json", "utf8"));
  const app = manifest.apps["image-gen"];
  if (
    process.env.GITHUB_ACTIONS !== "true" ||
    process.env.EXCLUSIVE_SECRET_WINDOW !== "true" ||
    process.env.GITHUB_WORKFLOW_REF !==
      `${REPOSITORY}/.github/workflows/repair-image-gen-runtime-database-host.yml@refs/heads/main` ||
    app.app !== APP ||
    app.databaseRecovery.app !== "leaderbot-portal-mysql" ||
    app.databaseRecovery.databaseName !== "leaderbot" ||
    app.databaseSchemaTransition.state !== "runtime_reviewed" ||
    app.databaseSchemaPhase !== "0018_credit_checkout_reservation" ||
    app.reviewedArtifactKind !== "runtime" ||
    app.reviewedSettledPredecessor.image !==
      app.databaseSchemaTransition.bridgeImage
  )
    throw new Error("runtime_database_host_transition_rejected");
  const source = execute("git", ["rev-parse", "HEAD"]);
  const main = execute("gh", [
    "api",
    `repos/${REPOSITORY}/git/ref/heads/main`,
    "--jq",
    ".object.sha",
  ]);
  if (
    source !== main ||
    source !== process.env.GITHUB_SHA ||
    execute("git", ["status", "--porcelain"]) !== ""
  )
    throw new Error("runtime_database_host_source_rejected");
  const token = execute("gh", ["auth", "token"]);
  await verifyCi(source, { repository: REPOSITORY, token });
  if (!/^flyctl v0\.4\.85(?:\s|$)/.test(execute(flyctl, ["version"])))
    throw new Error("runtime_database_host_flyctl_rejected");
  const runFly = (args, options = {}) =>
    execute(flyctl, args, {
      ...options,
      env: {
        ...process.env,
        FLY_API_TOKEN: args.includes("leaderbot-portal-mysql")
          ? process.env.FLY_DATABASE_MIGRATION_TOKEN
          : process.env.FLY_API_TOKEN,
      },
    });
  const options = { rootDir, repository: REPOSITORY, token, runFly };
  const before = await settled("image-gen", options);
  if (
    before.blockingErrors.length ||
    before.reconcilableDrift.length ||
    before.identity !== app.reviewedSettledPredecessor.identity ||
    before.expectedImage !== app.reviewedSettledPredecessor.image
  )
    throw new Error("runtime_database_host_baseline_rejected");
  const secrets = JSON.parse(
    runFly(["secrets", "list", "--app", APP, "--json"]),
  );
  const secret = secrets.filter((row) => row.name === "DATABASE_URL");
  if (secret.length !== 1 || secret[0].status !== "Staged")
    throw new Error("runtime_database_host_stage_rejected");
  const databaseMachines = JSON.parse(
    runFly(["machine", "list", "--app", app.databaseRecovery.app, "--json"]),
  );
  const databases = databaseMachines.filter((row) => row.state === "started");
  if (
    databases.length !== 1 ||
    !databases[0].config.mounts?.some(
      (mount) =>
        mount.volume === app.databaseRecovery.volumeId &&
        mount.path === "/var/lib/mysql",
    )
  )
    throw new Error("runtime_database_host_binding_rejected");
  const db = databases[0];
  const binding = {
    machineId: db.id,
    privateIp: db.private_ip,
    app: app.databaseRecovery.app,
    database: app.databaseRecovery.databaseName,
    principalSha256: app.databaseSchemaTransition.runtimePrincipalSha256,
  };
  execute(
    "gh",
    [
      "attestation",
      "verify",
      `oci://${app.reviewedImage}`,
      "--repo",
      REPOSITORY,
      "--signer-workflow",
      `${REPOSITORY}/.github/workflows/build-production-artifacts.yml`,
      "--source-digest",
      app.reviewedSourceCommit,
      "--source-ref",
      "refs/heads/main",
      "--deny-self-hosted-runners",
    ],
    { timeout: 120000 },
  );
  const name = `dbhost-${randomBytes(6).toString("hex")}`;
  let probeId;
  let result;
  let primaryFailure;
  let failureStage = "probe_create";
  try {
    // No app entrypoint, ports, volumes, workers or provider transport. The
    // deadline plus auto-destroy also bounds cleanup after operator interruption.
    runFly([
      "machine",
      "run",
      app.reviewedImage,
      "600",
      "--app",
      APP,
      "--name",
      name,
      "--region",
      app.databaseRecovery.region,
      "--entrypoint",
      "/bin/sleep",
      "--rm",
      "--detach",
      "--restart",
      "no",
      "--machine-config",
      JSON.stringify({ services: [], mounts: [], env: {} }),
      "--skip-dns-registration",
      "--vm-memory",
      "256",
      "--vm-cpus",
      "1",
      "--metadata",
      `leaderbot_database_host_probe=${name}`,
    ]);
    failureStage = "probe_inventory";
    const machines = JSON.parse(
      runFly(["machine", "list", "--app", APP, "--json"]),
    );
    const probes = machines.filter(
      (row) =>
        row.name === name &&
        row.config.metadata?.leaderbot_database_host_probe === name,
    );
    if (probes.length !== 1 || !/^[a-f0-9]{14}$/.test(probes[0].id))
      throw new Error("runtime_database_host_probe_binding_rejected");
    probeId = probes[0].id;
    if (
      probes[0].config.image !== app.reviewedImage ||
      probes[0].config.services?.length ||
      probes[0].config.mounts?.length ||
      JSON.stringify(probes[0].config.init?.entrypoint) !== '["/bin/sleep"]' ||
      JSON.stringify(probes[0].config.init?.cmd) !== '["600"]'
    )
      throw new Error("runtime_database_host_probe_config_rejected");
    failureStage = "probe_start";
    runFly([
      "machine",
      "wait",
      probeId,
      "--app",
      APP,
      "--state",
      "started",
      "--wait-timeout",
      "45s",
    ]);
    const command = `node -e '${buildRuntimeHostProbe(binding).replaceAll("'", "'\\''")}'`;
    failureStage = "probe_verify";
    const repaired = runFly(
      [
        "ssh",
        "console",
        "--app",
        APP,
        "--machine",
        probeId,
        "--quiet",
        "--command",
        command,
      ],
      { timeout: 150000 },
    );
    normalizeRuntimeDatabaseUrl(repaired, binding);
    // Detect changes observed before staging. Fly's update API has no CAS:
    // the required operator-exclusive window, not this read, excludes direct
    // external writers between comparison and import. Repository workflows
    // share the production-deploy-image-gen concurrency group.
    failureStage = "secret_read";
    const current = JSON.parse(
      runFly(["secrets", "list", "--app", APP, "--json"]),
    ).filter((row) => row.name === "DATABASE_URL");
    if (
      current.length !== 1 ||
      current[0].status !== "Staged" ||
      current[0].digest !== secret[0].digest
    )
      throw new Error("runtime_database_host_secret_changed");
    failureStage = "secret_stage";
    if (stage)
      runFly(["secrets", "import", "--app", APP, "--stage"], {
        input: `DATABASE_URL=${repaired}\n`,
      });
    result = {
      sourceCommit: source,
      databaseMachineId: db.id,
      principalSha256: binding.principalSha256,
      schemaProbePassed: true,
      triggerProbePassed: true,
      staged: stage,
      exclusiveSecretWindowConfirmed: true,
    };
  } catch (error) {
    primaryFailure = classifyRuntimeHostFailure(error, failureStage);
  }
  const cleanupDiagnostics = await cleanupRuntimeHostProbe({
    name,
    probeId,
    runFly,
    wait,
  });
  if (primaryFailure || cleanupDiagnostics.length) {
    // Keep the primary category and attach only fixed cleanup markers. Raw
    // child-process errors may contain captured credential stdout; never retain
    // those as a public Error cause or diagnostic property.
    throw Object.assign(new Error(primaryFailure ?? cleanupDiagnostics[0]), {
      cleanupDiagnostics,
    });
  }
  const after = await settled("image-gen", options);
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error("runtime_database_host_baseline_changed");
  return { ...result, probeRemoved: true, baselineUnchanged: true };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--stage")) {
    process.stderr.write("runtime_database_host_arguments_rejected\n");
    process.exitCode = 1;
  } else {
    repairRuntimeDatabaseHost({
      flyctl: process.env.LEADERBOT_FLYCTL_BIN || "flyctl",
      stage: args.includes("--stage"),
    })
      .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
      .catch((error) => {
        process.stderr.write(`${failureMarker(error)}\n`);
        for (const marker of error.cleanupDiagnostics ?? []) {
          process.stderr.write(`${failureMarker({ message: marker })}\n`);
        }
        process.exitCode = 1;
      });
  }
}
