import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_PATH = "deploy/production/apps.json";
const PRODUCTION_WORKFLOW_PATH = ".github/workflows/deploy-production.yml";
const TRUSTED_ARTIFACT_WORKFLOW_PATH =
  ".github/workflows/build-production-artifacts.yml";
const SCHEMA_TRANSITION_WORKFLOW_PATH =
  ".github/workflows/image-gen-schema-transition.yml";
const SCHEMA_PROBE_CLEANUP_WORKFLOW_PATH =
  ".github/workflows/cleanup-image-gen-schema-probes.yml";
const GATEWAY_STATE_REBASELINE_WORKFLOW_PATH =
  ".github/workflows/gateway-state-rebaseline.yml";
const PRODUCTION_RECONCILIATION_WORKFLOW_PATH =
  ".github/workflows/reconcile-production-deployment.yml";
const PRODUCTION_COMPLETION_RECOVERY_WORKFLOW_PATH =
  ".github/workflows/recover-completed-production-deployment.yml";
const FRESH_SNAPSHOT_SELECTOR_PATH = "scripts/select-fresh-fly-snapshot.mjs";
const PINNED_NODE_BASE_IMAGE =
  "node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43";
const PINNED_GATEWAY_NODE_BASE_IMAGE =
  "node:24-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df";
const PINNED_FFMPEG_VERSION = "8.1.2-r0";
const PINNED_MYSQL_IMAGE =
  "mysql:8.4.11@sha256:1d6b6a8fcee8ff758ff151d017f5203cd06792a0e698f0a593c9dfcb14609cf0";
const PINNED_REDIS_IMAGE =
  "redis:7-alpine@sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf";
const PINNED_FLYCTL_VERSION = "0.4.85";
const PINNED_FLYCTL_ASSET_URL =
  "https://github.com/superfly/flyctl/releases/download/v0.4.85/flyctl_0.4.85_Linux_x86_64.tar.gz";
const PINNED_FLYCTL_ASSET_SHA256 =
  "c3b5ed05319adf8a265d68171758ea7b37bd340c5c3dc4e09e17fb6344b8ff90";
const FORBIDDEN_FLY_API_HOSTNAME = "api.fly.io";
const VERIFIED_FLYCTL_WORKFLOW_JOBS = Object.freeze({
  [TRUSTED_ARTIFACT_WORKFLOW_PATH]: ["build"],
  [SCHEMA_PROBE_CLEANUP_WORKFLOW_PATH]: ["cleanup"],
  [GATEWAY_STATE_REBASELINE_WORKFLOW_PATH]: ["rehearse"],
  [PRODUCTION_WORKFLOW_PATH]: [
    "validate",
    "deploy-gateway",
    "deploy-image-gen",
    "deploy-storage-proxy",
  ],
  [SCHEMA_TRANSITION_WORKFLOW_PATH]: ["preflight", "expand"],
  [PRODUCTION_RECONCILIATION_WORKFLOW_PATH]: [
    "recover-gateway",
    "recover-image-gen",
    "recover-storage-proxy",
  ],
});
const FLY_RELEASE_COMMAND_PROCESS_GROUP = "fly_app_release_command";
const RECOVERY_PROTOCOL_V1 = "v1";
const REQUIRED_ARTIFACT_CI_WORKFLOWS = Object.freeze([
  "main.yml",
  "image-gen-ci.yml",
  "image-gen-migration-smoke.yml",
]);
const ROOT_VALIDATION_WORKFLOW_PATH = ".github/workflows/main.yml";
const PRODUCTION_SCHEMA_PHASES = Object.freeze([
  "0015_base",
  "0016_expand",
  "0017_contract",
]);
const REVIEWED_ARTIFACT_KINDS = Object.freeze([
  "legacy-bootstrap",
  "migration-bridge",
  "runtime",
]);
const GATEWAY_REBASELINE_STATES = Object.freeze([
  "awaiting_rehearsal",
  "rehearsal_approved",
  "rehearsed",
  "settled",
]);
const GATEWAY_ARTIFACT_PREDICATE_TYPE =
  "https://leaderbot.live/attestations/gateway-runtime/v1";
const IMAGE_GEN_TRANSITION_STATES = Object.freeze([
  "awaiting_attested_bridge",
  "bridge_reviewed",
  "expand_pending",
  "runtime_build_pending",
  "runtime_reviewed",
  "complete",
]);
const CANONICAL_TARGETS = {
  gateway: {
    app: "leaderbot-openclaw-gateway",
    config: "fly.toml",
    deployScript: "deploy:gateway",
    reviewedImageEnv: "FLY_GATEWAY_REVIEWED_IMAGE",
  },
  "image-gen": {
    app: "leaderbot-fb-image-gen",
    config: "apps/image-gen/fly.toml",
    deployScript: "deploy:image-gen",
    reviewedImageEnv: "FLY_IMAGE_GEN_REVIEWED_IMAGE",
  },
  "storage-proxy": {
    app: "leaderbot-storage-proxy",
    config: "apps/image-gen/storage-proxy/fly.toml",
    deployScript: "deploy:storage-proxy",
    reviewedImageEnv: "FLY_STORAGE_PROXY_REVIEWED_IMAGE",
  },
};

function fail(message) {
  throw new Error(message);
}

export function referencesForbiddenFlyApiUrl(source) {
  for (const match of source.matchAll(/https?:\/\/[^\s"'`<>()[\]{}]+/giu)) {
    let parsed;
    try {
      parsed = new URL(match[0]);
    } catch {
      continue;
    }
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/u, "");
    if (
      (parsed.protocol === "https:" || parsed.protocol === "http:") &&
      hostname === FORBIDDEN_FLY_API_HOSTNAME
    ) {
      return true;
    }
  }
  return false;
}

function referencesExactHttpUrl(source, expected) {
  const expectedUrl = new URL(expected);
  for (const match of source.matchAll(/https?:\/\/[^\s"'`<>()[\]{}]+/giu)) {
    let parsed;
    try {
      parsed = new URL(match[0]);
    } catch {
      continue;
    }
    if (
      parsed.protocol === expectedUrl.protocol &&
      parsed.username === expectedUrl.username &&
      parsed.password === expectedUrl.password &&
      parsed.hostname === expectedUrl.hostname &&
      parsed.port === expectedUrl.port &&
      parsed.pathname === expectedUrl.pathname &&
      parsed.search === expectedUrl.search &&
      parsed.hash === expectedUrl.hash
    ) {
      return true;
    }
  }
  return false;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readTomlTables(text) {
  const tables = new Map([["", []]]);
  let current = "";
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/);
    if (heading) {
      current = heading[1];
      if (!tables.has(current)) {
        tables.set(current, []);
      }
      continue;
    }
    tables.get(current)?.push(line);
  }
  return tables;
}

function unquoteToml(value) {
  const trimmed = value.replace(/\s+#.*$/, "").trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

function tableAssignments(tables, tableName) {
  const result = {};
  for (const line of tables.get(tableName) ?? []) {
    const assignment = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/);
    if (assignment) {
      result[assignment[1]] = unquoteToml(assignment[2]);
    }
  }
  return result;
}

function tableAssignmentGroups(text, tableName) {
  const groups = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/);
    if (heading) {
      current = heading[1] === tableName ? {} : null;
      if (current) groups.push(current);
      continue;
    }
    if (!current) continue;
    const assignment = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/);
    if (assignment) {
      current[assignment[1]] = unquoteToml(assignment[2]);
    }
  }
  return groups;
}

function allAssignments(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...text.matchAll(new RegExp(`^\\s*${escaped}\\s*=\\s*(.+?)\\s*$`, "gm")),
  ].map((match) => unquoteToml(match[1]));
}

function parseStringArray(value) {
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  return [...trimmed.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]);
}

function normalizeUrl(value) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function occurrenceCount(source, needle) {
  return source.split(needle).length - 1;
}

function yamlRunBlocks(workflow) {
  const lines = workflow.split(/\r?\n/);
  const blocks = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(\s*)run:\s*(.*?)\s*$/);
    if (!match) continue;
    const indent = match[1].length;
    const scalar = match[2];
    if (
      scalar !== "|" &&
      scalar !== ">" &&
      scalar !== "|-" &&
      scalar !== ">-"
    ) {
      blocks.push(scalar);
      continue;
    }
    const body = [];
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (
        line.trim() !== "" &&
        (line.match(/^\s*/) ?? [""])[0].length <= indent
      ) {
        index -= 1;
        break;
      }
      body.push(line);
    }
    blocks.push(body.join("\n"));
  }
  return blocks;
}

function assertNoDirectGithubExpressionsInRunBlocks(workflow, workflowPath) {
  if (yamlRunBlocks(workflow).some((block) => block.includes("${{"))) {
    fail(
      `${workflowPath} must pass GitHub expressions through step env instead of interpolating them directly in run blocks`,
    );
  }
}

function namedWorkflowStepBodies(workflow, stepName) {
  const escaped = stepName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [];
  const pattern = new RegExp(
    `^ {6}- name: ${escaped}\\s*$([\\s\\S]*?)(?=^ {6}- name: |^ {2}[^ \\n][^\\n]*:|(?![\\s\\S]))`,
    "gm",
  );
  for (const match of workflow.matchAll(pattern)) matches.push(match[0]);
  return matches;
}

function namedWorkflowStepTimeout(workflow, stepName) {
  const bodies = namedWorkflowStepBodies(workflow, stepName);
  if (bodies.length !== 1) return null;
  const match = bodies[0].match(/^ {8}timeout-minutes:\s*([0-9]+)\s*$/m);
  return match ? Number(match[1]) : null;
}

function namedWorkflowJobBody(workflow, jobName) {
  const escaped = jobName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `^  ${escaped}:\\s*$([\\s\\S]*?)(?=^  [A-Za-z0-9_-]+:\\s*$|(?![\\s\\S]))`,
    "m",
  );
  return workflow.match(pattern)?.[0] ?? null;
}

function workflowJobNames(workflow) {
  const jobsIndex = workflow.search(/^jobs:\s*$/m);
  if (jobsIndex < 0) return [];
  return [
    ...workflow.slice(jobsIndex).matchAll(/^  ([A-Za-z0-9_-]+):\s*$/gm),
  ].map((match) => match[1]);
}

function verifiedFlyctlInstallerSteps(workflow) {
  return [
    ...namedWorkflowStepBodies(workflow, "Install exact verified flyctl"),
    ...namedWorkflowStepBodies(
      workflow,
      "Install exact verified flyctl for metadata-only preflight",
    ),
  ];
}

function assertExactVerifiedFlyctlInstaller(step, workflowPath, jobName) {
  const requirementMessage = `${workflowPath} ${jobName} must download the exact Linux x86_64 flyctl asset and verify its reviewed SHA256 before extraction or PATH exposure`;
  for (const needle of [
    "timeout-minutes: 3",
    "shell: bash",
    "set -euo pipefail",
    'test "$RUNNER_OS" = "Linux"',
    'test "$RUNNER_ARCH" = "X64"',
    'install_root="$(mktemp -d "$RUNNER_TEMP/leaderbot-flyctl.XXXXXX")"',
    'archive="$install_root/flyctl_0.4.85_Linux_x86_64.tar.gz"',
    'install -d -m 0700 "$extract_dir" "$bin_dir"',
    "curl --fail --show-error --silent --location",
    "--proto '=https' --proto-redir '=https' --tlsv1.2",
    "--retry 3 --retry-all-errors",
    `"${PINNED_FLYCTL_ASSET_URL}"`,
    `"${PINNED_FLYCTL_ASSET_SHA256}"`,
    '"$archive" | sha256sum --check --strict',
    'tar --extract --gzip --file "$archive" --directory "$extract_dir" flyctl',
    'test -f "$extract_dir/flyctl"',
    'test ! -L "$extract_dir/flyctl"',
    'install -m 0755 "$extract_dir/flyctl" "$bin_dir/flyctl"',
    'ln -s flyctl "$bin_dir/fly"',
    'version_output="$("$bin_dir/flyctl" version)"',
    '[[ "$version_output" =~ ^flyctl\\ v0\\.4\\.85([[:space:]]|$) ]]',
    'printf \'%s\\n\' "$bin_dir" >> "$GITHUB_PATH"',
  ]) {
    if (!step.includes(needle)) fail(requirementMessage);
  }
  if (
    step.includes("uses:") ||
    step.includes("setup-flyctl") ||
    referencesForbiddenFlyApiUrl(step) ||
    step.includes("--insecure") ||
    occurrenceCount(step, PINNED_FLYCTL_ASSET_URL) !== 1 ||
    occurrenceCount(step, PINNED_FLYCTL_ASSET_SHA256) !== 1 ||
    occurrenceCount(step, "curl ") !== 1 ||
    occurrenceCount(step, "sha256sum --check --strict") !== 1 ||
    occurrenceCount(step, "tar --extract") !== 1 ||
    occurrenceCount(step, '>> "$GITHUB_PATH"') !== 1
  ) {
    fail(requirementMessage);
  }
  const downloadIndex = step.indexOf(PINNED_FLYCTL_ASSET_URL);
  const digestIndex = step.indexOf(PINNED_FLYCTL_ASSET_SHA256);
  const verifyIndex = step.indexOf("sha256sum --check --strict");
  const extractIndex = step.indexOf("tar --extract");
  const installIndex = step.indexOf(
    'install -m 0755 "$extract_dir/flyctl" "$bin_dir/flyctl"',
  );
  const versionIndex = step.indexOf(
    'version_output="$("$bin_dir/flyctl" version)"',
  );
  const pathIndex = step.indexOf('>> "$GITHUB_PATH"');
  if (
    downloadIndex < 0 ||
    digestIndex <= downloadIndex ||
    verifyIndex <= digestIndex ||
    extractIndex <= verifyIndex ||
    installIndex <= extractIndex ||
    versionIndex <= installIndex ||
    pathIndex <= versionIndex
  ) {
    fail(requirementMessage);
  }
}

function validateVerifiedFlyctlSupplyChain(rootDir) {
  const workflowDir = path.join(rootDir, ".github/workflows");
  const workflowFiles = fs
    .readdirSync(workflowDir)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .sort();
  const allWorkflowSources = new Map(
    workflowFiles.map((file) => {
      const workflowPath = `.github/workflows/${file}`;
      return [
        workflowPath,
        fs.readFileSync(path.join(rootDir, workflowPath), "utf8"),
      ];
    }),
  );
  const tokenWorkflowPaths = [...allWorkflowSources]
    .filter(([, workflow]) => workflow.includes("FLY_API_TOKEN"))
    .map(([workflowPath]) => workflowPath)
    .sort();
  const expectedWorkflowPaths = Object.keys(
    VERIFIED_FLYCTL_WORKFLOW_JOBS,
  ).sort();
  for (const workflowPath of expectedWorkflowPaths) {
    if (!allWorkflowSources.has(workflowPath)) fail(`Missing ${workflowPath}`);
  }
  if (
    JSON.stringify(tokenWorkflowPaths) !== JSON.stringify(expectedWorkflowPaths)
  ) {
    fail(
      "Every workflow that can expose a Fly API token must use the reviewed verified-flyctl contract",
    );
  }
  for (const [workflowPath, workflow] of allWorkflowSources) {
    if (
      workflow.includes("setup-flyctl") ||
      referencesForbiddenFlyApiUrl(workflow)
    ) {
      fail(
        `${workflowPath} must never use an unverified remote flyctl installer`,
      );
    }
  }
  for (const [workflowPath, expectedJobs] of Object.entries(
    VERIFIED_FLYCTL_WORKFLOW_JOBS,
  )) {
    const workflow = allWorkflowSources.get(workflowPath);
    if (!workflow) fail(`Missing ${workflowPath}`);
    if (
      occurrenceCount(workflow, `FLYCTL_VERSION: ${PINNED_FLYCTL_VERSION}`) !==
      1
    ) {
      fail(`${workflowPath} must pin the reviewed flyctl version`);
    }
    const tokenJobs = workflowJobNames(workflow).filter((jobName) =>
      namedWorkflowJobBody(workflow, jobName)?.includes("FLY_API_TOKEN"),
    );
    if (JSON.stringify(tokenJobs) !== JSON.stringify(expectedJobs)) {
      fail(
        `${workflowPath} every Fly-token job must install only the exact verified flyctl binary`,
      );
    }
    const workflowInstallers = verifiedFlyctlInstallerSteps(workflow);
    if (workflowInstallers.length !== expectedJobs.length) {
      fail(
        `${workflowPath} must install verified flyctl exactly once in every Fly-token job`,
      );
    }
    for (const jobName of expectedJobs) {
      const job = namedWorkflowJobBody(workflow, jobName);
      const installers = verifiedFlyctlInstallerSteps(job ?? "");
      if (
        !job ||
        !job.includes("runs-on: ubuntu-latest") ||
        installers.length !== 1
      ) {
        fail(
          `${workflowPath} ${jobName} must install verified flyctl exactly once on GitHub Ubuntu x86_64`,
        );
      }
      const installer = installers[0];
      assertExactVerifiedFlyctlInstaller(installer, workflowPath, jobName);
      const installerIndex = job.indexOf(installer);
      const firstTokenIndex = job.indexOf("FLY_API_TOKEN");
      const jobWithoutInstaller = job.replace(installer, "");
      if (
        installerIndex < 0 ||
        installer.includes("FLY_API_TOKEN") ||
        firstTokenIndex < installerIndex + installer.length ||
        /\bflyctl\b/.test(job.slice(0, installerIndex)) ||
        jobWithoutInstaller.includes("GITHUB_PATH") ||
        /^\s+PATH:\s/m.test(jobWithoutInstaller) ||
        jobWithoutInstaller.includes("command -v flyctl")
      ) {
        fail(
          `${workflowPath} ${jobName} must expose Fly tokens only after the exact verified flyctl path is installed`,
        );
      }
    }
  }
}

function assertPinnedNodeDockerfile(dockerfile, dockerfilePath, options = {}) {
  const firstFrom = dockerfile.search(/^FROM\s+/m);
  const nodeArg = `ARG NODE_BASE_IMAGE=${PINNED_NODE_BASE_IMAGE}`;
  const nodeArgIndex = dockerfile.indexOf(nodeArg);
  if (
    firstFrom < 0 ||
    nodeArgIndex < 0 ||
    nodeArgIndex > firstFrom ||
    occurrenceCount(dockerfile, nodeArg) !== 1 ||
    occurrenceCount(dockerfile, "ARG NODE_BASE_IMAGE=") !== 1 ||
    occurrenceCount(dockerfile, "FROM ${NODE_BASE_IMAGE}") !== 2 ||
    !dockerfile.includes('io.leaderbot.base.node="${NODE_BASE_IMAGE}"') ||
    /^FROM\s+node:/m.test(dockerfile)
  ) {
    fail(
      `${dockerfilePath} must use the exact globally pinned Node base digest and preserve it in the runtime label`,
    );
  }
  if (options.ffmpeg === true) {
    if (
      occurrenceCount(
        dockerfile,
        `ARG FFMPEG_VERSION=${PINNED_FFMPEG_VERSION}`,
      ) !== 1 ||
      (dockerfile.match(/^ARG FFMPEG_VERSION=/gm) ?? []).length !== 1
    ) {
      fail(
        `${dockerfilePath} must pin ffmpeg exactly and preserve its version in the runtime label`,
      );
    }
    for (const required of [
      `ARG FFMPEG_VERSION=${PINNED_FFMPEG_VERSION}`,
      'io.leaderbot.runtime.ffmpeg="${FFMPEG_VERSION}"',
      'apk add --no-cache "ffmpeg=${FFMPEG_VERSION}"',
    ]) {
      if (!dockerfile.includes(required)) {
        fail(
          `${dockerfilePath} must pin ffmpeg exactly and preserve its version in the runtime label`,
        );
      }
    }
  }
}

function assertPinnedGatewayDockerfile(rootDir) {
  const dockerfilePath = "deploy/fly-gateway/Dockerfile";
  const dockerfile = fs.readFileSync(path.join(rootDir, dockerfilePath), "utf8");
  const nodeArg = `ARG NODE_BASE_IMAGE=${PINNED_GATEWAY_NODE_BASE_IMAGE}`;
  const firstFrom = dockerfile.search(/^FROM\s+/m);
  if (
    firstFrom < 0 ||
    dockerfile.indexOf(nodeArg) < 0 ||
    dockerfile.indexOf(nodeArg) > firstFrom ||
    occurrenceCount(dockerfile, nodeArg) !== 1 ||
    occurrenceCount(dockerfile, "FROM ${NODE_BASE_IMAGE}") !== 2 ||
    /^FROM\s+node:/m.test(dockerfile)
  ) {
    fail(
      `${dockerfilePath} must use the exact pinned gateway Node base digest for both stages`,
    );
  }
  for (const required of [
    'org.opencontainers.image.revision="${SOURCE_REVISION}"',
    'io.leaderbot.artifact.kind="gateway-runtime"',
    'io.leaderbot.base.node="${NODE_BASE_IMAGE}"',
    'io.leaderbot.gateway.state-rehearsal="real-openclaw-v1"',
    "npm ci --ignore-scripts",
    "npm ci --omit=dev --include=optional --no-audit --no-fund",
    "deploy/fly-gateway/runtime/package-lock.json",
    "snapshot.debian.org/archive/debian/20260824T000000Z",
    "snapshot.debian.org/archive/debian-security/20260824T000000Z",
    "Acquire::Check-Valid-Until",
    "tar -xzf /tmp/openclaw-facebook.tgz",
    "'gateway-runtime' > /app/.leaderbot-artifact-kind",
  ]) {
    if (!dockerfile.includes(required)) {
      fail(`${dockerfilePath} must preserve its exact locked runtime contract`);
    }
  }
  if (/\bnpm install\b/.test(dockerfile)) {
    fail(`${dockerfilePath} must never resolve mutable npm dependencies`);
  }
  const runtimePackage = readJson(
    path.join(rootDir, "deploy/fly-gateway/runtime/package.json"),
  );
  const runtimeLock = readJson(
    path.join(rootDir, "deploy/fly-gateway/runtime/package-lock.json"),
  );
  const exactDependencies = {
    "@openclaw/codex": "2026.7.2-beta.7",
    ioredis: "6.0.0",
    openclaw: "2026.7.2-beta.7",
    zod: "4.4.3",
  };
  if (
    JSON.stringify(runtimePackage.dependencies) !==
      JSON.stringify(exactDependencies) ||
    JSON.stringify(runtimeLock.packages?.[""]?.dependencies) !==
      JSON.stringify(exactDependencies) ||
    runtimeLock.lockfileVersion !== 3 ||
    runtimeLock.packages?.["node_modules/openclaw"]?.version !==
      "2026.7.2-beta.7" ||
    runtimeLock.packages?.["node_modules/@openclaw/codex"]?.version !==
      "2026.7.2-beta.7"
  ) {
    fail("Gateway runtime dependencies must remain exactly lockfile-bound");
  }
}

export function loadProductionManifest(rootDir = process.cwd()) {
  const manifest = readJson(path.join(rootDir, MANIFEST_PATH));
  if (manifest.schemaVersion !== 1) {
    fail("Unsupported production deployment manifest schema");
  }
  return manifest;
}

export function validateRecoveryProtocol(content) {
  if (content !== `${RECOVERY_PROTOCOL_V1}\n`) {
    fail(
      `Unsupported production recovery protocol; expected ${RECOVERY_PROTOCOL_V1}`,
    );
  }
  return RECOVERY_PROTOCOL_V1;
}

export function getReviewedScalePlan(target, rootDir = process.cwd()) {
  const app = loadProductionManifest(rootDir).apps[target];
  const canonical = CANONICAL_TARGETS[target];
  if (
    !app ||
    !canonical ||
    app.app !== canonical.app ||
    app.config !== canonical.config ||
    !app.desiredScale ||
    typeof app.desiredScale !== "object" ||
    Array.isArray(app.desiredScale)
  ) {
    fail("Recovery scale plan is not bound to a canonical production target");
  }
  const profile = readMachineConfigProfile(rootDir, app.config, app);
  const processGroups = Object.keys(profile.processes).sort();
  if (
    processGroups.length === 0 ||
    JSON.stringify(processGroups) !==
      JSON.stringify(Object.keys(app.desiredScale).sort())
  ) {
    fail("Recovery scale plan must cover exactly the reviewed process groups");
  }
  return processGroups.map((process) => {
    const desired = app.desiredScale[process];
    if (
      !/^[a-z][a-z0-9-]{0,31}$/.test(process) ||
      !desired ||
      typeof desired !== "object" ||
      Array.isArray(desired) ||
      JSON.stringify(Object.keys(desired).sort()) !==
        JSON.stringify(["count", "cpuKind", "cpus", "memoryMb"].sort()) ||
      !Number.isSafeInteger(desired.count) ||
      desired.count < 1 ||
      desired.count > 20 ||
      !new Set(["shared", "performance"]).has(desired.cpuKind) ||
      !Number.isSafeInteger(desired.cpus) ||
      desired.cpus < 1 ||
      desired.cpus > 32 ||
      !Number.isSafeInteger(desired.memoryMb) ||
      desired.memoryMb < 256 ||
      desired.memoryMb > 131_072
    ) {
      fail(`Recovery scale plan for ${process} is not an exact bounded policy`);
    }
    return { process, count: desired.count };
  });
}

function isImmutableAppImage(app, image) {
  const prefix = `registry.fly.io/${app.app}@sha256:`;
  return (
    typeof image === "string" &&
    image.startsWith(prefix) &&
    /^[a-f0-9]{64}$/.test(image.slice(prefix.length))
  );
}

function reviewedProductionImages(app) {
  return new Set(
    [app.reviewedImage, ...(app.reviewedRollbackImages ?? [])].filter(Boolean),
  );
}

function isReviewedSourceCommit(value) {
  return typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
}

function hasExactObjectKeys(value, expectedKeys) {
  return (
    value != null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...expectedKeys].sort())
  );
}

function isExactSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isGatewayBaselineImage(app, image) {
  const prefix = `registry.fly.io/${app.app}:`;
  return (
    typeof image === "string" &&
    image.startsWith(prefix) &&
    /^[a-z0-9][a-z0-9._-]{0,127}@sha256:[a-f0-9]{64}$/.test(
      image.slice(prefix.length),
    )
  );
}

function validateUnreviewedGatewayTransition(record, name) {
  if (
    !hasExactObjectKeys(record, [
      "state",
      "identity",
      "image",
      "sourceCommit",
      "configSha256",
    ]) ||
    record.state !== "unreviewed" ||
    record.identity !== null ||
    record.image !== null ||
    record.sourceCommit !== null ||
    record.configSha256 !== null
  ) {
    fail(`gateway ${name} must remain explicitly unreviewed`);
  }
}

function validateReviewedGatewayTransition(record, name, app) {
  if (
    !hasExactObjectKeys(record, [
      "state",
      "identity",
      "image",
      "sourceCommit",
      "configSha256",
    ]) ||
    record.state !== "reviewed" ||
    !/^deploy-[1-9][0-9]*-[1-9][0-9]*$/.test(record.identity ?? "") ||
    !isImmutableAppImage(app, record.image) ||
    !isReviewedSourceCommit(record.sourceCommit) ||
    !isExactSha256(record.configSha256)
  ) {
    fail(`gateway ${name} lacks an exact reviewed identity and provenance`);
  }
}

function validateGatewayRebaselineBaseline(app, contract) {
  const baseline = contract.baseline;
  if (
    !hasExactObjectKeys(baseline, [
      "app",
      "machineId",
      "deploymentIdentity",
      "image",
      "volumeId",
      "mountPath",
      "region",
      "encrypted",
      "configIdentity",
    ]) ||
    baseline.app !== app.app ||
    !/^[a-f0-9]{14}$/.test(baseline.machineId ?? "") ||
    (baseline.deploymentIdentity !== "legacy_unlabeled" &&
      !/^deploy-[1-9][0-9]*-[1-9][0-9]*$/.test(
        baseline.deploymentIdentity ?? "",
      )) ||
    !isGatewayBaselineImage(app, baseline.image) ||
    !/^vol_[a-z0-9]{12,32}$/.test(baseline.volumeId ?? "") ||
    baseline.mountPath !== "/data" ||
    baseline.region !== "ams" ||
    baseline.encrypted !== true
  ) {
    fail(
      "gateway rebaseline must bind the exact live Machine and encrypted volume tuple",
    );
  }

  const configIdentity = baseline.configIdentity;
  if (
    !hasExactObjectKeys(configIdentity, [
      "machineConfigSha256",
      "flyConfigSha256",
      "generatedConfigSha256",
    ])
  ) {
    fail("gateway rebaseline must define the complete configuration identity");
  }
  const configHashes = Object.values(configIdentity);
  if (contract.state === "awaiting_rehearsal") {
    if (configHashes.some((value) => value !== null)) {
      fail(
        "gateway awaiting-rehearsal configuration hashes must remain unresolved together",
      );
    }
  } else if (!configHashes.every(isExactSha256)) {
    fail(
      "gateway rebaseline needs all exact configuration hashes before rehearsal can pass",
    );
  }
  return baseline;
}

function validateGatewayRebaselineArtifact(app, contract) {
  const artifact = contract.reviewedArtifact;
  const exactArtifactKeys = [
    "state",
    "image",
    "sourceCommit",
    "builderWorkflow",
    "predicateType",
    "attestationBundleSha256",
  ];
  if (!hasExactObjectKeys(artifact, exactArtifactKeys)) {
    fail("gateway rebaseline must define the complete artifact provenance");
  }
  if (contract.state === "awaiting_rehearsal") {
    if (
      artifact.state !== "unreviewed" ||
      exactArtifactKeys
        .filter((key) => key !== "state")
        .some((key) => artifact[key] !== null)
    ) {
      fail(
        "gateway artifact must remain explicitly unreviewed before rehearsal",
      );
    }
  } else if (
    artifact.state !== "reviewed" ||
    !isImmutableAppImage(app, artifact.image) ||
    !isReviewedSourceCommit(artifact.sourceCommit) ||
    artifact.builderWorkflow !== TRUSTED_ARTIFACT_WORKFLOW_PATH ||
    artifact.predicateType !== GATEWAY_ARTIFACT_PREDICATE_TYPE ||
    !isExactSha256(artifact.attestationBundleSha256)
  ) {
    fail("gateway reviewed artifact lacks exact trusted provenance");
  }
  return artifact;
}

function validateGatewayRehearsal(contract, baseline) {
  const rehearsal = contract.rehearsal;
  if (
    !hasExactObjectKeys(rehearsal, [
      "state",
      "evidenceArtifact",
      "evidenceSha256",
      "sourceVolumeId",
      "mountPath",
      "region",
      "encrypted",
      "contentInspectionAllowed",
      "checks",
    ]) ||
    rehearsal.mountPath !== baseline.mountPath ||
    rehearsal.region !== baseline.region ||
    rehearsal.encrypted !== true ||
    rehearsal.contentInspectionAllowed !== false ||
    !hasExactObjectKeys(rehearsal.checks, [
      "startupPassed",
      "tenantIsolationPassed",
      "rollbackPassed",
      "metadataOnlyEvidence",
    ])
  ) {
    fail(
      "gateway rehearsal must preserve the exact encrypted metadata-only boundary",
    );
  }
  const rehearsalChecks = Object.values(rehearsal.checks);
  if (
    contract.state === "awaiting_rehearsal" ||
    contract.state === "rehearsal_approved"
  ) {
    const expectedSourceVolumeId =
      contract.state === "rehearsal_approved" ? baseline.volumeId : null;
    if (
      rehearsal.state !== "pending" ||
      rehearsal.evidenceArtifact !== null ||
      rehearsal.evidenceSha256 !== null ||
      rehearsal.sourceVolumeId !== expectedSourceVolumeId ||
      rehearsalChecks.some((value) => value !== false)
    ) {
      fail(
        "gateway rehearsal evidence must remain pending until the protected rehearsal completes",
      );
    }
  } else if (
    rehearsal.state !== "passed" ||
    !/^gateway-state-rehearsal-[1-9][0-9]*-[1-9][0-9]*$/.test(
      rehearsal.evidenceArtifact ?? "",
    ) ||
    !isExactSha256(rehearsal.evidenceSha256) ||
    rehearsal.sourceVolumeId !== baseline.volumeId ||
    rehearsalChecks.some((value) => value !== true)
  ) {
    fail("gateway rehearsal lacks complete exact metadata-only evidence");
  }
}

function validateGatewayRebaselineTransitions(contract, app, artifact) {
  if (contract.state === "settled") {
    validateReviewedGatewayTransition(contract.recovery, "recovery", app);
    validateReviewedGatewayTransition(contract.successor, "successor", app);
    if (
      contract.successor.image !== artifact.image ||
      contract.successor.sourceCommit !== artifact.sourceCommit
    ) {
      fail("gateway successor must match the exact reviewed rollout artifact");
    }
  } else {
    validateUnreviewedGatewayTransition(contract.recovery, "recovery");
    validateUnreviewedGatewayTransition(contract.successor, "successor");
  }
}

function validateGatewayHistoricalResourcePolicy(contract) {
  if (
    !hasExactObjectKeys(contract.historicalResources, [
      "automaticDeletionAllowed",
      "preserveUnlistedMachines",
      "preserveUnlistedVolumes",
    ]) ||
    contract.historicalResources.automaticDeletionAllowed !== false ||
    contract.historicalResources.preserveUnlistedMachines !== true ||
    contract.historicalResources.preserveUnlistedVolumes !== true
  ) {
    fail(
      "gateway state rebaseline must never auto-delete historical Machines or volumes",
    );
  }
}

function validateGatewayPreparatoryEnforcement(contract, flyConfig) {
  if (contract.enforcementEnabled !== false) {
    fail(
      "gateway quota enforcement must remain disabled throughout the preparatory rebaseline",
    );
  }
  if (
    /(?:^|\n)\s*LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED\s*=/i.test(
      flyConfig,
    )
  ) {
    fail(
      "fly.toml personal gateway must not configure customer AI answer enforcement",
    );
  }
}

function validateGatewayStateRebaseline(app, flyConfig) {
  const contract = app.stateRebaseline;
  if (
    !hasExactObjectKeys(contract, [
      "state",
      "enforcementEnabled",
      "baseline",
      "reviewedArtifact",
      "rehearsal",
      "recovery",
      "successor",
      "historicalResources",
    ]) ||
    !GATEWAY_REBASELINE_STATES.includes(contract.state)
  ) {
    fail("gateway must define one exact stateful rebaseline contract");
  }
  const baseline = validateGatewayRebaselineBaseline(app, contract);
  const artifact = validateGatewayRebaselineArtifact(app, contract);
  validateGatewayRehearsal(contract, baseline);
  validateGatewayRebaselineTransitions(contract, app, artifact);
  validateGatewayHistoricalResourcePolicy(contract);
  validateGatewayPreparatoryEnforcement(contract, flyConfig);
}

function reviewedSourceCommitForImage(app, image) {
  if (image === app.reviewedImage) return app.reviewedSourceCommit;
  return app.reviewedRollbackSourceCommits?.[image];
}

function reviewedArtifactKindForImage(app, image) {
  if (image === app.reviewedImage) return app.reviewedArtifactKind;
  return app.reviewedRollbackArtifactKinds?.[image];
}

export function getReviewedArtifactKind(
  target,
  image,
  rootDir = process.cwd(),
) {
  const app = loadProductionManifest(rootDir).apps[target];
  if (!app) fail(`Unknown production target: ${target}`);
  if (!reviewedProductionImages(app).has(image)) {
    fail(`${target} image is not in the reviewed production allowlist`);
  }
  const kind = reviewedArtifactKindForImage(app, image);
  if (!REVIEWED_ARTIFACT_KINDS.includes(kind)) {
    fail(`${target} image lacks a reviewed artifact kind`);
  }
  return kind;
}

function reviewedSchemaPhasesForImage(app, image) {
  if (image === app.reviewedImage) return app.reviewedImageSchemaPhases;
  return app.reviewedRollbackImageSchemaPhases?.[image];
}

function assertReviewedSchemaPhases(target, app, image) {
  if (target !== "image-gen") return null;
  const phases = reviewedSchemaPhasesForImage(app, image);
  if (!Array.isArray(phases) || phases.length === 0) {
    fail(`${target} image lacks reviewed schema compatibility metadata`);
  }
  const indexes = phases.map((phase) =>
    PRODUCTION_SCHEMA_PHASES.indexOf(phase),
  );
  if (
    indexes.some((index) => index < 0) ||
    new Set(phases).size !== phases.length ||
    !indexes.every((index, position) =>
      position === 0 ? true : index === indexes[position - 1] + 1,
    )
  ) {
    fail(`${target} image schema phases must be one ordered contiguous range`);
  }
  if (!phases.includes(app.databaseSchemaPhase)) {
    fail(
      `${target} image does not support database phase ${app.databaseSchemaPhase}`,
    );
  }
  return { minimum: phases[0], maximum: phases.at(-1), phases: [...phases] };
}

export function getReviewedArtifactSchemaSupport(
  target,
  image,
  rootDir = process.cwd(),
) {
  const app = loadProductionManifest(rootDir).apps[target];
  if (!app) fail(`Unknown production target: ${target}`);
  if (!reviewedProductionImages(app).has(image)) {
    fail(`${target} image is not in the reviewed production allowlist`);
  }
  const support = assertReviewedSchemaPhases(target, app, image);
  if (!support) fail(`${target} does not declare database schema phases`);
  return support;
}

export function validateReviewedArtifactSchemaPhase(
  target,
  image,
  phase,
  rootDir = process.cwd(),
) {
  const support = getReviewedArtifactSchemaSupport(target, image, rootDir);
  if (
    !PRODUCTION_SCHEMA_PHASES.includes(phase) ||
    !support.phases.includes(phase)
  ) {
    fail(`${target} image does not support database phase ${phase}`);
  }
  return phase;
}

function assertReviewedArtifactProvenance(target, app, image) {
  if (target === "gateway") return null;
  const kind = reviewedArtifactKindForImage(app, image);
  if (kind === "legacy-bootstrap") {
    fail(
      `${target} legacy bootstrap image has no trusted build attestation and cannot be deployed as a reviewed artifact`,
    );
  }
  const sourceCommit = reviewedSourceCommitForImage(app, image);
  if (!isReviewedSourceCommit(sourceCommit)) {
    fail(
      `${target} image lacks an exact reviewed source commit; legacy unattested images cannot be deployed or used as rollback after schema changes`,
    );
  }
  return sourceCommit;
}

export function getReviewedArtifactSourceCommit(
  target,
  image,
  rootDir = process.cwd(),
) {
  const app = loadProductionManifest(rootDir).apps[target];
  if (!app) fail(`Unknown production target: ${target}`);
  if (!reviewedProductionImages(app).has(image)) {
    fail(`${target} image is not in the reviewed production allowlist`);
  }
  return assertReviewedArtifactProvenance(target, app, image);
}

export async function verifyReviewedArtifactCi(target, image, options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const sourceCommit = getReviewedArtifactSourceCommit(target, image, rootDir);
  return verifySourceCi(sourceCommit, options);
}

export async function verifySourceCi(
  sourceCommit,
  {
    fetchImpl = globalThis.fetch,
    repository = process.env.GITHUB_REPOSITORY,
    token = process.env.GITHUB_TOKEN,
    apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com",
  } = {},
) {
  if (!isReviewedSourceCommit(sourceCommit)) {
    fail("source CI verification requires one exact 40-character Git SHA");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
    fail("GITHUB_REPOSITORY must identify the exact source repository");
  }
  if (typeof token !== "string" || token.length < 1) {
    fail("GITHUB_TOKEN with Actions read permission is required");
  }
  if (typeof fetchImpl !== "function") {
    fail("A fetch implementation is required to verify source CI");
  }

  const normalizedApiUrl = apiUrl.replace(/\/+$/, "");
  const [owner, repo] = repository.split("/");
  await Promise.all(
    REQUIRED_ARTIFACT_CI_WORKFLOWS.map(async (workflow) => {
      const url = new URL(
        `${normalizedApiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/workflows/${encodeURIComponent(workflow)}/runs`,
      );
      url.searchParams.set("branch", "main");
      url.searchParams.set("event", "push");
      url.searchParams.set("status", "success");
      url.searchParams.set("head_sha", sourceCommit);
      url.searchParams.set("per_page", "100");
      const response = await fetchImpl(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        fail(
          `Could not verify ${workflow} for reviewed source ${sourceCommit}`,
        );
      }
      const body = await response.json();
      const matchingRun = body?.workflow_runs?.find(
        (run) =>
          run?.head_sha === sourceCommit &&
          run?.head_branch === "main" &&
          run?.event === "push" &&
          run?.status === "completed" &&
          run?.conclusion === "success" &&
          run?.path === `.github/workflows/${workflow}`,
      );
      if (!matchingRun) {
        fail(
          `${workflow} has no successful main push run for reviewed source ${sourceCommit}`,
        );
      }
    }),
  );
  return { sourceCommit, workflows: [...REQUIRED_ARTIFACT_CI_WORKFLOWS] };
}

function parseDeploymentIdentity(identity) {
  const match = /^(deploy)-([0-9]+)-([0-9]+)$/.exec(identity ?? "");
  if (!match) return null;
  return {
    identity,
    runId: match[2],
    runAttempt: match[3],
  };
}

function allowsFirstTrustedBootstrap(target, app, expectedImage) {
  if (target === "gateway") {
    return (
      app.deploymentEnabled === false &&
      !app.reviewedImage &&
      (app.reviewedRollbackImages ?? []).length === 0
    );
  }
  if (target === "image-gen") {
    const transition = app.databaseSchemaTransition;
    return (
      transition?.state === "bridge_reviewed" &&
      app.reviewedArtifactKind === "migration-bridge" &&
      app.reviewedImage === transition.bridgeImage &&
      expectedImage === transition.legacyBaseImage
    );
  }
  if (target === "storage-proxy") {
    const transition = app.artifactTransition;
    return (
      transition?.state === "runtime_reviewed" &&
      app.reviewedArtifactKind === "runtime" &&
      app.reviewedImage !== transition.legacyImage &&
      expectedImage === transition.legacyImage
    );
  }
  return false;
}

export function allowsStorageProxyFirstTrustedBootstrapRestore(
  target,
  image,
  identity,
  rootDir = process.cwd(),
) {
  const app = loadProductionManifest(rootDir).apps[target];
  return (
    target === "storage-proxy" &&
    identity === "none" &&
    app != null &&
    allowsFirstTrustedBootstrap(target, app, image)
  );
}

function githubActionsHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchWorkflowAttempt(
  identity,
  {
    fetchImpl,
    repository,
    token,
    apiUrl,
    maxAttempts,
    retryDelayMs,
    sleepImpl,
    requireSettled,
  },
) {
  const parsed = parseDeploymentIdentity(identity);
  if (!parsed) {
    fail("settled baseline requires none or an exact deploy run identity");
  }
  const [owner, repo] = repository.split("/");
  const url = new URL(
    `${apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/runs/${parsed.runId}/attempts/${parsed.runAttempt}`,
  );
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetchImpl(url, {
      headers: githubActionsHeaders(token),
      signal: AbortSignal.timeout(15_000),
    });
    const transientStatus =
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500;
    if (!response.ok) {
      if (transientStatus && attempt < maxAttempts) {
        await sleepImpl(retryDelayMs);
        continue;
      }
      fail(`Could not verify settled deployment identity ${identity}`);
    }
    const body = await response.json();
    if (
      requireSettled &&
      (body?.status !== "completed" || body?.conclusion == null) &&
      attempt < maxAttempts
    ) {
      await sleepImpl(retryDelayMs);
      continue;
    }
    return { parsed, body };
  }
  fail(`Could not verify settled deployment identity ${identity}`);
}

function assertCanonicalDeploymentRun(target, parsed, run, repository) {
  const exactTitle = `Deploy ${target} to production`;
  if (
    String(run?.id) !== parsed.runId ||
    String(run?.run_attempt) !== parsed.runAttempt ||
    run?.head_branch !== "main" ||
    run?.event !== "workflow_dispatch" ||
    run?.path !== PRODUCTION_WORKFLOW_PATH ||
    run?.display_title !== exactTitle ||
    !/^[a-f0-9]{40}$/.test(run?.head_sha ?? "") ||
    (run?.repository?.full_name != null &&
      run.repository.full_name !== repository)
  ) {
    fail(
      `Deployment identity ${parsed.identity} is not the exact canonical ${target} run`,
    );
  }
}

export async function verifySettledBaseline(
  target,
  identity,
  {
    rootDir = process.cwd(),
    expectedImage,
    expectedSourceSha,
    supersedesIdentity,
    fetchImpl = globalThis.fetch,
    repository = process.env.GITHUB_REPOSITORY,
    token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
    apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com",
    maxAttempts = 3,
    retryDelayMs = 2_000,
    sleepImpl = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  const app = loadProductionManifest(rootDir).apps[target];
  if (!app) fail(`Unknown production target: ${target}`);
  if (identity === "none") {
    if (supersedesIdentity) {
      fail("bootstrap identity cannot supersede a deployment");
    }
    if (!allowsFirstTrustedBootstrap(target, app, expectedImage)) {
      fail(`${target} has no manifest-approved first trusted bootstrap`);
    }
    return { target, identity, bootstrap: true };
  }
  const parsed = parseDeploymentIdentity(identity);
  if (!parsed) {
    fail("settled baseline requires none or an exact deploy run identity");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
    fail("GITHUB_REPOSITORY must identify the exact source repository");
  }
  if (typeof token !== "string" || token.length < 1) {
    fail("GITHUB_TOKEN with Actions read permission is required");
  }
  if (typeof fetchImpl !== "function") {
    fail("A fetch implementation is required to verify the settled baseline");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    fail("settled baseline retry count must be between one and five");
  }
  const normalizedApiUrl = apiUrl.replace(/\/+$/, "");
  const current = await fetchWorkflowAttempt(identity, {
    fetchImpl,
    repository,
    token,
    apiUrl: normalizedApiUrl,
    maxAttempts,
    retryDelayMs,
    sleepImpl,
    requireSettled: true,
  });
  assertCanonicalDeploymentRun(
    target,
    current.parsed,
    current.body,
    repository,
  );
  if (
    current.body.status !== "completed" ||
    current.body.conclusion !== "success" ||
    !Number.isInteger(current.body.run_number) ||
    current.body.run_number < 1
  ) {
    fail(
      `Deployment identity ${identity} is not a completed successful release`,
    );
  }
  if (
    expectedSourceSha != null &&
    current.body.head_sha !== expectedSourceSha
  ) {
    fail(
      `Deployment identity ${identity} does not match the expected source SHA`,
    );
  }

  if (supersedesIdentity) {
    const priorParsed = parseDeploymentIdentity(supersedesIdentity);
    if (!priorParsed) {
      fail("superseded baseline must be an exact deploy run identity");
    }
    const prior = await fetchWorkflowAttempt(supersedesIdentity, {
      fetchImpl,
      repository,
      token,
      apiUrl: normalizedApiUrl,
      maxAttempts: 1,
      retryDelayMs,
      sleepImpl,
      requireSettled: false,
    });
    assertCanonicalDeploymentRun(target, prior.parsed, prior.body, repository);
    if (!Number.isInteger(prior.body.run_number) || prior.body.run_number < 1) {
      fail("Superseded deployment has no trustworthy run number");
    }
    const newerRun = current.body.run_number > prior.body.run_number;
    const newerAttempt =
      current.body.run_number === prior.body.run_number &&
      current.parsed.runId === prior.parsed.runId &&
      BigInt(current.parsed.runAttempt) > BigInt(prior.parsed.runAttempt);
    if (!newerRun && !newerAttempt) {
      fail(`${identity} is not newer than ${supersedesIdentity}`);
    }
  }
  return {
    target,
    identity,
    bootstrap: false,
    runId: parsed.runId,
    runAttempt: parsed.runAttempt,
    runNumber: current.body.run_number,
    sourceSha: current.body.head_sha,
  };
}

export async function verifyDeploymentCandidate(
  target,
  liveIdentity,
  candidateIdentity,
  {
    rootDir = process.cwd(),
    expectedSourceSha,
    expectedLiveImage,
    fetchImpl = globalThis.fetch,
    repository = process.env.GITHUB_REPOSITORY,
    token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
    apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com",
    maxAttempts = 3,
    retryDelayMs = 2_000,
    sleepImpl = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  if (!isReviewedSourceCommit(expectedSourceSha)) {
    fail("deployment candidate requires the exact current source SHA");
  }
  const app = loadProductionManifest(rootDir).apps[target];
  if (!app) fail(`Unknown production target: ${target}`);
  const candidateParsed = parseDeploymentIdentity(candidateIdentity);
  if (!candidateParsed) {
    fail("deployment candidate must use an exact deploy run identity");
  }
  let liveRunNumber = 0;
  let liveParsed = null;
  if (liveIdentity === "none") {
    const bootstrapImage =
      expectedLiveImage ??
      (target === "image-gen"
        ? app.databaseSchemaTransition?.legacyBaseImage
        : target === "storage-proxy"
          ? app.artifactTransition?.legacyImage
          : undefined);
    if (!allowsFirstTrustedBootstrap(target, app, bootstrapImage)) {
      fail(`${target} has no manifest-approved first trusted bootstrap`);
    }
  } else {
    liveParsed = parseDeploymentIdentity(liveIdentity);
    if (!liveParsed) {
      fail("candidate comparison requires a trusted settled live identity");
    }
    const live = await verifySettledBaseline(target, liveIdentity, {
      rootDir,
      fetchImpl,
      repository,
      token,
      apiUrl,
      maxAttempts,
      retryDelayMs,
      sleepImpl,
    });
    liveRunNumber = live.runNumber;
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
    fail("GITHUB_REPOSITORY must identify the exact source repository");
  }
  if (typeof token !== "string" || token.length < 1) {
    fail("GITHUB_TOKEN with Actions read permission is required");
  }
  if (typeof fetchImpl !== "function") {
    fail(
      "A fetch implementation is required to verify the deployment candidate",
    );
  }
  const candidate = await fetchWorkflowAttempt(candidateIdentity, {
    fetchImpl,
    repository,
    token,
    apiUrl: apiUrl.replace(/\/+$/, ""),
    maxAttempts: 1,
    retryDelayMs,
    sleepImpl,
    requireSettled: false,
  });
  assertCanonicalDeploymentRun(
    target,
    candidate.parsed,
    candidate.body,
    repository,
  );
  if (
    candidate.body.status !== "in_progress" ||
    candidate.body.conclusion != null ||
    candidate.body.head_sha !== expectedSourceSha ||
    !Number.isInteger(candidate.body.run_number) ||
    candidate.body.run_number < 1
  ) {
    fail(
      `${candidateIdentity} is not the exact in-progress deployment candidate`,
    );
  }
  const newerRun = candidate.body.run_number > liveRunNumber;
  const newerAttempt =
    liveParsed != null &&
    candidate.body.run_number === liveRunNumber &&
    candidateParsed.runId === liveParsed.runId &&
    BigInt(candidateParsed.runAttempt) > BigInt(liveParsed.runAttempt);
  if (!newerRun && !newerAttempt) {
    fail(`${candidateIdentity} is not newer than live ${liveIdentity}`);
  }
  return {
    target,
    liveIdentity,
    candidateIdentity,
    runNumber: candidate.body.run_number,
  };
}

function safeSuccessorSourcePath(relativePath, expectedPathPrefix = null) {
  return (
    typeof relativePath === "string" &&
    relativePath.length > 0 &&
    !path.isAbsolute(relativePath) &&
    !relativePath.includes("\\") &&
    path.posix.normalize(relativePath) === relativePath &&
    !relativePath.startsWith("../") &&
    (expectedPathPrefix == null || relativePath.startsWith(expectedPathPrefix))
  );
}

async function fetchGithubRawFile(relativePath, sourceSha, options) {
  const [owner, repo] = options.repository.split("/");
  const url = new URL(
    `${options.apiUrl.replace(/\/+$/, "")}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${relativePath.split("/").map(encodeURIComponent).join("/")}`,
  );
  url.searchParams.set("ref", sourceSha);
  const response = await options.fetchImpl(url, {
    headers: {
      ...githubActionsHeaders(options.token),
      Accept: "application/vnd.github.raw+json",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    fail(`Could not fetch successor source file ${relativePath}`);
  }
  const text = await response.text();
  if (
    typeof text !== "string" ||
    text.length === 0 ||
    text.length > 1_000_000
  ) {
    fail(`Successor source file ${relativePath} has an unsafe size`);
  }
  return text;
}

function assertSuccessorSourceAccess({ repository, token, fetchImpl }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository ?? "")) {
    fail("GITHUB_REPOSITORY must identify the exact source repository");
  }
  if (typeof token !== "string" || token.length < 1) {
    fail("GITHUB_TOKEN with Actions and contents read permission is required");
  }
  if (typeof fetchImpl !== "function") {
    fail("A fetch implementation is required for successor source validation");
  }
}

function resolveSuccessorSourceDestination(destination) {
  const absoluteDestination = path.resolve(destination ?? "");
  if (
    !destination ||
    absoluteDestination === path.parse(absoluteDestination).root ||
    fs.existsSync(absoluteDestination)
  ) {
    fail("Successor source destination must be a new bounded directory");
  }
  return absoluteDestination;
}

function parseSuccessorProductionManifest(manifestText) {
  try {
    return JSON.parse(manifestText);
  } catch {
    fail("Successor production manifest is not valid JSON");
  }
}

function getSuccessorManifestApp(target, manifest) {
  const app = manifest?.schemaVersion === 1 ? manifest.apps?.[target] : null;
  const canonical = CANONICAL_TARGETS[target];
  if (
    !app ||
    !canonical ||
    app.app !== canonical.app ||
    app.config !== canonical.config ||
    !isImmutableAppImage(app, app.reviewedImage) ||
    !safeSuccessorSourcePath(app.config)
  ) {
    fail("Successor manifest does not bind the canonical target and source");
  }
  return app;
}

function getSuccessorRollbackRecords(app) {
  const rollbackRecords = Object.values(app.reviewedRollbackConfigs ?? {});
  const hasUnsafeRecord = rollbackRecords.some(
    (record) =>
      !safeSuccessorSourcePath(
        record?.path,
        "deploy/production/rollback-configs/",
      ) || !/^[a-f0-9]{64}$/.test(record?.sha256 ?? ""),
  );
  if (
    !Array.isArray(app.reviewedRollbackImages) ||
    rollbackRecords.length !== app.reviewedRollbackImages.length ||
    hasUnsafeRecord
  ) {
    fail("Successor manifest has unsafe rollback configuration records");
  }
  return rollbackRecords;
}

async function fetchSuccessorSourceFiles(
  app,
  rollbackRecords,
  sourceSha,
  manifestText,
  fetchOptions,
) {
  const sourceFiles = new Map([[MANIFEST_PATH, manifestText]]);
  const sourcePaths = new Set([
    app.config,
    ...rollbackRecords.map((record) => record.path),
  ]);
  for (const relativePath of sourcePaths) {
    sourceFiles.set(
      relativePath,
      await fetchGithubRawFile(relativePath, sourceSha, fetchOptions),
    );
  }
  return sourceFiles;
}

function writeSuccessorSourceFiles(absoluteDestination, sourceFiles) {
  fs.mkdirSync(absoluteDestination);
  for (const [relativePath, source] of sourceFiles) {
    const absolutePath = path.resolve(absoluteDestination, relativePath);
    if (!absolutePath.startsWith(`${absoluteDestination}${path.sep}`)) {
      fail("Successor source path escapes its bounded directory");
    }
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, source, { flag: "wx", mode: 0o600 });
  }
}

function validateSuccessorDeploymentPolicy(target, app, rootDir) {
  if (target === "gateway") {
    fail(
      "Gateway successor validation requires the separately reviewed stateful rebaseline transition",
    );
  }
  if (
    app.sourceDeployEnabled !== false ||
    app.trustedBuilderWorkflow !== TRUSTED_ARTIFACT_WORKFLOW_PATH ||
    app.strategy !== "rolling" ||
    app.allowDetachedMachines !== false
  ) {
    fail("Successor manifest weakens the trusted immutable deployment policy");
  }
  validateDeploymentEnabled(target, rootDir);
  validateReviewedImage(target, app.reviewedImage, rootDir);
  getReviewedArtifactKind(target, app.reviewedImage, rootDir);
  if (target === "image-gen") validateImageGenSchemaTransition(app);
  if (target === "storage-proxy") validateStorageProxyArtifactTransition(app);
}

function validateSuccessorRollbackProvenance(target, app, rootDir) {
  for (const image of app.reviewedRollbackImages) {
    const kind = getReviewedArtifactKind(target, image, rootDir);
    validateReviewedRollbackImage(target, image, rootDir);
    const sourceCommit = app.reviewedRollbackSourceCommits?.[image];
    const invalidLegacySource =
      kind === "legacy-bootstrap" && sourceCommit !== undefined;
    const invalidReviewedSource =
      kind !== "legacy-bootstrap" && !isReviewedSourceCommit(sourceCommit);
    if (invalidLegacySource || invalidReviewedSource) {
      fail("Successor rollback provenance does not match its artifact kind");
    }
  }
}

async function verifySuccessorSource(
  target,
  identity,
  supersedesIdentity,
  options,
) {
  const successor = await verifySettledBaseline(target, identity, {
    ...options,
    supersedesIdentity,
  });
  if (!isReviewedSourceCommit(successor.sourceSha)) {
    fail("Successor deployment lacks an exact source SHA");
  }
  return successor;
}

async function loadSuccessorSourceBundle(target, sourceSha, fetchOptions) {
  const manifestText = await fetchGithubRawFile(
    MANIFEST_PATH,
    sourceSha,
    fetchOptions,
  );
  const manifest = parseSuccessorProductionManifest(manifestText);
  const app = getSuccessorManifestApp(target, manifest);
  const rollbackRecords = getSuccessorRollbackRecords(app);
  const sourceFiles = await fetchSuccessorSourceFiles(
    app,
    rollbackRecords,
    sourceSha,
    manifestText,
    fetchOptions,
  );
  return { app, sourceFiles };
}

function validateSuccessorRollbackConfigs(target, app, rootDir) {
  for (const image of app.reviewedRollbackImages) {
    getReviewedRollbackConfig(target, image, rootDir);
  }
}

async function verifySuccessorSourceCi(
  target,
  app,
  sourceSha,
  rootDir,
  fetchOptions,
) {
  await verifyReviewedArtifactCi(target, app.reviewedImage, {
    rootDir,
    ...fetchOptions,
  });
  await verifySourceCi(sourceSha, fetchOptions);
}

export async function materializeSuccessorSourceRoot(
  target,
  identity,
  supersedesIdentity,
  destination,
  {
    fetchImpl = globalThis.fetch,
    repository = process.env.GITHUB_REPOSITORY,
    token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
    apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com",
    retryDelayMs = 2_000,
    sleepImpl = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {},
) {
  assertSuccessorSourceAccess({ repository, token, fetchImpl });
  const verificationOptions = {
    fetchImpl,
    repository,
    token,
    apiUrl,
    retryDelayMs,
    sleepImpl,
  };
  const successor = await verifySuccessorSource(
    target,
    identity,
    supersedesIdentity,
    verificationOptions,
  );
  const absoluteDestination = resolveSuccessorSourceDestination(destination);
  const fetchOptions = {
    fetchImpl,
    repository,
    token,
    apiUrl,
  };
  const { app, sourceFiles } = await loadSuccessorSourceBundle(
    target,
    successor.sourceSha,
    fetchOptions,
  );
  writeSuccessorSourceFiles(absoluteDestination, sourceFiles);
  validateSuccessorRollbackConfigs(target, app, absoluteDestination);
  validateSuccessorDeploymentPolicy(target, app, absoluteDestination);
  validateSuccessorRollbackProvenance(target, app, absoluteDestination);
  await verifySuccessorSourceCi(
    target,
    app,
    successor.sourceSha,
    absoluteDestination,
    fetchOptions,
  );
  return {
    target,
    identity,
    sourceSha: successor.sourceSha,
    rootDir: absoluteDestination,
  };
}

export function validateReviewedRollbackImage(
  target,
  image,
  rootDir = process.cwd(),
) {
  const app = loadProductionManifest(rootDir).apps[target];
  if (!app) fail(`Unknown production target: ${target}`);
  if (!isImmutableAppImage(app, image)) {
    fail(`${target} rollback image must be an immutable image for ${app.app}`);
  }
  if (!reviewedProductionImages(app).has(image)) {
    fail(
      `${target} rollback image is not in the reviewed production allowlist`,
    );
  }
  if (reviewedArtifactKindForImage(app, image) === "legacy-bootstrap") {
    validateLegacyTransitionRollback(target, image, rootDir);
  } else {
    assertReviewedArtifactProvenance(target, app, image);
  }
  assertReviewedSchemaPhases(target, app, image);
  return image;
}

export function getReviewedRollbackConfig(
  target,
  image,
  rootDir = process.cwd(),
) {
  const app = loadProductionManifest(rootDir).apps[target];
  if (!app) fail(`Unknown production target: ${target}`);
  if (!app.reviewedRollbackImages?.includes(image)) {
    fail(`${target} rollback config requires an allowlisted rollback image`);
  }
  const configs = app.reviewedRollbackConfigs;
  if (!configs || typeof configs !== "object" || Array.isArray(configs)) {
    fail(`${target} must define reviewedRollbackConfigs`);
  }
  if (
    JSON.stringify(Object.keys(configs).sort()) !==
    JSON.stringify([...app.reviewedRollbackImages].sort())
  ) {
    fail(
      `${target} reviewed rollback configs must cover exactly every allowlisted rollback image`,
    );
  }
  const config = configs[image];
  const relativePath = config?.path;
  const expectedSha256 = config?.sha256;
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.startsWith("../") ||
    !relativePath.startsWith("deploy/production/rollback-configs/") ||
    !/^[a-f0-9]{64}$/.test(expectedSha256 ?? "")
  ) {
    fail(`${target} has an unsafe reviewed rollback config record`);
  }
  const absoluteRoot = path.resolve(rootDir);
  const absolutePath = path.resolve(absoluteRoot, relativePath);
  if (!absolutePath.startsWith(`${absoluteRoot}${path.sep}`)) {
    fail(`${target} reviewed rollback config escapes the repository`);
  }
  let fileStats;
  try {
    fileStats = fs.lstatSync(absolutePath);
  } catch {
    fail(`${target} reviewed rollback config is missing`);
  }
  if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
    fail(
      `${target} reviewed rollback config must be a regular repository file`,
    );
  }
  const realRoot = fs.realpathSync(absoluteRoot);
  const realConfigPath = fs.realpathSync(absolutePath);
  if (!realConfigPath.startsWith(`${realRoot}${path.sep}`)) {
    fail(`${target} reviewed rollback config escapes the repository`);
  }
  const actualSha256 = createHash("sha256")
    .update(fs.readFileSync(absolutePath))
    .digest("hex");
  if (actualSha256 !== expectedSha256) {
    fail(`${target} reviewed rollback config hash does not match the manifest`);
  }
  return relativePath;
}

export function getReviewedSettledPredecessorConfig(
  target,
  identity,
  image,
  rootDir = process.cwd(),
) {
  const app = loadProductionManifest(rootDir).apps[target];
  if (!app) fail(`Unknown production target: ${target}`);
  const predecessor = app.reviewedSettledPredecessor;
  if (predecessor == null) return null;
  const relativePath = predecessor.path;
  const expectedSha256 = predecessor.sha256;
  if (
    typeof predecessor !== "object" ||
    Array.isArray(predecessor) ||
    !/^(?:deploy-[0-9]+-[0-9]+)$/.test(predecessor.identity ?? "") ||
    !isImmutableAppImage(app, predecessor.image) ||
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.startsWith("../") ||
    !relativePath.startsWith("deploy/production/rollback-configs/") ||
    !/^[a-f0-9]{64}$/.test(expectedSha256 ?? "")
  ) {
    fail(`${target} has an unsafe reviewed settled predecessor`);
  }
  const absoluteRoot = path.resolve(rootDir);
  const absolutePath = path.resolve(absoluteRoot, relativePath);
  if (!absolutePath.startsWith(`${absoluteRoot}${path.sep}`)) {
    fail(`${target} reviewed settled predecessor escapes the repository`);
  }
  let fileStats;
  try {
    fileStats = fs.lstatSync(absolutePath);
  } catch {
    fail(`${target} reviewed settled predecessor config is missing`);
  }
  if (!fileStats.isFile() || fileStats.isSymbolicLink()) {
    fail(`${target} reviewed settled predecessor must be a regular file`);
  }
  const realRoot = fs.realpathSync(absoluteRoot);
  const realConfigPath = fs.realpathSync(absolutePath);
  if (!realConfigPath.startsWith(`${realRoot}${path.sep}`)) {
    fail(`${target} reviewed settled predecessor escapes the repository`);
  }
  const actualSha256 = createHash("sha256")
    .update(fs.readFileSync(absolutePath))
    .digest("hex");
  if (actualSha256 !== expectedSha256) {
    fail(`${target} reviewed settled predecessor hash does not match`);
  }
  if (predecessor.identity !== identity || predecessor.image !== image) {
    return null;
  }
  return relativePath;
}

export function getReviewedRestoreConfig(
  target,
  image,
  identity,
  rootDir = process.cwd(),
) {
  if (!/^(?:none|deploy-[0-9]+-[0-9]+)$/.test(identity ?? "")) {
    fail(`${target} restore config requires an exact deployment identity`);
  }
  const predecessorConfig = getReviewedSettledPredecessorConfig(
    target,
    identity,
    image,
    rootDir,
  );
  if (predecessorConfig != null) {
    validateReviewedRollbackImage(target, image, rootDir);
    return predecessorConfig;
  }
  const app = loadProductionManifest(rootDir).apps[target];
  if (app?.reviewedSettledPredecessor?.image === image) {
    fail(`${target} current image lacks an exact identity-bound restore config`);
  }
  return getReviewedRollbackConfig(target, image, rootDir);
}

function assertReviewedRestoreConfigCopy(
  target,
  image,
  identity,
  configPath,
  rootDir,
  failureMessage =
    "scale count drift allowance requires the reviewed restore config",
) {
  const reviewedRelativePath = getReviewedRestoreConfig(
    target,
    image,
    identity,
    rootDir,
  );
  const reviewedPath = path.resolve(rootDir, reviewedRelativePath);
  const candidatePath = path.isAbsolute(configPath)
    ? configPath
    : path.resolve(rootDir, configPath);
  let candidateStats;
  try {
    candidateStats = fs.lstatSync(candidatePath);
  } catch {
    fail(failureMessage);
  }
  if (!candidateStats.isFile() || candidateStats.isSymbolicLink()) {
    fail(failureMessage);
  }
  const reviewedSha256 = createHash("sha256")
    .update(fs.readFileSync(reviewedPath))
    .digest("hex");
  const candidateSha256 = createHash("sha256")
    .update(fs.readFileSync(candidatePath))
    .digest("hex");
  if (candidateSha256 !== reviewedSha256) {
    fail(failureMessage);
  }
}

export function validateLegacyTransitionRollback(
  target,
  image,
  rootDir = process.cwd(),
) {
  const app = loadProductionManifest(rootDir).apps[target];
  if (!app || !["image-gen", "storage-proxy"].includes(target)) {
    fail("legacy transition rollback is unavailable for this target");
  }
  const allowed =
    target === "image-gen"
      ? app.databaseSchemaTransition?.state === "bridge_reviewed" &&
        app.databaseSchemaPhase === "0015_base" &&
        app.reviewedArtifactKind === "migration-bridge" &&
        image === app.databaseSchemaTransition.legacyBaseImage
      : ["runtime_reviewed", "runtime_deployed"].includes(
            app.artifactTransition?.state,
          ) &&
        app.reviewedArtifactKind === "runtime" &&
        image === app.artifactTransition.legacyImage;
  if (
    !allowed ||
    !app.reviewedRollbackImages.includes(image) ||
    app.reviewedRollbackArtifactKinds?.[image] !== "legacy-bootstrap"
  ) {
    fail(
      "legacy image is allowed only as the exact first trusted-rollout rollback",
    );
  }
  return image;
}

export function validateReviewedImage(target, image, rootDir = process.cwd()) {
  const app = loadProductionManifest(rootDir).apps[target];
  if (!app) fail(`Unknown production target: ${target}`);
  if (!isImmutableAppImage(app, image)) {
    fail(`${target} reviewed image must be an immutable image for ${app.app}`);
  }
  if (image !== app.reviewedImage) {
    fail(`${target} image must exactly match the reviewed manifest digest`);
  }
  assertReviewedArtifactProvenance(target, app, image);
  assertReviewedSchemaPhases(target, app, image);
  return image;
}

export function validateDeploymentEnabled(target, rootDir = process.cwd()) {
  const app = loadProductionManifest(rootDir).apps[target];
  if (!app) fail(`Unknown production target: ${target}`);
  if (target === "gateway") {
    fail(
      `gateway production deployment is blocked: ${app.deploymentBlockReason ?? "stateful gateway migration is not approved"}`,
    );
  }
  if (app.deploymentEnabled !== true) {
    fail(
      `${target} production deployment is blocked: ${app.deploymentBlockReason}`,
    );
  }
  return app;
}

export function resolveImmutableReleaseImage(
  target,
  releaseImage,
  imageRecords,
  rootDir = process.cwd(),
) {
  const app = loadProductionManifest(rootDir).apps[target];
  if (!app) fail(`Unknown production target: ${target}`);
  if (isImmutableAppImage(app, releaseImage)) return releaseImage;

  const tagPrefix = `registry.fly.io/${app.app}:`;
  if (typeof releaseImage !== "string" || !releaseImage.startsWith(tagPrefix)) {
    fail(`${target} release image is not from the reviewed Fly app`);
  }
  const tag = releaseImage.slice(tagPrefix.length);
  const immutableImages = new Set(
    (Array.isArray(imageRecords) ? imageRecords : [])
      .filter(
        (record) =>
          record?.Registry === "registry.fly.io" &&
          record?.Repository === app.app &&
          record?.Tag === tag &&
          /^sha256:[a-f0-9]{64}$/.test(record?.Digest ?? ""),
      )
      .map(
        (record) => `${record.Registry}/${record.Repository}@${record.Digest}`,
      ),
  );
  if (immutableImages.size !== 1) {
    fail(`${target} release tag did not resolve to one immutable image`);
  }
  return [...immutableImages][0];
}

export function validateProductionWorkflow(rootDir = process.cwd()) {
  const workflowPath = path.join(rootDir, PRODUCTION_WORKFLOW_PATH);
  if (!fs.existsSync(workflowPath)) {
    fail(`Missing ${PRODUCTION_WORKFLOW_PATH}`);
  }
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assertNoDirectGithubExpressionsInRunBlocks(
    workflow,
    PRODUCTION_WORKFLOW_PATH,
  );
  if (workflow.includes("fly config save")) {
    fail(
      `${PRODUCTION_WORKFLOW_PATH} must never trust a live Fly config as rollback input`,
    );
  }
  if (/\b(?:fly|flyctl) config show[^\n]*--json/.test(workflow)) {
    fail(
      `${PRODUCTION_WORKFLOW_PATH} must use pinned flyctl config-show JSON output without unsupported --json`,
    );
  }
  if (
    !workflow.includes(
      "      rollback_image:\n        description: Exact reviewed immutable digest required for every production target\n        required: true\n        type: string",
    )
  ) {
    fail(
      `${PRODUCTION_WORKFLOW_PATH} must require one exact immutable image input for every production target`,
    );
  }
  const requirements = [
    ["workflow_dispatch:", "must be manually dispatched"],
    ['test "$GITHUB_REF" = "refs/heads/main"', "must require reviewed main"],
    [
      "environment: production",
      "must use the protected production environment",
    ],
    ["attestations: read", "must read trusted artifact attestations"],
    ["actions: read", "must read exact source workflow results"],
    ["FLY_GATEWAY_DEPLOY_TOKEN", "must use an app-scoped gateway deploy token"],
    [
      "FLY_IMAGE_GEN_DEPLOY_TOKEN",
      "must use an app-scoped image-gen deploy token",
    ],
    [
      "FLY_STORAGE_PROXY_DEPLOY_TOKEN",
      "must use an app-scoped storage-proxy deploy token",
    ],
    [
      "FLY_PRODUCTION_READONLY_TOKEN",
      "must fail fast on unsettled live metadata before production approval",
    ],
    [
      'node scripts/validate-production-deployment.mjs --settled-live "$TARGET"',
      "must bind the early preflight to the selected target's settled identity",
    ],
    [
      '--verify-deployment-candidate "$TARGET" "$live_identity"',
      "must reject an older or non-canonical candidate before production approval",
    ],
    ["npm run deploy:gateway", "must use the canonical gateway deploy script"],
    [
      "npm run deploy:image-gen",
      "must use the canonical image-gen deploy script",
    ],
    [
      "npm run deploy:storage-proxy",
      "must use the canonical storage-proxy deploy script",
    ],
    [
      '--live gateway --expected-deployment-identity "deploy-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
      "must run strict exact-attempt gateway post-deploy drift checks",
    ],
    [
      '--live image-gen --expected-deployment-identity "deploy-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
      "must run strict exact-attempt image-gen post-deploy drift checks",
    ],
    [
      '--live storage-proxy --expected-deployment-identity "deploy-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
      "must run strict exact-attempt storage-proxy post-deploy drift checks",
    ],
    ["scripts/check-meta-callbacks.mjs", "must verify Meta callbacks"],
    ["rollback-image.txt", "must preserve rollback image metadata"],
    [
      "rollback-schema-phase.txt",
      "must preserve the manifest-bound image-gen rollback schema phase without granting recovery database access",
    ],
    [
      'rollback_schema_phase="$(jq -er \'.apps["image-gen"].databaseSchemaPhase\' deploy/production/apps.json)"',
      "must capture image-gen schema compatibility from the exact reviewed deployment manifest",
    ],
    [
      '--validate-reviewed-schema-phase image-gen "$rollback_image"',
      "must prove the captured image-gen rollback supports the manifest-bound schema phase",
    ],
    [
      '--validate-target-enabled "$TARGET"',
      "must reject production targets blocked by the manifest",
    ],
    [
      "--validate-rollback-image gateway",
      "must validate requested gateway rollback images",
    ],
    [
      "--validate-rollback-image image-gen",
      "must validate captured image-gen rollback images",
    ],
    [
      "--validate-rollback-image storage-proxy",
      "must validate captured storage-proxy rollback images",
    ],
    [
      '--validate-reviewed-image image-gen "$REVIEWED_IMAGE"',
      "must enforce the reviewed image-gen digest",
    ],
    [
      '--validate-reviewed-image storage-proxy "$REVIEWED_IMAGE"',
      "must enforce the reviewed storage-proxy digest",
    ],
    [
      '--reviewed-source-commit image-gen "$REVIEWED_IMAGE"',
      "must bind the image-gen artifact to its reviewed source commit",
    ],
    [
      '--reviewed-source-commit storage-proxy "$REVIEWED_IMAGE"',
      "must bind the storage-proxy artifact to its reviewed source commit",
    ],
    [
      "org.opencontainers.image.revision",
      "must verify immutable artifact source labels",
    ],
    [
      "io.leaderbot.schema.minimum",
      "must verify the reviewed image-gen minimum schema label",
    ],
    [
      "io.leaderbot.schema.maximum",
      "must verify the reviewed image-gen maximum schema label",
    ],
    [
      "/app/.leaderbot-artifact-kind",
      "must verify the immutable image-gen artifact marker",
    ],
    [
      '--reviewed-schema-minimum image-gen "$REVIEWED_IMAGE"',
      "must bind the image-gen artifact minimum schema to the manifest",
    ],
    [
      '--reviewed-schema-maximum image-gen "$REVIEWED_IMAGE"',
      "must bind the image-gen artifact maximum schema to the manifest",
    ],
    [
      '--verify-reviewed-ci "$TARGET" "$REVIEWED_IMAGE"',
      "must require green CI for the exact reviewed artifact source",
    ],
    [
      '--verify-source-ci "$GITHUB_SHA"',
      "must require green CI for the exact deployment source",
    ],
    [
      "gh attestation verify",
      "must cryptographically verify exact requested and rollback artifacts",
    ],
    [
      ".github/workflows/build-production-artifacts.yml",
      "must bind provenance to the trusted builder workflow",
    ],
    ["--source-digest", "must bind provenance to the reviewed source SHA"],
    ["--source-ref refs/heads/main", "must bind provenance to reviewed main"],
    [
      "--format json",
      "must request JSON before querying bridge attestation predicates",
    ],
    [
      "--reviewed-artifact-kind",
      "must enforce reviewed runtime and migration-bridge artifact roles",
    ],
    [
      "--validate-legacy-transition-rollback",
      "must narrowly validate the pre-expand bootstrap rollback exception",
    ],
    [
      "--allow-first-trusted-bootstrap-drift",
      "must narrowly reconcile the exact legacy image-gen predecessor",
    ],
    [
      "FLY_IMAGE_GEN_REVIEWED_IMAGE: ${{ inputs.rollback_image }}",
      "must pass the reviewed manifest input to the canonical image-gen deploy command",
    ],
    [
      "FLY_GATEWAY_REVIEWED_IMAGE: ${{ inputs.rollback_image }}",
      "must pass the exact allowlisted gateway image into its deploy step",
    ],
    [
      "FLY_STORAGE_PROXY_REVIEWED_IMAGE: ${{ inputs.rollback_image }}",
      "must pass the reviewed manifest input to the canonical storage-proxy deploy command",
    ],
    ["Restore captured gateway release", "must include gateway rollback"],
    ["Restore captured image-gen release", "must include image-gen rollback"],
    [
      "Restore captured storage-proxy release",
      "must include storage-proxy rollback",
    ],
    [
      '--verify-restored-release storage-proxy "$rollback_image" "$rollback_config"',
      "must verify the restored storage-proxy image and configuration",
    ],
    [
      '--reviewed-restore-config image-gen "$rollback_image" \\\n            "$rollback_identity")',
      "must resolve the exact identity-bound image-gen restore config",
    ],
    [
      '--reviewed-rollback-config storage-proxy "$rollback_image"',
      "must resolve the exact hash-reviewed storage-proxy rollback config",
    ],
    [
      'cp "$rollback_config_path" "$RUNNER_TEMP/leaderbot-release/before.fly.toml"',
      "must copy the reviewed rollback config into the durable rollback plan",
    ],
    [
      '--env "LEADERBOT_DEPLOYMENT_IDENTITY=deploy-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
      "must fence each non-gateway deployment to its exact workflow run",
    ],
    [
      '--env "LEADERBOT_DEPLOYMENT_IDENTITY=$prior_identity"',
      "must restore the exact captured predecessor identity",
    ],
    [
      "--verify-settled-baseline gateway",
      "must verify the captured gateway predecessor before mutation",
    ],
    [
      "--verify-settled-baseline image-gen",
      "must verify the captured image-gen predecessor before mutation",
    ],
    [
      "--verify-settled-baseline storage-proxy",
      "must verify the captured storage-proxy predecessor before mutation",
    ],
    [
      "/actions/workflows/reconcile-production-deployment.yml/dispatches",
      "must dispatch the protected recovery workflow after a failed deploy job",
    ],
    [
      '--config "$rollback_config"',
      "must restore the captured Fly configuration",
    ],
    [
      'printf \'%s\\n\' "v1" > "$RUNNER_TEMP/leaderbot-release/recovery-protocol.txt"',
      "must bind every durable rollback artifact to recovery protocol v1",
    ],
    ["FLYCTL_VERSION: 0.4.85", "must pin the reviewed flyctl version"],
    [
      "META_GRAPH_VERSION: v21.0",
      "must pin the reviewed Meta Graph API version",
    ],
    [
      "Probe production billing triggers before rollout",
      "must exercise the DML runtime against every billing trigger before rollout",
    ],
  ];
  for (const [needle, message] of requirements) {
    const matched =
      needle instanceof RegExp
        ? needle.test(workflow)
        : workflow.includes(needle);
    if (!matched) {
      fail(`${PRODUCTION_WORKFLOW_PATH} ${message}`);
    }
  }
  for (const stepName of [
    "Smoke-test storage-proxy",
    "Verify restored storage-proxy release",
  ]) {
    const steps = namedWorkflowStepBodies(workflow, stepName);
    const rollbackReadinessIsContractGated =
      stepName !== "Verify restored storage-proxy release" ||
      (steps[0]?.includes(
        '--reviewed-artifact-kind storage-proxy "$rollback_image"',
      ) === true &&
        steps[0]?.includes(
          'if [[ "$rollback_kind" != "legacy-bootstrap" ]]; then',
        ) === true);
    if (
      steps.length !== 1 ||
      !rollbackReadinessIsContractGated ||
      !referencesExactHttpUrl(
        steps[0],
        "https://leaderbot-storage-proxy.fly.dev/healthz",
      ) ||
      !referencesExactHttpUrl(
        steps[0],
        "https://leaderbot-storage-proxy.fly.dev/readyz",
      ) ||
      !steps[0].includes(
        "jq -e '.ok == true and .rateLimiter == \"shared_redis\"'",
      )
    ) {
      fail(
        `${PRODUCTION_WORKFLOW_PATH} must prove storage-proxy liveness and shared-limiter readiness after deploy and rollback`,
      );
    }
  }
  if (/^ {6}(?:FLY_API_TOKEN|META_APP_ID|META_APP_SECRET):/m.test(workflow)) {
    fail(
      `${PRODUCTION_WORKFLOW_PATH} must scope production secrets to only the steps that use them`,
    );
  }
  if (/\bfly\s+(?:m|machine|machines)\s+run\b/.test(workflow)) {
    fail(`${PRODUCTION_WORKFLOW_PATH} must not create detached Machines`);
  }
  if (
    occurrenceCount(workflow, "--live image-gen --predeploy") !== 0 ||
    occurrenceCount(workflow, "--live storage-proxy --predeploy") !== 0
  ) {
    fail(
      `${PRODUCTION_WORKFLOW_PATH} must verify non-gateway live state against the exact reviewed rollback config before upload and deploy`,
    );
  }
  const configSteps = namedWorkflowStepBodies(
    workflow,
    "Validate Fly configuration",
  );
  const expectedConfigSteps = [
    {
      token: "FLY_GATEWAY_DEPLOY_TOKEN",
      workingDirectory: null,
    },
    {
      token: "FLY_IMAGE_GEN_DEPLOY_TOKEN",
      workingDirectory: "apps/image-gen",
    },
    {
      token: "FLY_STORAGE_PROXY_DEPLOY_TOKEN",
      workingDirectory: "apps/image-gen/storage-proxy",
    },
  ];
  if (
    configSteps.length !== expectedConfigSteps.length ||
    !configSteps.every((step, index) => {
      const expected = expectedConfigSteps[index];
      return (
        step.includes(`FLY_API_TOKEN: \${{ secrets.${expected.token} }}`) &&
        step.includes("run: fly config validate --strict --config fly.toml") &&
        (expected.workingDirectory === null
          ? !step.includes("working-directory:")
          : step.includes(`working-directory: ${expected.workingDirectory}`))
      );
    })
  ) {
    fail(
      `${PRODUCTION_WORKFLOW_PATH} must authenticate each Fly config validation with its exact app-scoped token`,
    );
  }
  const [gatewayImageValidationStep] = namedWorkflowStepBodies(
    workflow,
    "Require an exact allowlisted image for gateway",
  );
  if (
    !gatewayImageValidationStep ||
    !gatewayImageValidationStep.includes("if: inputs.target == 'gateway'") ||
    !gatewayImageValidationStep.includes(
      "REVIEWED_IMAGE: ${{ inputs.rollback_image }}",
    ) ||
    !gatewayImageValidationStep.includes('test -n "$REVIEWED_IMAGE"') ||
    !gatewayImageValidationStep.includes(
      '--validate-rollback-image gateway "$REVIEWED_IMAGE"',
    ) ||
    gatewayImageValidationStep.includes("inputs.rollback_image != ''")
  ) {
    fail(
      `${PRODUCTION_WORKFLOW_PATH} must reject an empty, mutable, or non-allowlisted gateway image before deploy`,
    );
  }
  const validateJob = namedWorkflowJobBody(workflow, "validate");
  const targetGateIndex =
    validateJob?.indexOf('--validate-target-enabled "$TARGET"') ?? -1;
  const readonlySetupIndex =
    validateJob?.indexOf(
      "Install exact verified flyctl for metadata-only preflight",
    ) ?? -1;
  const readonlyPreflightIndex =
    validateJob?.indexOf(
      "Preflight settled production baseline before approval",
    ) ?? -1;
  const setupNodeIndex = validateJob?.indexOf("- name: Setup Node") ?? -1;
  const dependencyInstallIndex =
    validateJob?.indexOf("Install root dependencies") ?? -1;
  const [readonlyPreflightStep] = namedWorkflowStepBodies(
    workflow,
    "Preflight settled production baseline before approval",
  );
  if (
    !validateJob ||
    !validateJob.includes("environment: production-inspection") ||
    targetGateIndex < 0 ||
    readonlySetupIndex <= targetGateIndex ||
    readonlyPreflightIndex <= readonlySetupIndex ||
    setupNodeIndex <= readonlyPreflightIndex ||
    dependencyInstallIndex <= readonlyPreflightIndex ||
    !readonlyPreflightStep?.includes(
      "FLY_API_TOKEN: ${{ secrets.FLY_PRODUCTION_READONLY_TOKEN }}",
    ) ||
    !readonlyPreflightStep.includes("GITHUB_TOKEN: ${{ github.token }}") ||
    !readonlyPreflightStep.includes('--settled-live "$TARGET"') ||
    !readonlyPreflightStep.includes(
      '--verify-deployment-candidate "$TARGET" "$live_identity"',
    ) ||
    !readonlyPreflightStep.includes(
      '"deploy-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
    ) ||
    !readonlyPreflightStep.includes('--expected-source-sha "$GITHUB_SHA"') ||
    !readonlyPreflightStep.includes(
      "matches settled identity (none|deploy-[0-9]+-[0-9]+)",
    ) ||
    occurrenceCount(workflow, "FLY_PRODUCTION_READONLY_TOKEN") !== 1
  ) {
    fail(
      `${PRODUCTION_WORKFLOW_PATH} must run one metadata-only settled preflight in production-inspection before dependencies and production approval`,
    );
  }
  const [gatewayDeployStep] = namedWorkflowStepBodies(
    workflow,
    "Deploy reviewed gateway config",
  );
  if (
    !gatewayDeployStep ||
    !gatewayDeployStep.includes(
      "FLY_GATEWAY_REVIEWED_IMAGE: ${{ inputs.rollback_image }}",
    ) ||
    !gatewayDeployStep.includes('test -n "$FLY_GATEWAY_REVIEWED_IMAGE"') ||
    gatewayDeployStep.includes('--image "$FLY_GATEWAY_REVIEWED_IMAGE"') ||
    /if\s+\[\[\s+-n\s+"\$FLY_GATEWAY_REVIEWED_IMAGE"/.test(gatewayDeployStep)
  ) {
    fail(
      `${PRODUCTION_WORKFLOW_PATH} gateway deployment must delegate its one exact immutable image to the canonical guarded script`,
    );
  }
  for (const [stepName, minimumMinutes] of [
    ["Deploy reviewed image-gen config", 35],
    ["Restore captured image-gen release", 35],
  ]) {
    const timeout = namedWorkflowStepTimeout(workflow, stepName);
    if (timeout === null || timeout < minimumMinutes) {
      fail(
        `${PRODUCTION_WORKFLOW_PATH} ${stepName} must leave room for the 10m release command, 5m worker drain, rollout, and verification`,
      );
    }
  }
  const [billingTriggerProbeStep] = namedWorkflowStepBodies(
    workflow,
    "Probe production billing triggers before rollout",
  );
  const billingTriggerProbeIndex = workflow.indexOf(
    "      - name: Probe production billing triggers before rollout",
  );
  const imageGenDeployIndex = workflow.indexOf(
    "      - name: Deploy reviewed image-gen config",
  );
  const remoteCleanupArmIndex = billingTriggerProbeStep?.indexOf(
    "remote_uploaded=true",
  );
  const remoteUploadIndex = billingTriggerProbeStep?.indexOf(
    "timeout --signal=TERM 30s flyctl ssh sftp put",
  );
  if (
    !billingTriggerProbeStep ||
    billingTriggerProbeIndex < 0 ||
    imageGenDeployIndex <= billingTriggerProbeIndex ||
    namedWorkflowStepTimeout(
      workflow,
      "Probe production billing triggers before rollout",
    ) !== 5 ||
    !billingTriggerProbeStep.includes(
      "FLY_API_TOKEN: ${{ secrets.FLY_IMAGE_GEN_DEPLOY_TOKEN }}",
    ) ||
    !billingTriggerProbeStep.includes(
      'select(.state=="started" and .config.metadata.fly_process_group=="app")',
    ) ||
    !billingTriggerProbeStep.includes(
      'docker cp "$probe_container:/app/dist/billing-trigger-runtime-preflight.cjs"',
    ) ||
    !billingTriggerProbeStep.includes(
      "timeout --signal=TERM 30s flyctl ssh sftp put",
    ) ||
    remoteCleanupArmIndex === undefined ||
    remoteUploadIndex === undefined ||
    remoteCleanupArmIndex < 0 ||
    remoteUploadIndex < 0 ||
    remoteCleanupArmIndex >= remoteUploadIndex ||
    !billingTriggerProbeStep.includes(
      "timeout --signal=TERM 45s flyctl ssh console",
    ) ||
    !billingTriggerProbeStep.includes(
      "Billing trigger runtime preflight passed.",
    ) ||
    !billingTriggerProbeStep.includes(
      'test "$probe_output" = "Billing trigger runtime preflight passed."',
    ) ||
    !billingTriggerProbeStep.includes(
      'remote_probe="/tmp/leaderbot-billing-trigger-preflight-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}.cjs"',
    ) ||
    !billingTriggerProbeStep.includes('docker rm -f "$probe_container"') ||
    !billingTriggerProbeStep.includes("trap cleanup_probe EXIT") ||
    !billingTriggerProbeStep.includes('--command "test ! -e $remote_probe"')
  ) {
    fail(
      `${PRODUCTION_WORKFLOW_PATH} must run the exact bounded, reversible billing-trigger probe before image-gen rollout`,
    );
  }
  const [imageGenStartupDiagnosticStep] = namedWorkflowStepBodies(
    workflow,
    "Capture bounded image-gen startup diagnostics",
  );
  const imageGenStartupDiagnosticIndex = workflow.indexOf(
    "      - name: Capture bounded image-gen startup diagnostics",
  );
  const imageGenDiagnosticScopeIndex = workflow.indexOf(
    "      - name: Record image-gen candidate diagnostic scope",
  );
  const imageGenDiagnosticUploadIndex = workflow.indexOf(
    "      - name: Upload image-gen startup diagnostics",
  );
  const imageGenRestoreIndex = workflow.indexOf(
    "      - name: Restore captured image-gen release",
  );
  if (
    !imageGenStartupDiagnosticStep ||
    imageGenDiagnosticScopeIndex < 0 ||
    namedWorkflowStepTimeout(
      workflow,
      "Record image-gen candidate diagnostic scope",
    ) !== 1 ||
    imageGenStartupDiagnosticIndex < 0 ||
    imageGenStartupDiagnosticIndex <= imageGenDiagnosticScopeIndex ||
    imageGenDiagnosticUploadIndex <= imageGenStartupDiagnosticIndex ||
    imageGenRestoreIndex <= imageGenDiagnosticUploadIndex ||
    imageGenRestoreIndex <= imageGenStartupDiagnosticIndex ||
    namedWorkflowStepTimeout(
      workflow,
      "Capture bounded image-gen startup diagnostics",
    ) !== 2 ||
    !imageGenStartupDiagnosticStep.includes(
      "if: failure() && steps.deploy.outcome != 'skipped'",
    ) ||
    !imageGenStartupDiagnosticStep.includes(
      "FLY_API_TOKEN: ${{ secrets.FLY_IMAGE_GEN_DEPLOY_TOKEN }}",
    ) ||
    !imageGenStartupDiagnosticStep.includes(
      "timeout --signal=TERM 12s",
    ) ||
    !imageGenStartupDiagnosticStep.includes(
      "flyctl machine list --app leaderbot-fb-image-gen --json",
    ) ||
    !imageGenStartupDiagnosticStep.includes(
      '(.config.env.LEADERBOT_DEPLOYMENT_IDENTITY // "") ==',
    ) ||
    !imageGenStartupDiagnosticStep.includes('--machine "$machine_id"') ||
    !imageGenStartupDiagnosticStep.includes(
      'select($timestampSecond >= $startedAt)',
    ) ||
    !imageGenStartupDiagnosticStep.includes(
      'if ($parsedPayload | type) == "object"',
    ) ||
    !imageGenStartupDiagnosticStep.includes(
      'if ($payload.error | type) == "object"',
    ) ||
    !imageGenStartupDiagnosticStep.includes(
      'event: "machine_memory_failure"',
    ) ||
    !imageGenStartupDiagnosticStep.includes(
      'else "unclassified_start_failure"',
    ) ||
    !imageGenStartupDiagnosticStep.includes(
      'then "billing_outbox_mollie_api"',
    ) ||
    !imageGenStartupDiagnosticStep.includes(
      'then "notification_receiver_protocol"',
    ) ||
    !imageGenStartupDiagnosticStep.includes(
      'head -n 20 "$machine_events"',
    ) ||
    !imageGenStartupDiagnosticStep.includes(
      'head -n 120 "$filtered_events"',
    ) ||
    !imageGenStartupDiagnosticStep.includes(
      'printf \'%s\\n\' "$capture_status" > "$diagnostics_dir/capture-status.txt"',
    ) ||
    imageGenStartupDiagnosticStep.includes("message: $raw") ||
    imageGenStartupDiagnosticStep.includes("errorName:") ||
    imageGenStartupDiagnosticStep.includes("errorCode:") ||
    !workflow.includes(
      "name: image-gen-startup-diagnostics-${{ github.run_id }}-${{ github.run_attempt }}",
    )
  ) {
    fail(
      `${PRODUCTION_WORKFLOW_PATH} must capture only bounded, classified image-gen startup metadata before rollback`,
    );
  }
  const rollbackCaptureSteps = namedWorkflowStepBodies(
    workflow,
    "Record rollback release",
  );
  const imageRollbackCaptureStep = rollbackCaptureSteps[1];
  const capturedPhaseIndex =
    imageRollbackCaptureStep?.indexOf(
      'rollback_schema_phase="$(jq -er \'.apps["image-gen"].databaseSchemaPhase\' deploy/production/apps.json)"',
    ) ?? -1;
  const supportedPhaseIndex =
    imageRollbackCaptureStep?.indexOf(
      '--validate-reviewed-schema-phase image-gen "$rollback_image"',
    ) ?? -1;
  const phaseArtifactIndex =
    imageRollbackCaptureStep?.indexOf(
      'printf \'%s\\n\' "$rollback_schema_phase" > "$RUNNER_TEMP/leaderbot-release/rollback-schema-phase.txt"',
    ) ?? -1;
  const capturedIdentityIndex =
    imageRollbackCaptureStep?.indexOf(
      'rollback_identity="$(jq -er \'.env.LEADERBOT_DEPLOYMENT_IDENTITY // "none"\' <<<"$live_config")"',
    ) ?? -1;
  const restoreConfigIndex =
    imageRollbackCaptureStep?.indexOf(
      '--reviewed-restore-config image-gen "$rollback_image" \\\n            "$rollback_identity")',
    ) ?? -1;
  const restoredReleaseIndex =
    imageRollbackCaptureStep?.indexOf("--verify-restored-release image-gen") ??
    -1;
  if (
    rollbackCaptureSteps.length !== 3 ||
    rollbackCaptureSteps.some(
      (step) =>
        occurrenceCount(
          step,
          'printf \'%s\\n\' "v1" > "$RUNNER_TEMP/leaderbot-release/recovery-protocol.txt"',
        ) !== 1,
    ) ||
    capturedPhaseIndex < 0 ||
    supportedPhaseIndex <= capturedPhaseIndex ||
    phaseArtifactIndex <= supportedPhaseIndex ||
    capturedIdentityIndex <= phaseArtifactIndex ||
    restoreConfigIndex <= capturedIdentityIndex ||
    restoredReleaseIndex <= restoreConfigIndex
  ) {
    fail(
      `${PRODUCTION_WORKFLOW_PATH} must bind the durable image-gen rollback schema evidence to the reviewed manifest and rollback image before strict capture succeeds`,
    );
  }
  for (const target of ["gateway", "image-gen", "storage-proxy"]) {
    const configCommand =
      target === "image-gen"
        ? `--reviewed-restore-config ${target} "$rollback_image"`
        : `--reviewed-rollback-config ${target} "$rollback_image"`;
    const configIndex = workflow.indexOf(
      configCommand,
    );
    const verifyIndex = workflow.indexOf(
      `--verify-restored-release ${target} "$rollback_image"`,
      configIndex,
    );
    const predecessorIndex = workflow.indexOf(
      `--verify-settled-baseline ${target}`,
      verifyIndex,
    );
    const uploadIndex = workflow.indexOf(
      `Upload ${target} rollback plan`,
      predecessorIndex,
    );
    const candidateIndex = workflow.indexOf(
      `--verify-deployment-candidate ${target} "$prior_identity"`,
      predecessorIndex,
    );
    const deployIndex = workflow.indexOf(
      `Deploy reviewed ${target} config`,
      uploadIndex,
    );
    if (
      configIndex < 0 ||
      verifyIndex <= configIndex ||
      predecessorIndex <= verifyIndex ||
      candidateIndex <= predecessorIndex ||
      uploadIndex <= candidateIndex ||
      deployIndex <= uploadIndex
    ) {
      fail(
        `${PRODUCTION_WORKFLOW_PATH} must verify the exact reviewed ${target} rollback state, settled predecessor, and monotone candidate before durable upload or deploy`,
      );
    }
  }
  if (
    occurrenceCount(workflow, "--verify-deployment-candidate") !== 4 ||
    occurrenceCount(workflow, '--expected-source-sha "$GITHUB_SHA"') !== 4
  ) {
    fail(
      `${PRODUCTION_WORKFLOW_PATH} must check the exact in-progress source and monotone run ordering early and again for every target before mutation`,
    );
  }
  if (
    !workflow.includes("group: production-deploy-${{ inputs.target }}") ||
    !workflow.includes("cancel-in-progress: false") ||
    occurrenceCount(workflow, "queue: max") !== 1
  ) {
    fail(
      `${PRODUCTION_WORKFLOW_PATH} must serialize and retain every target deployment with its exact production lock`,
    );
  }
  if (workflow.includes("secrets: inherit")) {
    fail(
      `${PRODUCTION_WORKFLOW_PATH} production recovery dispatchers must never inherit caller secrets`,
    );
  }
  for (const target of ["gateway", "image-gen", "storage-proxy"]) {
    const deployJob = `deploy-${target}`;
    const recoveryJob = namedWorkflowJobBody(
      workflow,
      `queue-recovery-${target}`,
    );
    const expectedCondition = `if: \${{ always() && (failure() || cancelled()) && inputs.target == '${target}' && needs.validate.result == 'success' && (needs.${deployJob}.result == 'failure' || needs.${deployJob}.result == 'cancelled') }}`;
    if (
      !recoveryJob ||
      !recoveryJob.includes("needs:\n      - validate\n      - " + deployJob) ||
      !recoveryJob.includes(expectedCondition) ||
      !recoveryJob.includes("runs-on: ubuntu-latest") ||
      !recoveryJob.includes("timeout-minutes: 5") ||
      !recoveryJob.includes("actions: write") ||
      !recoveryJob.includes("contents: read") ||
      !recoveryJob.includes("GH_TOKEN: ${{ github.token }}") ||
      !recoveryJob.includes("RECOVERY_RUN_ID: ${{ github.run_id }}") ||
      !recoveryJob.includes(
        "RECOVERY_RUN_ATTEMPT: ${{ github.run_attempt }}",
      ) ||
      !recoveryJob.includes("RECOVERY_SOURCE_SHA: ${{ github.sha }}") ||
      !recoveryJob.includes(`RECOVERY_TARGET: ${target}`) ||
      !recoveryJob.includes('test "$GITHUB_REF" = "refs/heads/main"') ||
      !recoveryJob.includes(
        '.id==$runId and .run_attempt==$runAttempt and .status=="in_progress" and .head_branch=="main" and .head_sha==$sourceSha and .event=="workflow_dispatch" and .path==".github/workflows/deploy-production.yml"',
      ) ||
      !recoveryJob.includes(
        "[.artifacts[] | select(.expired==false and .name==$name)] | length==1",
      ) ||
      !recoveryJob.includes(
        '{ref:"main",inputs:{recovery_run_id:$runId,recovery_run_attempt:$runAttempt,target:$target}}',
      ) ||
      occurrenceCount(
        recoveryJob,
        "/actions/workflows/reconcile-production-deployment.yml/dispatches",
      ) !== 1 ||
      recoveryJob.includes("environment: production-recovery") ||
      recoveryJob.includes("secrets:") ||
      recoveryJob.includes("secrets.") ||
      recoveryJob.includes(
        "uses: ./.github/workflows/reconcile-production-deployment.yml",
      )
    ) {
      fail(
        `${PRODUCTION_WORKFLOW_PATH} must make one secretless exact-attempt ${target} recovery dispatch only when its validated deploy job fails`,
      );
    }
  }
  for (const [needle, expectedCount, message] of [
    [
      "actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1",
      4,
      "must pin all checkout steps",
    ],
    [
      /^\s*timeout-minutes: 100\s*$/gm,
      1,
      "must reserve time for gateway deploy and verified rollback",
    ],
    [
      /^\s*timeout-minutes: 150\s*$/gm,
      1,
      "must reserve time for image-gen deploy and verified rollback",
    ],
    [
      /^\s*timeout-minutes: 110\s*$/gm,
      1,
      "must reserve time for storage-proxy deploy and verified rollback",
    ],
    [
      /^\s*timeout-minutes: 10\s*$/gm,
      2,
      "must bound immutable artifact provenance checks",
    ],
    [
      /^\s*timeout-minutes: 3\s*$/gm,
      17,
      "must bound setup, rollback-plan, and diagnostic uploads",
    ],
    [
      /^\s*timeout-minutes: 2\s*$/gm,
      6,
      "must bound config, Meta, and startup diagnostic checks",
    ],
    [
      /^\s*timeout-minutes: 5\s*$/gm,
      12,
      "must bound drift, trigger probing, rollback capture, restore verification, and recovery dispatch",
    ],
    [
      /^\s*timeout-minutes: 6\s*$/gm,
      1,
      "must reserve a bounded image-gen post-rollback verification step",
    ],
    [/^\s*timeout-minutes: 4\s*$/gm, 3, "must bound smoke tests"],
    [
      /^\s*timeout-minutes: 20\s*$/gm,
      2,
      "must bound gateway and storage-proxy deployment steps",
    ],
    [
      /^\s*timeout-minutes: 35\s*$/gm,
      2,
      "must reserve bounded image-gen deploy and rollback steps",
    ],
    [
      /^\s*timeout-minutes: 15\s*$/gm,
      2,
      "must reserve bounded gateway and storage-proxy rollback steps",
    ],
    [
      'release_image="$(jq -er',
      3,
      "must fail closed when any rollback release is missing",
    ],
    [
      "--retry-all-errors",
      13,
      "must retry exact flyctl downloads and transient deploy and rollback smokes",
    ],
    [
      "--resolve-release-image gateway",
      1,
      "must resolve the gateway rollback digest",
    ],
    [
      "--resolve-release-image image-gen",
      1,
      "must resolve the image-gen rollback digest",
    ],
    [
      "--resolve-release-image storage-proxy",
      1,
      "must resolve the storage-proxy rollback digest",
    ],
    [
      "--validate-rollback-image gateway",
      3,
      "must validate gateway input, capture, and restore",
    ],
    [
      "--validate-rollback-image image-gen",
      2,
      "must validate image-gen capture and restore",
    ],
    [
      "--validate-rollback-image storage-proxy",
      2,
      "must validate storage-proxy capture and restore",
    ],
    [
      "--reviewed-source-commit image-gen",
      2,
      "must verify both requested and rollback image-gen provenance",
    ],
    [
      "--reviewed-source-commit storage-proxy",
      2,
      "must verify both requested and rollback storage-proxy provenance",
    ],
    [
      "docker image inspect",
      9,
      "must inspect every requested and rollback artifact label",
    ],
    [
      "gh attestation verify",
      6,
      "must verify every trusted requested, rollback, and bridge-material attestation",
    ],
    [
      "org.opencontainers.image.revision",
      4,
      "must compare every artifact's reviewed source label",
    ],
    [
      "io.leaderbot.schema.minimum",
      2,
      "must compare requested and rollback image-gen minimum schema labels",
    ],
    [
      "io.leaderbot.schema.maximum",
      2,
      "must compare requested and rollback image-gen maximum schema labels",
    ],
    ["fly auth docker", 2, "must authenticate each private image registry"],
    [
      "docker logout registry.fly.io",
      2,
      "must remove every private registry credential before deploy and upload",
    ],
    [
      "fly config save --app",
      0,
      "must not capture live rollback configurations",
    ],
    [
      '--config "$rollback_config"',
      6,
      "must validate and restore every captured configuration",
    ],
    [
      "/actions/workflows/reconcile-production-deployment.yml/dispatches",
      3,
      "must define exactly one secretless recovery dispatch per production target",
    ],
    [
      'cp "$rollback_config_path" "$RUNNER_TEMP/leaderbot-release/before.fly.toml"',
      3,
      "must copy every exact reviewed rollback config into its durable plan",
    ],
    [
      "rollback-identity.txt",
      11,
      "must capture and reuse one exact prior identity for every target",
    ],
    [
      "rollback-schema-phase.txt",
      1,
      "must capture exactly one metadata-only image-gen rollback schema phase artifact",
    ],
    [
      '--env "LEADERBOT_DEPLOYMENT_IDENTITY=$prior_identity"',
      3,
      "must restore the captured identity for every target",
    ],
    [
      "--verify-settled-baseline",
      3,
      "must prove each predecessor exactly once before durable upload",
    ],
  ]) {
    const actualCount =
      needle instanceof RegExp
        ? (workflow.match(needle) ?? []).length
        : occurrenceCount(workflow, needle);
    if (actualCount !== expectedCount) {
      fail(`${PRODUCTION_WORKFLOW_PATH} ${message}`);
    }
  }
  if (
    workflow.includes("LEADERBOT_DEPLOYMENT_IDENTITY=rollback-") ||
    workflow.includes('--expected-deployment-identity "rollback-') ||
    workflow.includes("(deploy|rollback)-[0-9]+-[0-9]+")
  ) {
    fail(
      `${PRODUCTION_WORKFLOW_PATH} must never invent or trust a rollback deployment identity`,
    );
  }
  for (const target of ["gateway", "image-gen", "storage-proxy"]) {
    if (
      !workflow.includes(
        `name: ${target}-rollback-\${{ github.run_id }}-\${{ github.run_attempt }}`,
      )
    ) {
      fail(
        `${PRODUCTION_WORKFLOW_PATH} must name the ${target} rollback plan with the exact run attempt`,
      );
    }
  }
}

function assertPinnedRedisCiService(workflow, workflowPath) {
  const redisServiceImages =
    workflow.match(/^\s+image:\s+redis:[^\s]+\s*$/gm) ?? [];
  if (
    redisServiceImages.length !== 1 ||
    occurrenceCount(workflow, `image: ${PINNED_REDIS_IMAGE}`) !== 1
  ) {
    fail(
      `${workflowPath} must use the same exact reviewed immutable Redis service digest`,
    );
  }
}

function validateRootValidationTriggers(rootDir) {
  const workflow = fs.readFileSync(
    path.join(rootDir, ROOT_VALIDATION_WORKFLOW_PATH),
    "utf8",
  );
  assertNoDirectGithubExpressionsInRunBlocks(
    workflow,
    ROOT_VALIDATION_WORKFLOW_PATH,
  );
  assertRequiredSourceCiTriggers(
    workflow,
    ROOT_VALIDATION_WORKFLOW_PATH,
    "validate",
  );
  assertPinnedRedisCiService(workflow, ROOT_VALIDATION_WORKFLOW_PATH);
  for (const pinnedAction of [
    "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6",
    "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6",
  ]) {
    if (!workflow.includes(pinnedAction)) {
      fail(
        `${ROOT_VALIDATION_WORKFLOW_PATH} must pin required source-CI actions`,
      );
    }
  }
}

function assertRequiredSourceCiTriggers(workflow, workflowPath, jobName) {
  const job = namedWorkflowJobBody(workflow, jobName);
  if (
    !workflow.includes("on:\n  pull_request:\n  push:\n    branches: [main]") ||
    occurrenceCount(workflow, "  pull_request:") !== 1 ||
    occurrenceCount(workflow, "  push:") !== 1 ||
    occurrenceCount(workflow, "    branches: [main]") !== 1 ||
    /\b(?:paths|paths-ignore):/.test(workflow) ||
    !job ||
    /^    if:/m.test(job)
  ) {
    fail(
      `${workflowPath} must run ${jobName} on every pull request and every main push without path filters`,
    );
  }
}

function validateStorageProxySafety(rootDir) {
  const configPath = path.join(
    rootDir,
    "apps/image-gen/storage-proxy/fly.toml",
  );
  const sourcePath = path.join(
    rootDir,
    "apps/image-gen/storage-proxy/index.ts",
  );
  const dockerfilePath = path.join(
    rootDir,
    "apps/image-gen/storage-proxy/Dockerfile",
  );
  const packagePath = path.join(rootDir, "apps/image-gen/package.json");
  const workflowPath = path.join(rootDir, ".github/workflows/image-gen-ci.yml");
  const config = fs.readFileSync(configPath, "utf8");
  const source = fs.readFileSync(sourcePath, "utf8");
  const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
  const imageGenPackage = readJson(packagePath);
  const workflow = fs.readFileSync(workflowPath, "utf8");
  if (
    allAssignments(config, "STORAGE_OPERATION_TIMEOUT_MS").length !== 1 ||
    allAssignments(config, "STORAGE_OPERATION_TIMEOUT_MS")[0] !== "60000"
  ) {
    fail("storage proxy must enforce the reviewed 60s R2 operation deadline");
  }
  for (const requiredSource of [
    "GetBucketLifecycleConfigurationCommand",
    "assertRequiredR2LifecycleRules",
    "await verifyRequiredR2LifecycleConfig(config)",
    "maxAttempts: 1",
  ]) {
    if (!source.includes(requiredSource)) {
      fail("storage proxy must fail closed on bounded R2 retention safety");
    }
  }
  for (const requiredSource of [
    "createSharedStorageRateLimitBackend",
    'app.get("/readyz"',
    'app.use("/v1/storage", authRateLimiter)',
    'app.use("/v1/storage", storageOperationRateLimiter)',
    "passOnStoreError: false",
  ]) {
    if (!source.includes(requiredSource)) {
      fail("storage proxy must fail closed on shared Redis rate limiting");
    }
  }
  for (const requiredWorkflow of [
    "storage-proxy install --frozen-lockfile",
    "apps/image-gen/storage-proxy/pnpm-workspace.yaml",
    "storage-proxy run typecheck:proxy",
    "storage-proxy run test:proxy",
    "storage-proxy run build:proxy",
    'image="leaderbot-storage-proxy-ci:${GITHUB_SHA}"',
    '--build-arg SOURCE_REVISION="$GITHUB_SHA"',
    "org.opencontainers.image.revision",
    "io.leaderbot.artifact.kind",
    "storage-proxy audit --audit-level=moderate",
    'RUN_STORAGE_RATE_LIMIT_REDIS_INTEGRATION: "1"',
    "STORAGE_RATE_LIMIT_REDIS_URL: redis://127.0.0.1:6379/13",
  ]) {
    if (!workflow.includes(requiredWorkflow)) {
      fail("image-gen CI must validate the independently locked storage proxy");
    }
  }
  const runtimeStage = dockerfile.split(" AS runtime", 2)[1] ?? "";
  if (!runtimeStage.includes('io.leaderbot.artifact.kind="runtime"')) {
    fail(
      "storage-proxy production image must declare the runtime artifact kind",
    );
  }
  assertPinnedNodeDockerfile(
    dockerfile,
    "apps/image-gen/storage-proxy/Dockerfile",
  );
  if (
    !workflow.includes(
      `io.leaderbot.base.node" }}' "$image")" = "${PINNED_NODE_BASE_IMAGE}"`,
    )
  ) {
    fail("image-gen CI must verify the exact storage-proxy Node base label");
  }
  if (
    imageGenPackage.scripts?.["storage-proxy:install"] !==
      "pnpm --dir storage-proxy install --frozen-lockfile" ||
    /pnpm --dir storage-proxy[^\n]*--ignore-workspace/.test(workflow)
  ) {
    fail(
      "storage-proxy installs and audits must apply its local workspace policy",
    );
  }
}

function validateImageGenMigrationCi(rootDir) {
  const imageCiPath = ".github/workflows/image-gen-ci.yml";
  const migrationCiPath = ".github/workflows/image-gen-migration-smoke.yml";
  const imageCi = fs.readFileSync(path.join(rootDir, imageCiPath), "utf8");
  const migrationCi = fs.readFileSync(
    path.join(rootDir, migrationCiPath),
    "utf8",
  );
  assertNoDirectGithubExpressionsInRunBlocks(imageCi, imageCiPath);
  assertNoDirectGithubExpressionsInRunBlocks(migrationCi, migrationCiPath);
  assertRequiredSourceCiTriggers(imageCi, imageCiPath, "checks");
  assertRequiredSourceCiTriggers(migrationCi, migrationCiPath, "migrate");
  assertPinnedRedisCiService(imageCi, imageCiPath);
  for (const required of [
    "explicit staged mode",
    "io.leaderbot.schema.minimum",
    "io.leaderbot.schema.maximum",
    "pnpm run db:migrate:test-bootstrap",
    "pnpm run lint:server",
    `io.leaderbot.base.node" }}' "$image")" = "${PINNED_NODE_BASE_IMAGE}"`,
    `io.leaderbot.runtime.ffmpeg" }}' "$image")" = "${PINNED_FFMPEG_VERSION}"`,
    'docker run --rm "$image" timeout -k 1s 1s true',
  ]) {
    if (!imageCi.includes(required)) {
      fail("image-gen CI must enforce the staged schema artifact contract");
    }
  }
  for (const pinnedAction of [
    "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6",
    "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4",
    "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38 # v6",
  ]) {
    if (!imageCi.includes(pinnedAction)) {
      fail("image-gen source CI must pin every third-party action");
    }
  }
  if (
    occurrenceCount(imageCi, `image: ${PINNED_MYSQL_IMAGE}`) !== 1 ||
    occurrenceCount(migrationCi, `image: ${PINNED_MYSQL_IMAGE}`) !== 1
  ) {
    fail("image-gen CI must use the exact reviewed MySQL service digest");
  }
  for (const required of [
    "pnpm run db:test-production-migrator",
    "LEADERBOT_PRODUCTION_MIGRATION_MODE: verify-contract",
    "LEADERBOT_PRODUCTION_MIGRATION_MODE=apply-empty-bootstrap",
    "LEADERBOT_PRODUCTION_MIGRATION_MODE=verify-contract",
    "io.leaderbot.schema.minimum",
    "io.leaderbot.schema.maximum",
  ]) {
    if (!migrationCi.includes(required)) {
      fail("migration smoke CI must exercise only explicit staged modes");
    }
  }
  const exactRuntimeMinimum = `io.leaderbot.schema.minimum" }}' "$image")" = "0016_expand"`;
  const exactRuntimeMaximum = `io.leaderbot.schema.maximum" }}' "$image")" = "0016_expand"`;
  for (const [source, sourcePath] of [
    [imageCi, imageCiPath],
    [migrationCi, migrationCiPath],
  ]) {
    if (
      occurrenceCount(source, exactRuntimeMinimum) !== 1 ||
      occurrenceCount(source, exactRuntimeMaximum) !== 1 ||
      source.includes(
        `io.leaderbot.schema.maximum" }}' "$image")" = "0017_contract"`,
      )
    ) {
      fail(
        `${sourcePath} must assert the exact 0016_expand runtime image range until 0017 writer fencing is reviewed`,
      );
    }
  }
}

function validateTrustedArtifactWorkflow(rootDir) {
  const workflow = fs.readFileSync(
    path.join(rootDir, TRUSTED_ARTIFACT_WORKFLOW_PATH),
    "utf8",
  );
  assertNoDirectGithubExpressionsInRunBlocks(
    workflow,
    TRUSTED_ARTIFACT_WORKFLOW_PATH,
  );
  const stepsStart = workflow.indexOf("\n    steps:");
  if (
    stepsStart < 0 ||
    workflow.slice(0, stepsStart).includes("FLY_API_TOKEN") ||
    occurrenceCount(workflow, "FLY_API_TOKEN:") !== 3 ||
    workflow.includes("&& secrets.FLY_STORAGE_PROXY_DEPLOY_TOKEN ||")
  ) {
    fail(
      `${TRUSTED_ARTIFACT_WORKFLOW_PATH} must scope each Fly token to its exact fail-closed registry-auth step`,
    );
  }
  for (const [needle, message] of [
    ["workflow_dispatch:", "must be manually dispatched"],
    ["gateway-runtime", "must offer the trusted gateway runtime target"],
    ['test "$GITHUB_REF" = "refs/heads/main"', "must require main"],
    ["environment: production", "must use the protected environment"],
    ["attestations: write", "must be allowed to publish attestations"],
    ["id-token: write", "must use GitHub OIDC signing"],
    [
      '--verify-source-ci "$GITHUB_SHA"',
      "must require green CI for the exact builder source",
    ],
    ["--metadata-file", "must capture the registry digest from the build"],
    ["--push", "must push the exact artifact it attests"],
    [
      "FLY_GATEWAY_DEPLOY_TOKEN",
      "must scope the gateway registry credential to its exact auth step",
    ],
    [
      'dockerfile="deploy/fly-gateway/Dockerfile"',
      "must build the pinned full gateway runtime",
    ],
    [
      `test "$node_base" = "${PINNED_GATEWAY_NODE_BASE_IMAGE}"`,
      "must verify the exact gateway Node base label",
    ],
    [
      'test "$rehearsal_interface" = "real-openclaw-v1"',
      "must verify the real OpenClaw rehearsal interface label",
    ],
    [
      "LEADERBOT_GATEWAY_STATE_REHEARSAL=1",
      "must exercise the provider-disabled gateway state mode",
    ],
    [
      "--network none --env LEADERBOT_GATEWAY_STATE_REHEARSAL=1",
      "must prove the gateway starts without any provider network path",
    ],
    [
      "rehearse-mounted-state.mjs --verify-running --expected-starts 2",
      "must prove the real gateway runtime survives a second start",
    ],
    [
      "MIGRATION_BRIDGE_BASE_IMAGE=$ARTIFACT_BASE_IMAGE",
      "must pin the bridge base",
    ],
    [
      "LEADERBOT_PRODUCTION_MIGRATION_MODE=verify-artifact",
      "must test the exact artifact-specific release check",
    ],
    [
      "/app/.leaderbot-artifact-kind",
      "must bind the release check to the immutable artifact marker",
    ],
    ["push-to-registry: false", "must retain attestations in GitHub"],
    [
      "https://leaderbot.live/attestations/gateway-runtime/v1",
      "must attest the exact gateway runtime contract",
    ],
    [
      "gateway-runtime.json",
      "must preserve signed gateway runtime evidence",
    ],
    [
      '--arg openClawVersion "2026.7.2-beta.7"',
      "must bind the gateway attestation to the exact OpenClaw runtime",
    ],
    [
      '--arg rehearsalInterface "real-openclaw-v1"',
      "must bind the gateway attestation to the real-runtime rehearsal interface",
    ],
    [
      "https://leaderbot.live/attestations/migration-bridge/v1",
      "must attest the exact bridge base material",
    ],
    ["provenance.json", "must preserve signed provenance evidence"],
    [
      `test "$node_base" = "${PINNED_NODE_BASE_IMAGE}"`,
      "must verify the exact Node base label on every runtime artifact",
    ],
    [
      `test "$ffmpeg_version" = "${PINNED_FFMPEG_VERSION}"`,
      "must verify the exact ffmpeg label on image-gen runtime artifacts",
    ],
    [
      "CREATE USER 'runtime_base'@'%' IDENTIFIED BY 'runtime_base'",
      "must create a DML-only base-schema verification principal",
    ],
    [
      "GRANT SELECT, INSERT, UPDATE, DELETE ON leaderbot_artifact_base.* TO 'runtime_base'@'%'",
      "must give the base-schema verification principal only runtime DML grants",
    ],
    [
      "CREATE USER 'runtime_expand'@'%' IDENTIFIED BY 'runtime_expand'",
      "must create a DML-only expand-schema verification principal",
    ],
    [
      "GRANT SELECT, INSERT, UPDATE, DELETE ON leaderbot_artifact_expand.* TO 'runtime_expand'@'%'",
      "must give the expand-schema verification principal only runtime DML grants",
    ],
    [
      "DATABASE_URL=mysql://runtime_${phase}:runtime_${phase}@127.0.0.1:3306/leaderbot_artifact_${phase}",
      "must verify the bridge with DML-only fixture credentials",
    ],
    [
      "DATABASE_URL=mysql://runtime_expand:runtime_expand@127.0.0.1:3306/leaderbot_artifact_expand",
      "must verify the runtime with DML-only fixture credentials",
    ],
    [
      "docker logout registry.fly.io",
      "must remove registry credentials before attestation and upload",
    ],
    [
      'docker run --rm "$ARTIFACT_IMAGE" timeout -k 1s 1s true',
      "must prove the artifact runtime supplies the bounded timeout command",
    ],
  ]) {
    if (!workflow.includes(needle)) {
      fail(`${TRUSTED_ARTIFACT_WORKFLOW_PATH} ${message}`);
    }
  }
  if (workflow.includes("pull_request:")) {
    fail(`${TRUSTED_ARTIFACT_WORKFLOW_PATH} must never build from a PR event`);
  }
  if (
    !/kind="runtime"\s+schema_minimum="0016_expand"\s+schema_maximum="0016_expand"/.test(
      workflow,
    ) ||
    workflow.includes('schema_maximum="0017_contract"')
  ) {
    fail(
      `${TRUSTED_ARTIFACT_WORKFLOW_PATH} runtime artifacts must remain exactly 0016_expand until the separately fenced 0017 release`,
    );
  }
  if (occurrenceCount(workflow, `image: ${PINNED_MYSQL_IMAGE}`) !== 1) {
    fail(
      `${TRUSTED_ARTIFACT_WORKFLOW_PATH} must use the exact reviewed MySQL service digest`,
    );
  }
  if (
    /DATABASE_URL=mysql:\/\/root:[^\n]*\n\s*--env LEADERBOT_PRODUCTION_MIGRATION_MODE=verify-artifact/.test(
      workflow,
    )
  ) {
    fail(
      `${TRUSTED_ARTIFACT_WORKFLOW_PATH} must not verify a production artifact with privileged root credentials`,
    );
  }
  if (
    occurrenceCount(workflow, "GRANT ") !== 2 ||
    occurrenceCount(workflow, "CREATE USER 'runtime_base'@'%'") !== 1 ||
    occurrenceCount(workflow, "CREATE USER 'runtime_expand'@'%'") !== 1 ||
    occurrenceCount(
      workflow,
      "GRANT SELECT, INSERT, UPDATE, DELETE ON leaderbot_artifact_base.* TO 'runtime_base'@'%'",
    ) !== 1 ||
    occurrenceCount(
      workflow,
      "GRANT SELECT, INSERT, UPDATE, DELETE ON leaderbot_artifact_expand.* TO 'runtime_expand'@'%'",
    ) !== 1
  ) {
    fail(
      `${TRUSTED_ARTIFACT_WORKFLOW_PATH} fixture principals must have only their exact runtime DML grants`,
    );
  }
  if (
    occurrenceCount(
      workflow,
      "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6 # v4",
    ) !== 3
  ) {
    fail(`${TRUSTED_ARTIFACT_WORKFLOW_PATH} must pin every attestation step`);
  }
  if (
    occurrenceCount(
      workflow,
      'docker run --rm "$ARTIFACT_IMAGE" timeout -k 1s 1s true',
    ) !== 2
  ) {
    fail(
      `${TRUSTED_ARTIFACT_WORKFLOW_PATH} must prove bounded timeout availability for both image-gen artifact kinds`,
    );
  }
}

function validateSchemaTransitionWorkflow(rootDir) {
  const workflowPath = path.join(rootDir, SCHEMA_TRANSITION_WORKFLOW_PATH);
  if (!fs.existsSync(workflowPath)) {
    fail(`Missing ${SCHEMA_TRANSITION_WORKFLOW_PATH}`);
  }
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assertNoDirectGithubExpressionsInRunBlocks(
    workflow,
    SCHEMA_TRANSITION_WORKFLOW_PATH,
  );
  for (const [needle, message] of [
    ["workflow_dispatch:", "must be manually dispatched"],
    ["recovery_run_id:", "must require an explicit prior run when resuming"],
    [
      "recovery_run_attempt:",
      "must require the exact prior attempt when resuming",
    ],
    [
      "RECOVERY_RUN_ID: ${{ inputs.recovery_run_id }}",
      "must pass resume input through a step environment variable",
    ],
    [
      "RECOVERY_RUN_ATTEMPT: ${{ inputs.recovery_run_attempt }}",
      "must pass resume attempt through a step environment variable",
    ],
    ['test "$GITHUB_REF" = "refs/heads/main"', "must require main"],
    ["environment: production", "must use the protected environment"],
    ["needs: preflight", "must finish live-state preflight before approval"],
    ["group: production-deploy-image-gen", "must freeze normal deploys"],
    ["cancel-in-progress: false", "must never cancel active schema work"],
    [
      "queue: max",
      "must retain every protected schema transition in the lock queue",
    ],
    ['= "expand_pending"', "must require the frozen transition state"],
    ["gh attestation verify", "must verify trusted bridge provenance"],
    ["--source-digest", "must bind the exact bridge source"],
    ["--signer-workflow", "must bind the trusted builder workflow"],
    [
      "--format json",
      "must request JSON before querying the bridge attestation predicate",
    ],
    ["--live image-gen", "must prove all app and worker Machines"],
    [
      "FLY_PRODUCTION_READONLY_TOKEN",
      "must inspect only production metadata before environment approval",
    ],
    [
      "--settled-live image-gen",
      "must refuse unresolved image deployment state before schema approval",
    ],
    [
      '[[ "$settled_identity" =~ ^deploy-[0-9]+-[0-9]+$ ]]',
      "must refuse bootstrap, rollback, and malformed identities before schema DDL",
    ],
    [
      '--expected-deployment-identity "$settled_identity"',
      "must bind bridge drift to the exact live deployment identity",
    ],
    [
      '--verify-settled-baseline image-gen "$settled_identity"',
      "must prove the live bridge came from a completed successful canonical deploy",
    ],
    [
      '--verify-source-ci "$GITHUB_SHA"',
      "must require green CI for the exact transition source",
    ],
    [
      "FLY_DATABASE_MIGRATION_TOKEN",
      "must use the database-app migration token only in protected steps",
    ],
    [
      "IMAGE_GEN_DATABASE_MIGRATION_URL",
      "must use a dedicated migration principal instead of the app runtime principal",
    ],
    [
      'u.hostname!=="127.0.0.1"||u.port!=="13306"',
      "must restrict the migration principal URL to the local protected tunnel",
    ],
    [
      "u.pathname!==`/${process.env.EXPECTED_DATABASE_NAME}`",
      "must bind the migration URL to the reviewed database name",
    ],
    [
      'flyctl proxy 13306:3306 "$DATABASE_MACHINE_PRIVATE_IP"',
      "must tunnel to the exact bound database Machine",
    ],
    [
      "--bind-addr 127.0.0.1 --quiet",
      "must expose the database tunnel only on localhost",
    ],
    [
      'test "$(jq -r \'[.[] | select(.state=="started")] | length\' <<<"$machines")" = 1',
      "must require exactly one started database Machine",
    ],
    [
      '.volume==$volume and .path=="/var/lib/mysql"',
      "must bind the database Machine to the exact reviewed volume and mount path",
    ],
    [
      "DATABASE_MACHINE_ID=$machine_id",
      "must retain the exact live database Machine identity in recovery evidence",
    ],
    [
      'attached_machine_id\' <<<"$volume")" = "$DATABASE_MACHINE_ID"',
      "must prove the snapshotted volume belongs to the bound database Machine",
    ],
    ["volumes snapshots create", "must create a fresh database snapshot"],
    [
      "snapshots-before.json",
      "must record the snapshot ids that existed before scheduling",
    ],
    [
      'scripts/select-fresh-fly-snapshot.mjs "$before" "$current" "$snapshot_started_at"',
      "must select exactly one new snapshot created after this run scheduled it",
    ],
    ["--snapshot-id", "must restore from the exact fresh snapshot"],
    [
      '\n          name="lbr_${GITHUB_RUN_ID}_${GITHUB_RUN_ATTEMPT}"',
      "must create a Fly-compatible exact run-and-attempt restore volume",
    ],
    [
      'test "${#name}" -le 30',
      "must refuse an overlong Fly restore-volume name before creation",
    ],
    [
      "restore-volume-name.txt",
      "must preserve the isolated restore name for failure cleanup",
    ],
    [
      "restore-volume-id.txt",
      "must preserve the isolated restore id for failure cleanup",
    ],
    [
      'test "$(jq -er \'.state\' <<<"$restored")" = "created"',
      "must wait for the restored volume to become ready",
    ],
    [
      'test "$(jq -r \'.encrypted\' <<<"$restored")" = "true"',
      "must verify the restored copy remains encrypted",
    ],
    [
      'test -z "$(jq -er \'.attached_machine_id // ""\' <<<"$restored")"',
      "must verify the restored volume is isolated before probing",
    ],
    ["--restart no", "must disable restart of the isolated probe"],
    ["--rm", "must request automatic removal of the isolated probe"],
    ["--detach", "must start the isolated probe without blocking the job"],
    [
      '--metadata "leaderbot_restore_probe=$GITHUB_RUN_ID"',
      "must mark only the bounded restore probe for cleanup",
    ],
    [
      '--metadata "leaderbot_restore_probe_attempt=$GITHUB_RUN_ATTEMPT"',
      "must bind the restore probe marker to the exact run attempt",
    ],
    [
      'machine_name="leaderbot-restore-probe-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
      "must reserve an exact run-and-attempt Machine name for restore probes",
    ],
    [
      'expected_volume_name="lbr_${GITHUB_RUN_ID}_${GITHUB_RUN_ATTEMPT}"',
      "must bind always-cleanup to the exact run-and-attempt restore volume",
    ],
    [
      'test "${#expected_volume_name}" -le 30',
      "must keep the exact restore-volume name within Fly's length limit",
    ],
    [
      'test "$volume_name" = "$expected_volume_name"',
      "must reject a restore-volume name from any other run",
    ],
    [
      'test "$machine_count" -le 10',
      "must cap probe Machine cleanup before any destroy operation",
    ],
    [
      "timeout --signal=TERM 8m flyctl ssh console",
      "must bound the remote restore verification and propagate its exit status",
    ],
    [
      "mysql-restore-check.sql",
      "must verify the restored MySQL data files with the client included in the pinned image",
    ],
    [
      "Remove isolated restore Machine and volume",
      "must always remove the isolated Machine before its volume",
    ],
    [
      "if: always()",
      "must run restore cleanup after failures and cancellation",
    ],
    [
      '.state|IN("started","stopped","suspended","created","failed")',
      "must allow exact restore-probe cleanup in every known removable state",
    ],
    ["machine destroy", "must remove the isolated restore Machine"],
    ["volumes destroy", "must remove the isolated restored copy"],
    [
      'test "$remaining" = 0',
      "must fail closed if the isolated restored copy remains",
    ],
    [
      '.id==$runId and .run_attempt==$runAttempt and .status=="completed" and (.head_sha|test("^[a-f0-9]{40}$")) and .head_branch=="main" and .event=="workflow_dispatch" and .path==".github/workflows/image-gen-schema-transition.yml"',
      "must bind resume evidence to the exact protected workflow run and source",
    ],
    [
      'if length==1 then .[0].id else error("recovery artifact mismatch") end',
      "must load exactly one unexpired recovery artifact",
    ],
    [
      '.database.app==$app and .database.volumeId==$volume and .database.name==$databaseName and (.database.machineId|type)=="string"',
      "must bind resumed recovery evidence to the reviewed database identity",
    ],
    [
      ".migrationManifestSha256==$migrationManifestSha and .schemaContractSha256==$schemaContractSha",
      "must bind resumed recovery evidence to the exact reviewed migration contracts",
    ],
    [
      'test "$(jq -er \'.digest\' <<<"$live_snapshot")" = "$snapshot_digest"',
      "must revalidate the live recovery snapshot digest before reuse",
    ],
    [
      "Upload immutable pre-expand recovery evidence before DDL",
      "must upload durable recovery evidence before changing the live schema",
    ],
    [
      "if-no-files-found: error",
      "must fail closed if recovery evidence is absent",
    ],
    [
      "/app/.leaderbot-artifact-kind",
      "must independently verify the bridge artifact marker",
    ],
    [
      "LEADERBOT_PRODUCTION_MIGRATION_MODE=apply-expand",
      "must apply only 0016 from the live bridge",
    ],
    [
      "LEADERBOT_PRODUCTION_MIGRATION_MODE=verify-expand-transition",
      "must fingerprint the final expanded schema",
    ],
    [
      "docker logout registry.fly.io",
      "must remove the private bridge registry credential",
    ],
  ]) {
    if (!workflow.includes(needle)) {
      fail(`${SCHEMA_TRANSITION_WORKFLOW_PATH} ${message}`);
    }
  }
  if (
    occurrenceCount(
      workflow,
      '.state|IN("started","stopped","suspended","created","failed")',
    ) !== 2
  ) {
    fail(
      `${SCHEMA_TRANSITION_WORKFLOW_PATH} must allow only exact restore-probe cleanup in known removable states`,
    );
  }
  if (
    occurrenceCount(
      workflow,
      '$volume!="" and ([.config.mounts[]? | select(.volume==$volume and .path=="/var/lib/mysql")] | length)==1 and (.config.mounts|length)==1',
    ) !== 2
  ) {
    fail(
      `${SCHEMA_TRANSITION_WORKFLOW_PATH} must bind failed-probe cleanup to the exact name, metadata, and single restore-volume mount tuple`,
    );
  }
  if (workflow.includes("apply-contract")) {
    fail(`${SCHEMA_TRANSITION_WORKFLOW_PATH} must keep 0017 blocked`);
  }
  if (/\b(?:fly|flyctl) config show[^\n]*--json/.test(workflow)) {
    fail(
      `${SCHEMA_TRANSITION_WORKFLOW_PATH} must use pinned flyctl config-show JSON output without unsupported --json`,
    );
  }
  const preflightJob = namedWorkflowJobBody(workflow, "preflight");
  const expandJob = namedWorkflowJobBody(workflow, "expand");
  const [preflightStep] = namedWorkflowStepBodies(
    workflow,
    "Preflight settled image-gen baseline before approval",
  );
  if (
    !preflightJob ||
    !preflightJob.includes("environment: production-inspection") ||
    preflightJob.includes("environment: production\n") ||
    !expandJob?.includes("needs: preflight") ||
    !preflightStep?.includes(
      "FLY_API_TOKEN: ${{ secrets.FLY_PRODUCTION_READONLY_TOKEN }}",
    ) ||
    !preflightStep.includes("GITHUB_TOKEN: ${{ github.token }}") ||
    !preflightStep.includes("--settled-live image-gen") ||
    occurrenceCount(workflow, "FLY_PRODUCTION_READONLY_TOKEN") !== 1
  ) {
    fail(
      `${SCHEMA_TRANSITION_WORKFLOW_PATH} must run one metadata-only settled preflight in production-inspection before production approval`,
    );
  }
  if (/volumes snapshots create[^\n]*--json/.test(workflow)) {
    fail(
      `${SCHEMA_TRANSITION_WORKFLOW_PATH} must discover the new snapshot from fresh list evidence instead of assuming create supports JSON`,
    );
  }
  if (occurrenceCount(workflow, "flyctl machine run") !== 1) {
    fail(
      `${SCHEMA_TRANSITION_WORKFLOW_PATH} may create only the isolated restore-probe Machine`,
    );
  }
  const [restoreProbeStep] = namedWorkflowStepBodies(
    workflow,
    "Prove the restored MySQL copy and remote command exit status",
  );
  for (const [required, message] of [
    ["flyctl machine run", "must create one isolated restore probe"],
    ["--restart no", "must disable restart of the isolated probe"],
    ["--rm", "must request automatic removal of the isolated probe"],
    ["--detach", "must start the isolated probe without blocking the job"],
    [
      "timeout --signal=TERM 8m flyctl ssh console",
      "must bound the remote restore verification and propagate its exit status",
    ],
    [
      'probe_b64="$(printf \'%s\' "$probe" | base64 --wrap=0)"',
      "must encode the fixed restore probe without shell-quoting ambiguity",
    ],
    [
      'probe_command="/bin/sh -lc',
      "must execute the restore probe through an explicit remote shell",
    ],
    [
      'decoded=\\$(printf %s $probe_b64 | base64 -d) || exit 70; exec /bin/sh -c',
      "must fail closed on decode errors and propagate the probe exit status",
    ],
    [
      '--command "$probe_command"',
      "must pass only the explicit shell command to flyctl SSH",
    ],
    [
      'printf "%s\\n" mysql_restore_probe_failed',
      "must emit a metadata-only failure marker for a failed restore probe",
    ],
    [
      "tail -n 120 /tmp/mysql-restore-probe.log",
      "must emit a bounded MySQL startup diagnostic before failing closed",
    ],
    [
      "chown mysql:root /var/lib/mysql",
      "must restore only the disposable mount-root ownership expected by the pinned MySQL image",
    ],
    [
      'test "$invalid" = 0',
      "must fail unless every restored base-table check reports status OK",
    ],
  ]) {
    if (!restoreProbeStep?.includes(required)) {
      fail(`${SCHEMA_TRANSITION_WORKFLOW_PATH} ${message}`);
    }
  }
  if (restoreProbeStep?.includes("chown -R")) {
    fail(
      `${SCHEMA_TRANSITION_WORKFLOW_PATH} must not recursively rewrite restored snapshot ownership`,
    );
  }
  if (
    namedWorkflowStepTimeout(
      workflow,
      "Prove the restored MySQL copy and remote command exit status",
    ) < 22
  ) {
    fail(
      `${SCHEMA_TRANSITION_WORKFLOW_PATH} must give the bounded Machine start, start poll, and 8m SSH probe enough outer time`,
    );
  }
  const snapshotBaselineIndex = workflow.indexOf("snapshots-before.json");
  const snapshotCreateIndex = workflow.indexOf("volumes snapshots create");
  const snapshotSelectorIndex = workflow.indexOf(
    "scripts/select-fresh-fly-snapshot.mjs",
  );
  if (
    snapshotBaselineIndex < 0 ||
    snapshotCreateIndex <= snapshotBaselineIndex ||
    snapshotSelectorIndex <= snapshotCreateIndex
  ) {
    fail(
      `${SCHEMA_TRANSITION_WORKFLOW_PATH} must capture the old snapshot ids before selecting the one fresh result`,
    );
  }
  const recoveryUploadIndex = workflow.indexOf(
    "Upload immutable pre-expand recovery evidence before DDL",
  );
  const applyExpandIndex = workflow.indexOf(
    "LEADERBOT_PRODUCTION_MIGRATION_MODE=apply-expand",
  );
  const strictBridgeIndex = workflow.indexOf(
    '--expected-deployment-identity "$settled_identity"',
  );
  const settledBridgeIndex = workflow.indexOf(
    '--verify-settled-baseline image-gen "$settled_identity"',
  );
  if (
    strictBridgeIndex < 0 ||
    settledBridgeIndex <= strictBridgeIndex ||
    recoveryUploadIndex < 0 ||
    applyExpandIndex < 0 ||
    recoveryUploadIndex > applyExpandIndex ||
    settledBridgeIndex > applyExpandIndex
  ) {
    fail(
      `${SCHEMA_TRANSITION_WORKFLOW_PATH} must durably upload verified snapshot evidence before any expand DDL`,
    );
  }
  const probeStepIndex = workflow.indexOf(
    "Prove the restored MySQL copy and remote command exit status",
  );
  const [databaseBindingStep] = namedWorkflowStepBodies(
    workflow,
    "Bind snapshot and tunnel to the one live database Machine",
  );
  const cleanupStepIndex = workflow.indexOf(
    "Remove isolated restore Machine and volume",
  );
  const cleanupMachineIndex = workflow.indexOf(
    "flyctl machine destroy",
    cleanupStepIndex,
  );
  const cleanupVolumeIndex = workflow.indexOf(
    "flyctl volumes destroy",
    cleanupStepIndex,
  );
  if (
    !databaseBindingStep?.includes(
      'select(.state=="started" and any(.config.mounts[]?; .volume==$volume and .path=="/var/lib/mysql"))',
    )
  ) {
    fail(
      `${SCHEMA_TRANSITION_WORKFLOW_PATH} must bind the database Machine to the exact reviewed volume and mount path`,
    );
  }
  if (
    probeStepIndex < 0 ||
    cleanupStepIndex <= probeStepIndex ||
    cleanupMachineIndex <= cleanupStepIndex ||
    cleanupVolumeIndex <= cleanupMachineIndex
  ) {
    fail(
      `${SCHEMA_TRANSITION_WORKFLOW_PATH} must clean the isolated probe Machine before its restored volume`,
    );
  }

  const selectorPath = path.join(rootDir, FRESH_SNAPSHOT_SELECTOR_PATH);
  if (!fs.existsSync(selectorPath)) {
    fail(`Missing ${FRESH_SNAPSHOT_SELECTOR_PATH}`);
  }
  const selector = fs.readFileSync(selectorPath, "utf8");
  for (const required of [
    "const beforeIds = new Set(",
    "!beforeIds.has(id) && createdAtMs >= startedAtMs",
    "if (candidates.length > 1)",
    "if (candidates.length === 0)",
    'snapshot.status !== "created"',
    "snapshot.digest",
  ]) {
    if (!selector.includes(required)) {
      fail(
        `${FRESH_SNAPSHOT_SELECTOR_PATH} must fail closed unless exactly one fresh completed snapshot with a digest exists`,
      );
    }
  }
}

function validateSchemaProbeCleanupWorkflow(rootDir) {
  const workflowPath = path.join(rootDir, SCHEMA_PROBE_CLEANUP_WORKFLOW_PATH);
  if (!fs.existsSync(workflowPath)) {
    fail(`Missing ${SCHEMA_PROBE_CLEANUP_WORKFLOW_PATH}`);
  }
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assertNoDirectGithubExpressionsInRunBlocks(
    workflow,
    SCHEMA_PROBE_CLEANUP_WORKFLOW_PATH,
  );
  for (const [needle, message] of [
    ["workflow_dispatch:", "must support reviewer-approved manual cleanup"],
    [
      "if: github.ref == 'refs/heads/main'",
      "must reject manual cleanup from every non-main ref before requesting production approval",
    ],
    [
      "group: production-deploy-image-gen",
      "must share the image-gen schema/deploy lock",
    ],
    ["cancel-in-progress: false", "must never cancel active schema work"],
    ["queue: max", "must retain independent cleanup in the shared lock queue"],
    ["timeout-minutes: 15", "must bound independent cleanup"],
    [
      '.state|IN("started","stopped","suspended","created","failed")',
      "must allow cleanup of only exact restore probes in known removable states",
    ],
    [
      "    environment: production\n",
      "must require reviewer-gated production approval before orphan cleanup",
    ],
    [
      "    environment: production-schema-cleanup\n",
      "must isolate the approved mutation in its protected-main reviewerless environment",
    ],
    [
      "FLY_DATABASE_MIGRATION_TOKEN",
      "must use the reviewer-gated database migration token",
    ],
    [
      'db_app="leaderbot-portal-mysql"',
      "must target only the reviewed production database app",
    ],
    [
      'test("^leaderbot-restore-probe-[0-9]+-[0-9]+$")',
      "must identify probe Machines only by the reserved exact run-attempt name",
    ],
    [
      '(.config.metadata.leaderbot_restore_probe_attempt // "")==$attempt',
      "must bind probe Machine metadata to the exact name-derived attempt",
    ],
    [
      '(.config.metadata.leaderbot_restore_probe // "")==$run and (.config.metadata.leaderbot_restore_probe_attempt // "")==$attempt and ([.config.mounts[]? | select(.volume==$volume and .path=="/var/lib/mysql")] | length)==1 and (.config.mounts|length)==1',
      "must bind cleanup to the exact name, metadata, and single restore-volume mount tuple",
    ],
    [
      '.volume==$volume and .path=="/var/lib/mysql"',
      "must bind each probe Machine to its one exact restore volume and mount",
    ],
    [
      'test "$machine_count" -le 10',
      "must fail closed on an unexpectedly broad Machine cleanup set",
    ],
    [
      '[[ "$machine_id" =~ ^[0-9a-f]{14}$ ]]',
      "must validate each exact Machine id before deletion",
    ],
    [
      'test("^lbr_[0-9]+_[0-9]+$")',
      "must identify restore volumes only by the exact protected-run name",
    ],
    [
      'volume_name="lbr_${probe_run}_${probe_attempt}"',
      "must derive the bounded restore-volume name from exact probe metadata",
    ],
    [
      'test "${#volume_name}" -le 30',
      "must refuse an overlong derived restore-volume name",
    ],
    [
      '(.attached_machine_id // "")==""',
      "must delete only unattached restore volumes",
    ],
    [
      '[[ "$volume_id" =~ ^vol_[a-z0-9]+$ ]]',
      "must validate each exact volume id before deletion",
    ],
    [
      'test "$matching_count" -le 10',
      "must fail closed on an unexpectedly broad cleanup set",
    ],
    ["for _ in $(seq 1 60)", "must bound cleanup polling"],
    ['test "$remaining" = 0', "must fail closed when a restore probe remains"],
  ]) {
    if (!workflow.includes(needle)) {
      fail(`${SCHEMA_PROBE_CLEANUP_WORKFLOW_PATH} ${message}`);
    }
  }
  if (
    occurrenceCount(
      workflow,
      'test("^leaderbot-restore-probe-[0-9]+-[0-9]+$")',
    ) !== 2
  ) {
    fail(
      `${SCHEMA_PROBE_CLEANUP_WORKFLOW_PATH} must identify probe Machines only by the reserved exact run-attempt name`,
    );
  }
  if (
    occurrenceCount(
      workflow,
      '.state|IN("started","stopped","suspended","created","failed")',
    ) !== 1
  ) {
    fail(
      `${SCHEMA_PROBE_CLEANUP_WORKFLOW_PATH} must allow cleanup of only exact restore probes in known removable states`,
    );
  }
  const approvalJob = namedWorkflowJobBody(workflow, "approve");
  const cleanupJob = namedWorkflowJobBody(workflow, "cleanup");
  const jobsIndex = workflow.search(/^jobs:\s*$/m);
  if (occurrenceCount(workflow, "if: github.ref == 'refs/heads/main'") !== 2) {
    fail(
      `${SCHEMA_PROBE_CLEANUP_WORKFLOW_PATH} must reject manual cleanup from every non-main ref before requesting production approval or entering the shared lock`,
    );
  }
  if (
    !approvalJob ||
    !approvalJob.includes("if: github.ref == 'refs/heads/main'") ||
    !/^    environment: production\s*$/m.test(approvalJob) ||
    !approvalJob.includes('test "$GITHUB_REF" = "refs/heads/main"') ||
    approvalJob.includes("concurrency:") ||
    approvalJob.includes("FLY_API_TOKEN") ||
    /\bflyctl\b/.test(approvalJob) ||
    !cleanupJob ||
    !cleanupJob.includes("needs: approve") ||
    !cleanupJob.includes("if: github.ref == 'refs/heads/main'") ||
    !/^    environment: production-schema-cleanup\s*$/m.test(cleanupJob) ||
    /^    environment: production\s*$/m.test(cleanupJob) ||
    !cleanupJob.includes(
      "concurrency:\n      group: production-deploy-image-gen\n      cancel-in-progress: false\n      queue: max",
    ) ||
    jobsIndex < 0 ||
    /^concurrency:\s*$/m.test(workflow.slice(0, jobsIndex))
  ) {
    fail(
      `${SCHEMA_PROBE_CLEANUP_WORKFLOW_PATH} must obtain protected production approval before its reviewerless protected-main mutation job enters the shared image-gen lock`,
    );
  }
  const destroyMachineIndex = workflow.indexOf("flyctl machine destroy");
  const destroyVolumeIndex = workflow.indexOf("flyctl volumes destroy");
  if (
    destroyMachineIndex < 0 ||
    destroyVolumeIndex <= destroyMachineIndex ||
    (workflow.match(/^    environment: production\s*$/gm) ?? []).length !== 1 ||
    (workflow.match(/^    environment: production-schema-cleanup\s*$/gm) ?? [])
      .length !== 1 ||
    occurrenceCount(workflow, "FLY_DATABASE_MIGRATION_TOKEN") !== 1 ||
    occurrenceCount(workflow, "workflow_dispatch:") !== 1 ||
    workflow.includes("environment: production-recovery") ||
    workflow.includes("FLY_DATABASE_RECOVERY_TOKEN") ||
    workflow.includes("workflow_run:") ||
    workflow.includes("schedule:") ||
    workflow.includes("pull_request:") ||
    workflow.includes("push:") ||
    workflow.includes("workflow_call:")
  ) {
    fail(
      `${SCHEMA_PROBE_CLEANUP_WORKFLOW_PATH} must run only as a reviewer-approved protected-main manual dispatch and remove exact probe Machines before exact unattached volumes`,
    );
  }
}

function validateProductionCompletionRecoveryWorkflow(rootDir) {
  const workflowPath = path.join(
    rootDir,
    PRODUCTION_COMPLETION_RECOVERY_WORKFLOW_PATH,
  );
  if (!fs.existsSync(workflowPath)) {
    fail(`Missing ${PRODUCTION_COMPLETION_RECOVERY_WORKFLOW_PATH}`);
  }
  const workflow = fs.readFileSync(workflowPath, "utf8");
  if (workflow.includes("secrets: inherit")) {
    fail(
      `${PRODUCTION_COMPLETION_RECOVERY_WORKFLOW_PATH} production recovery dispatchers must never inherit caller secrets`,
    );
  }
  assertNoDirectGithubExpressionsInRunBlocks(
    workflow,
    PRODUCTION_COMPLETION_RECOVERY_WORKFLOW_PATH,
  );
  for (const [needle, message] of [
    ["workflow_run:", "must inspect every completed production deploy"],
    [
      'workflows: ["Deploy production"]',
      "must run only after the canonical deploy workflow",
    ],
    ["types: [completed]", "must run after every completed deploy attempt"],
    [
      "github.event.workflow_run.event == 'workflow_dispatch' && github.event.workflow_run.head_branch == 'main' && github.event.workflow_run.conclusion != 'success'",
      "must ignore successful, non-manual, and non-main source runs",
    ],
    [
      "SOURCE_RUN_ID: ${{ github.event.workflow_run.id }}",
      "must pass the exact completed run through step env",
    ],
    [
      "SOURCE_RUN_ATTEMPT: ${{ github.event.workflow_run.run_attempt }}",
      "must pass the exact completed attempt through step env",
    ],
    [
      'gh api "/repos/$GITHUB_REPOSITORY/actions/runs/$SOURCE_RUN_ID/attempts/$SOURCE_RUN_ATTEMPT"',
      "must re-read the exact completed workflow attempt",
    ],
    [
      '.id==$runId and .run_attempt==$runAttempt and .status=="completed" and (.conclusion|IN("failure","cancelled","timed_out","action_required","stale","startup_failure")) and .head_branch=="main" and .event=="workflow_dispatch" and .path==".github/workflows/deploy-production.yml"',
      "must bind completion recovery to one explicit failed canonical deploy attempt",
    ],
    [
      'gateway="gateway-rollback-${SOURCE_RUN_ID}-${SOURCE_RUN_ATTEMPT}"',
      "must bind the gateway plan to the exact run attempt",
    ],
    [
      'image_gen="image-gen-rollback-${SOURCE_RUN_ID}-${SOURCE_RUN_ATTEMPT}"',
      "must bind the image-gen plan to the exact run attempt",
    ],
    [
      'storage_proxy="storage-proxy-rollback-${SOURCE_RUN_ID}-${SOURCE_RUN_ATTEMPT}"',
      "must bind the storage-proxy plan to the exact run attempt",
    ],
    [
      'if length==0 then null elif length==1 then .[0] else error("multiple production rollback plans") end',
      "must select at most one exact unexpired rollback plan",
    ],
    [
      'selected="$(jq -cr --argjson names',
      "must allow zero matching artifacts to produce the explicit no-op null",
    ],
    [
      'suffix="-rollback-${SOURCE_RUN_ID}-${SOURCE_RUN_ATTEMPT}"',
      "must derive the target only from the exact attempt suffix",
    ],
    [
      'target="${artifact_name%"$suffix"}"',
      "must strip only the exact run-attempt suffix",
    ],
    [
      '[[ "$target" =~ ^(gateway|image-gen|storage-proxy)$ ]]',
      "must reject every non-canonical recovered target",
    ],
    [
      'gh api "/repos/$GITHUB_REPOSITORY/actions/runs/$SOURCE_RUN_ID/attempts/$SOURCE_RUN_ATTEMPT/jobs?per_page=100"',
      "must inspect the exact attempt jobs before fallback dispatch",
    ],
    [
      'queue_name="Queue exact ${target} recovery after failed deploy"',
      "must bind deduplication to the exact target recovery dispatcher",
    ],
    [
      'if length==0 then "missing" elif length==1 then (.[0].conclusion // "missing") else error("duplicate recovery queue jobs") end',
      "must fail closed on duplicate target dispatch jobs",
    ],
    [
      'if test "$queue_result" = "success"; then',
      "must not dispatch a second recovery after the parent already queued one",
    ],
    [
      "actions: write",
      "must grant only the dispatch job permission to queue protected recovery",
    ],
    [
      "RECOVERY_RUN_ID: ${{ needs.inspect.outputs.run_id }}",
      "must forward only the inspected run id through step environment",
    ],
    [
      "RECOVERY_RUN_ATTEMPT: ${{ needs.inspect.outputs.run_attempt }}",
      "must forward only the inspected run attempt through step environment",
    ],
    [
      "RECOVERY_TARGET: ${{ needs.inspect.outputs.target }}",
      "must forward only the inspected target through step environment",
    ],
    [
      '.id==$runId and .run_attempt==$runAttempt and .status=="completed" and (.conclusion|IN("failure","cancelled","timed_out","action_required","stale","startup_failure")) and .head_branch=="main" and .event=="workflow_dispatch" and .path==".github/workflows/deploy-production.yml" and (.head_sha|test("^[a-f0-9]{40}$"))',
      "must revalidate exact trusted source metadata immediately before dispatch",
    ],
    [
      "[.artifacts[] | select(.expired==false and .name==$name)] | length==1",
      "must revalidate exactly one target-bound rollback plan before dispatch",
    ],
    [
      '{ref:"main",inputs:{recovery_run_id:$runId,recovery_run_attempt:$runAttempt,target:$target}}',
      "must dispatch only exact validated metadata to protected main",
    ],
    [
      "/actions/workflows/reconcile-production-deployment.yml/dispatches",
      "must dispatch the protected recovery authority",
    ],
  ]) {
    if (!workflow.includes(needle)) {
      fail(`${PRODUCTION_COMPLETION_RECOVERY_WORKFLOW_PATH} ${message}`);
    }
  }
  const completedSourceLifecycle =
    '.status=="completed" and (.conclusion|IN("failure","cancelled","timed_out","action_required","stale","startup_failure")) and .head_branch=="main" and .event=="workflow_dispatch" and .path==".github/workflows/deploy-production.yml"';
  if (
    occurrenceCount(workflow, completedSourceLifecycle) !== 2 ||
    occurrenceCount(workflow, 'and (.head_sha|test("^[a-f0-9]{40}$"))') !== 1 ||
    occurrenceCount(workflow, "workflow_run:") !== 1 ||
    workflow.includes("workflow_dispatch:") ||
    workflow.includes("workflow_call:") ||
    workflow.includes("repository_dispatch:") ||
    workflow.includes("pull_request:") ||
    workflow.includes("push:") ||
    workflow.includes("schedule:") ||
    workflow.includes("environment: production-recovery") ||
    workflow.includes("secrets:") ||
    /FLY_(?:API|GATEWAY|IMAGE_GEN|STORAGE_PROXY|DATABASE)_/.test(workflow) ||
    occurrenceCount(
      workflow,
      "/actions/workflows/reconcile-production-deployment.yml/dispatches",
    ) !== 1
  ) {
    fail(
      `${PRODUCTION_COMPLETION_RECOVERY_WORKFLOW_PATH} must remain a secretless exact-attempt selector with one protected recovery dispatch`,
    );
  }
}

function validateProductionReconciliationWorkflow(rootDir) {
  const workflowPath = path.join(
    rootDir,
    PRODUCTION_RECONCILIATION_WORKFLOW_PATH,
  );
  if (!fs.existsSync(workflowPath)) {
    fail(`Missing ${PRODUCTION_RECONCILIATION_WORKFLOW_PATH}`);
  }
  const workflow = fs.readFileSync(workflowPath, "utf8");
  assertNoDirectGithubExpressionsInRunBlocks(
    workflow,
    PRODUCTION_RECONCILIATION_WORKFLOW_PATH,
  );
  for (const [needle, message] of [
    [
      'test "$GITHUB_REF" = "refs/heads/main"',
      "must reject recovery workflow code from every non-main ref before selecting artifacts or exposing secrets",
    ],
    [
      "workflow_dispatch:",
      "must accept only an exact protected metadata dispatch",
    ],
    [
      "group: production-deploy-${{ inputs.target }}",
      "must queue every recovery behind the exact target deployment lock",
    ],
    [
      "cancel-in-progress: false",
      "must never cancel an active deployment or recovery",
    ],
    [
      "queue: max",
      "must retain every protected recovery in the target lock queue",
    ],
    [
      'gh api "/repos/$GITHUB_REPOSITORY/actions/runs/$RUN_ID/attempts/$RUN_ATTEMPT"',
      "must inspect the exact source workflow attempt",
    ],
    [
      '.id==$runId and .run_attempt==$runAttempt and .head_branch=="main" and .event=="workflow_dispatch" and .path==".github/workflows/deploy-production.yml" and (.head_sha|test("^[a-f0-9]{40}$")) and .status=="completed" and (.conclusion|IN("failure","cancelled","timed_out","action_required","stale","startup_failure"))',
      "must bind recovery to one exact completed failed canonical deploy attempt",
    ],
    [
      'artifact_name="${REQUESTED_TARGET}-rollback-${RUN_ID}-${RUN_ATTEMPT}"',
      "must bind the rollback plan to the exact target and run attempt",
    ],
    [
      'if length==1 then .[0].id else error("rollback plan mismatch") end',
      "must load exactly one unexpired rollback plan",
    ],
    [
      "environment: production-recovery",
      "must use the protected recovery environment",
    ],
    [
      "FLY_GATEWAY_RECOVERY_TOKEN",
      "must use the gateway recovery credential only for gateway",
    ],
    [
      "FLY_IMAGE_GEN_RECOVERY_TOKEN",
      "must use the image-gen recovery credential only for image-gen",
    ],
    [
      "FLY_STORAGE_PROXY_RECOVERY_TOKEN",
      "must use the storage-proxy recovery credential only for storage-proxy",
    ],
    [
      "ref: ${{ needs.inspect.outputs.source_sha }}",
      "must check out the exact interrupted source",
    ],
    [
      "ARTIFACT_ID: ${{ needs.inspect.outputs.artifact_id }}",
      "must download only the exact selected durable rollback artifact",
    ],
    [
      'test -f "$RUNNER_TEMP/leaderbot-recovery/rollback-image.txt"',
      "must require immutable rollback image evidence",
    ],
    [
      'test -f "$RUNNER_TEMP/leaderbot-recovery/before.fly.toml"',
      "must require the reviewed rollback configuration",
    ],
    [
      'test -f "$RUNNER_TEMP/leaderbot-recovery/rollback-identity.txt"',
      "must require the exact prior deployment identity",
    ],
    [
      'test -f "$RUNNER_TEMP/leaderbot-recovery/recovery-protocol.txt"',
      "must require a versioned recovery protocol before production credentials or mutation",
    ],
    [
      '--validate-recovery-protocol "$RUNNER_TEMP/leaderbot-recovery/recovery-protocol.txt"',
      "must reject every unknown or missing recovery protocol with the trusted controller",
    ],
    [
      "Checkout trusted recovery controller",
      "must check out current protected recovery code before interrupted source data",
    ],
    [
      "Bind trusted recovery controller",
      "must bind and hash the current dependency-free recovery controller",
    ],
    [
      'node "$RECOVERY_CONTROLLER"',
      "must execute only the trusted current recovery controller",
    ],
    [
      "--validate-target-enabled gateway",
      "must keep gateway recovery behind its explicit manifest gate",
    ],
    [
      "--validate-target-enabled image-gen",
      "must keep image-gen recovery behind its explicit manifest gate",
    ],
    [
      "--validate-target-enabled storage-proxy",
      "must keep storage-proxy recovery behind its explicit manifest gate",
    ],
    [
      "--validate-rollback-image gateway",
      "must revalidate the captured gateway image before recovery",
    ],
    [
      "--validate-rollback-image image-gen",
      "must revalidate the captured image-gen image before recovery",
    ],
    [
      "--validate-rollback-image storage-proxy",
      "must revalidate the captured storage-proxy image before recovery",
    ],
    [
      "--reviewed-rollback-config gateway",
      "must resolve the exact hash-reviewed gateway rollback config only after its manifest gate",
    ],
    [
      '--reviewed-restore-config image-gen "$rollback_image" "$prior_identity"',
      "must compare the image-gen artifact config to its exact identity-bound reviewed repository file",
    ],
    [
      "--reviewed-rollback-config storage-proxy",
      "must compare the storage-proxy artifact config to the reviewed repository file",
    ],
    [
      'cmp --silent "$expected_config" "$rollback_config"',
      "must reject altered rollback configuration artifacts",
    ],
    [
      '[[ "$prior_identity" =~ ^(none|deploy-[0-9]+-[0-9]+)$ ]]',
      "must accept only an exact run-and-attempt deployment identity",
    ],
    [
      '--verify-restored-release gateway "$rollback_image" "$rollback_config" --expected-deployment-identity "$prior_identity"',
      "must treat the exact captured gateway state as a no-op",
    ],
    [
      '--verify-restored-release image-gen "$rollback_image" "$rollback_config" --expected-deployment-identity "$prior_identity"',
      "must treat the exact captured image-gen state as a no-op",
    ],
    [
      '--verify-restored-release storage-proxy "$rollback_image" "$rollback_config" --expected-deployment-identity "$prior_identity"',
      "must treat the exact captured storage-proxy state as a no-op",
    ],
    [
      '--expected-deployment-identity "deploy-${RECOVERY_RUN_ID}-${RECOVERY_RUN_ATTEMPT}"',
      "must restore only a partial deployment from this exact interrupted attempt",
    ],
    [
      "--allow-interrupted-scale-count-drift",
      "must allow only started/count drift for the exact interrupted deployment",
    ],
    [
      '--captured-prior-image "$rollback_image"',
      "must bind every rolling recovery allowance to the captured and current reviewed image pair",
    ],
    [
      "--allow-reviewed-machine-images",
      "must allow mixed Machines only for the exact same-attempt rollback state",
    ],
    [
      '--allow-reviewed-machine-images --allow-scale-count-drift --captured-prior-identity "$prior_identity" --captured-prior-image "$rollback_image" --interrupted-deployment-identity "deploy-${RECOVERY_RUN_ID}-${RECOVERY_RUN_ATTEMPT}"',
      "must bind count-only recovery drift to the captured prior and interrupted identities",
    ],
    [
      'flyctl deploy --config "$rollback_config" --strategy rolling',
      "must restore reviewed image/config pairs directly with pinned flyctl",
    ],
    [
      '--env "LEADERBOT_DEPLOYMENT_IDENTITY=$prior_identity"',
      "must restore every release to its exact captured predecessor identity",
    ],
    [
      "FLY_RECOVERY_READONLY_TOKEN",
      "must classify successors with the dedicated metadata-only production-recovery credential",
    ],
    [
      "--prepare-successor-root",
      "must verify and materialize the exact approved successor commit without executing its code",
    ],
    [
      '--root-dir "$successor_root"',
      "must inspect successor state with the current trusted validator against the bounded successor root",
    ],
    [
      '--expected-source-sha "$successor_sha"',
      "must bind successor live state to the canonical successful run source",
    ],
    [
      "--require-current-reviewed-image",
      "must bind successor live state to its exact current reviewed image and config",
    ],
    [
      "--verify-restored-release gateway",
      "must verify the restored gateway image and configuration",
    ],
    [
      "--verify-restored-release image-gen",
      "must verify the restored image-gen image and configuration",
    ],
    [
      "--verify-restored-release storage-proxy",
      "must verify the restored storage-proxy image and configuration",
    ],
    ["/healthz", "must smoke-test every restored service"],
    [
      "rollback-identity.txt",
      "must retain the exact pre-deploy identity in the durable rollback plan",
    ],
    [
      'test -f "$RUNNER_TEMP/leaderbot-recovery/rollback-schema-phase.txt"',
      "must require the immutable manifest-bound image-gen schema evidence",
    ],
    [
      "Prove captured rollback schema compatibility evidence",
      "must prove rollback compatibility without a database credential",
    ],
    [
      'phase="$(cat "$RUNNER_TEMP/leaderbot-recovery/rollback-schema-phase.txt")"',
      "must read only the exact schema phase captured in the rollback artifact",
    ],
    [
      'test "$phase" = "$(jq -er \'.apps["image-gen"].databaseSchemaPhase\' deploy/production/apps.json)"',
      "must bind rollback schema evidence to the interrupted deployment manifest",
    ],
    [
      "--validate-reviewed-schema-phase image-gen",
      "must prove the rollback image supports the exact captured manifest phase",
    ],
    [
      "Remove exact image-gen recovery release-command Machines",
      "must remove only exact interrupted or captured-rollback release-command Machines before full-state recovery gates",
    ],
    [
      "--recovery-release-command-machines image-gen",
      "must classify temporary release-command Machines with the trusted validator",
    ],
    [
      "flyctl machine destroy --force --app leaderbot-fb-image-gen",
      "must force-destroy only validator-selected image-gen release-command Machines",
    ],
    [
      "--reviewed-scale-plan",
      "must derive recovery scale counts from the exact interrupted reviewed manifest",
    ],
  ]) {
    if (!workflow.includes(needle)) {
      fail(`${PRODUCTION_RECONCILIATION_WORKFLOW_PATH} ${message}`);
    }
  }
  if (/\b(?:fly|flyctl) config show[^\n]*--json/.test(workflow)) {
    fail(
      `${PRODUCTION_RECONCILIATION_WORKFLOW_PATH} must use pinned flyctl config-show JSON output without unsupported --json`,
    );
  }
  const forbiddenAutomaticRecoveryDatabaseCapabilities = [
    /FLY_DATABASE_[A-Z0-9_]*/,
    /IMAGE_GEN_DATABASE_[A-Z0-9_]*/,
    /\b[A-Z0-9_]*(?:DATABASE|MYSQL|DB)[A-Z0-9_]*_URL\b/,
    /\bLEADERBOT_PRODUCTION_MIGRATION_MODE\b/,
    /\b(?:fly|flyctl)\s+proxy\b/,
    /\b(?:fly|flyctl)\s+(?:logs|ssh|secrets|volumes?)\b/,
    /\b(?:mysql|mysqlsh)\b/,
    /scripts\/(?:run-production-migrations|migrate-production)\.mjs/,
  ];
  if (
    forbiddenAutomaticRecoveryDatabaseCapabilities.some((pattern) =>
      pattern.test(workflow),
    )
  ) {
    fail(
      `${PRODUCTION_RECONCILIATION_WORKFLOW_PATH} automatic no-review recovery must have no SQL, database URL, tunnel, content-read, or database-volume capability`,
    );
  }
  const allowedRecoverySecrets = [
    "FLY_GATEWAY_RECOVERY_TOKEN",
    "FLY_IMAGE_GEN_RECOVERY_TOKEN",
    "FLY_RECOVERY_READONLY_TOKEN",
    "FLY_STORAGE_PROXY_RECOVERY_TOKEN",
  ];
  const recoverySecretExpressions =
    workflow.match(/\$\{\{[^}\n]*\bsecrets\b[^}\n]*\}\}/g) ?? [];
  const parsedRecoverySecretExpressions = recoverySecretExpressions.map(
    (expression) =>
      expression.match(/^\$\{\{\s*secrets\.([A-Z][A-Z0-9_]+)\s*\}\}$/),
  );
  const referencedRecoverySecrets = [
    ...new Set(
      parsedRecoverySecretExpressions.filter(Boolean).map((match) => match[1]),
    ),
  ].sort();
  if (
    parsedRecoverySecretExpressions.some((match) => match === null) ||
    workflow.includes("workflow_call:") ||
    workflow.includes("secrets: inherit") ||
    JSON.stringify(referencedRecoverySecrets) !==
      JSON.stringify(allowedRecoverySecrets)
  ) {
    fail(
      `${PRODUCTION_RECONCILIATION_WORKFLOW_PATH} must expose no reusable caller-secret boundary and may reference only the four exact environment-scoped app-mutation and metadata-only recovery secrets`,
    );
  }
  const controllerCheckoutSteps = namedWorkflowStepBodies(
    workflow,
    "Checkout trusted recovery controller",
  );
  const controllerBindSteps = namedWorkflowStepBodies(
    workflow,
    "Bind trusted recovery controller",
  );
  const exactSourceCheckoutSteps = namedWorkflowStepBodies(
    workflow,
    "Checkout exact interrupted source",
  );
  if (
    controllerCheckoutSteps.length !== 3 ||
    controllerBindSteps.length !== 3 ||
    exactSourceCheckoutSteps.length !== 3 ||
    controllerCheckoutSteps.some(
      (step) =>
        !step.includes(
          "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6",
        ) ||
        !step.includes("ref: ${{ github.sha }}") ||
        !step.includes("path: leaderbot-recovery-controller-source") ||
        !step.includes("persist-credentials: false"),
    ) ||
    controllerBindSteps.some(
      (step) =>
        !step.includes("RECOVERY_CONTROLLER_SOURCE_SHA: ${{ github.sha }}") ||
        !step.includes(
          'test "$(git -C "$GITHUB_WORKSPACE/leaderbot-recovery-controller-source" rev-parse HEAD)" = "$RECOVERY_CONTROLLER_SOURCE_SHA"',
        ) ||
        !step.includes(
          'controller_source="$GITHUB_WORKSPACE/leaderbot-recovery-controller-source/scripts/validate-production-deployment.mjs"',
        ) ||
        !step.includes('install -m 0500 "$controller_source" "$controller"') ||
        !step.includes('sha256sum "$controller"') ||
        !step.includes('echo "RECOVERY_CONTROLLER=$controller"') ||
        !step.includes('echo "RECOVERY_CONTROLLER_SHA256=$controller_sha256"'),
    ) ||
    exactSourceCheckoutSteps.some(
      (step) =>
        !step.includes("ref: ${{ needs.inspect.outputs.source_sha }}") ||
        !step.includes("persist-credentials: false"),
    )
  ) {
    fail(
      `${PRODUCTION_RECONCILIATION_WORKFLOW_PATH} must bind current protected controller code before treating the interrupted checkout only as data`,
    );
  }
  for (const jobName of [
    "recover-gateway",
    "recover-image-gen",
    "recover-storage-proxy",
  ]) {
    const job = namedWorkflowJobBody(workflow, jobName);
    const controllerIndex =
      job?.indexOf("Checkout trusted recovery controller") ?? -1;
    const bindIndex = job?.indexOf("Bind trusted recovery controller") ?? -1;
    const interruptedIndex =
      job?.indexOf("Checkout exact interrupted source") ?? -1;
    const protocolIndex = job?.indexOf("--validate-recovery-protocol") ?? -1;
    const firstFlySecretIndex =
      job?.search(/FLY_API_TOKEN: \$\{\{ secrets\./) ?? -1;
    if (
      !job ||
      controllerIndex < 0 ||
      bindIndex <= controllerIndex ||
      interruptedIndex <= bindIndex ||
      protocolIndex <= interruptedIndex ||
      firstFlySecretIndex <= protocolIndex
    ) {
      fail(
        `${PRODUCTION_RECONCILIATION_WORKFLOW_PATH} must verify controller hash and recovery protocol before exposing any production credential for ${jobName}`,
      );
    }
  }
  for (const target of ["gateway", "image-gen", "storage-proxy"]) {
    const [step] = namedWorkflowStepBodies(
      workflow,
      `Restore and verify captured ${target} release`,
    );
    if (!step) {
      fail(
        `${PRODUCTION_RECONCILIATION_WORKFLOW_PATH} must define one bounded ${target} restore step`,
      );
    }
    const targetEnabledIndex = step.indexOf(
      `--validate-target-enabled ${target}`,
    );
    const configIndex = step.indexOf(
      target === "image-gen"
        ? `--reviewed-restore-config ${target} "$rollback_image" "$prior_identity"`
        : `--reviewed-rollback-config ${target}`,
    );
    const configCompareIndex = step.indexOf(
      'cmp --silent "$expected_config" "$rollback_config"',
    );
    const liveIdentityIndex = step.indexOf("live_identity=");
    const successorRaceIndex = step.indexOf(
      `Live ${target} identity changed after readonly successor`,
      liveIdentityIndex,
    );
    const priorNoopIndex = step.indexOf(
      `--verify-restored-release ${target} "$rollback_image" "$rollback_config" --expected-deployment-identity "$prior_identity"`,
      successorRaceIndex,
    );
    const staleCheckIndex = step.indexOf(
      `--live ${target} --predeploy --expected-deployment-identity "deploy-\${RECOVERY_RUN_ID}-\${RECOVERY_RUN_ATTEMPT}" --allow-interrupted-scale-count-drift --captured-prior-identity "$prior_identity" --captured-prior-image "$rollback_image"`,
    );
    const partialRollbackIndex = step.indexOf(
      `--verify-restored-release ${target} "$rollback_image" "$rollback_config" --expected-deployment-identity "$prior_identity" --allow-reviewed-machine-images --allow-scale-count-drift --captured-prior-identity "$prior_identity" --captured-prior-image "$rollback_image" --interrupted-deployment-identity "deploy-\${RECOVERY_RUN_ID}-\${RECOVERY_RUN_ATTEMPT}"`,
      staleCheckIndex,
    );
    const deployIndex = step.indexOf(
      'flyctl deploy --config "$rollback_config" --strategy rolling',
      partialRollbackIndex,
    );
    const scalePlanIndex = step.indexOf(
      `--reviewed-scale-plan ${target} --root-dir "$GITHUB_WORKSPACE"`,
      deployIndex,
    );
    const scaleApp = CANONICAL_TARGETS[target].app;
    const scaleMutationIndex = step.indexOf(
      `flyctl scale count "$count" --process-group "$process" --app ${scaleApp} --yes`,
      scalePlanIndex,
    );
    if (
      targetEnabledIndex < 0 ||
      configIndex <= targetEnabledIndex ||
      configCompareIndex <= configIndex ||
      liveIdentityIndex <= configCompareIndex ||
      successorRaceIndex <= liveIdentityIndex ||
      priorNoopIndex <= successorRaceIndex ||
      staleCheckIndex <= priorNoopIndex ||
      partialRollbackIndex <= staleCheckIndex ||
      deployIndex <= partialRollbackIndex ||
      scalePlanIndex <= deployIndex ||
      scaleMutationIndex <= scalePlanIndex
    ) {
      fail(
        `${PRODUCTION_RECONCILIATION_WORKFLOW_PATH} must fail closed on ${target} manifest, config, identity, and live-state drift before restoring`,
      );
    }
    if (
      target === "storage-proxy" &&
      (!referencesExactHttpUrl(
        step,
        "https://leaderbot-storage-proxy.fly.dev/healthz",
      ) ||
        !step.includes(
          '--reviewed-artifact-kind storage-proxy "$rollback_image"',
        ) ||
        !step.includes(
          'if [[ "$rollback_kind" != "legacy-bootstrap" ]]; then',
        ) ||
        !referencesExactHttpUrl(
          step,
          "https://leaderbot-storage-proxy.fly.dev/readyz",
        ) ||
        !step.includes(
          "jq -e '.ok == true and .rateLimiter == \"shared_redis\"'",
        ))
    ) {
      fail(
        `${PRODUCTION_RECONCILIATION_WORKFLOW_PATH} must prove restored storage-proxy liveness and shared-limiter readiness`,
      );
    }
    const expectedStepGate =
      target === "image-gen"
        ? "if: steps.successor.outputs.superseded != 'true' && steps.successor_recheck.outputs.superseded != 'true'"
        : "if: steps.successor.outputs.superseded != 'true'";
    if (!step.includes(expectedStepGate)) {
      fail(
        `${PRODUCTION_RECONCILIATION_WORKFLOW_PATH} must skip every ${target} mutation after a proven exact successor`,
      );
    }
    if (/\b(?:GH|GITHUB)_TOKEN:/.test(step)) {
      fail(
        `${PRODUCTION_RECONCILIATION_WORKFLOW_PATH} must not expose GitHub credentials to the ${target} app-mutation step`,
      );
    }
    if (
      /(?:\bnpm\s+(?:ci|install)\b|\bpnpm[^\n]*\binstall\b|\byarn\s+install\b)/.test(
        step,
      )
    ) {
      fail(
        `${PRODUCTION_RECONCILIATION_WORKFLOW_PATH} must install dependencies before exposing a recovery credential`,
      );
    }
  }
  if (
    occurrenceCount(
      workflow,
      '--reviewed-restore-config image-gen "$rollback_image" "$prior_identity"',
    ) !== 2
  ) {
    fail(
      `${PRODUCTION_RECONCILIATION_WORKFLOW_PATH} must bind both image-gen recovery mutations to the exact captured predecessor identity`,
    );
  }
  const [schemaEvidenceStep] = namedWorkflowStepBodies(
    workflow,
    "Prove captured rollback schema compatibility evidence",
  );
  if (
    !schemaEvidenceStep ||
    !schemaEvidenceStep.includes(
      "if: steps.successor.outputs.superseded != 'true'",
    ) ||
    !schemaEvidenceStep.includes("timeout-minutes: 2") ||
    !schemaEvidenceStep.includes(
      'rollback_image="$(cat "$RUNNER_TEMP/leaderbot-recovery/rollback-image.txt")"',
    ) ||
    !schemaEvidenceStep.includes(
      'phase="$(cat "$RUNNER_TEMP/leaderbot-recovery/rollback-schema-phase.txt")"',
    ) ||
    !schemaEvidenceStep.includes(
      '[[ "$phase" =~ ^(0015_base|0016_expand)$ ]]',
    ) ||
    !schemaEvidenceStep.includes(
      'test "$phase" = "$(jq -er \'.apps["image-gen"].databaseSchemaPhase\' deploy/production/apps.json)"',
    ) ||
    !schemaEvidenceStep.includes(
      '--validate-reviewed-schema-phase image-gen "$rollback_image"',
    ) ||
    schemaEvidenceStep.includes("env:") ||
    /\$\{\{\s*secrets\./.test(schemaEvidenceStep) ||
    /(?:\bnpm\s+(?:ci|install)\b|\bpnpm[^\n]*\binstall\b|\byarn\s+install\b)/.test(
      schemaEvidenceStep,
    )
  ) {
    fail(
      `${PRODUCTION_RECONCILIATION_WORKFLOW_PATH} must prove the exact captured schema phase from immutable artifact and interrupted manifest metadata without any secret or database access`,
    );
  }
  const successorSpecs = [
    {
      target: "gateway",
      stepName: "Classify gateway successor from exact approved source",
      ready: false,
    },
    {
      target: "image-gen",
      stepName:
        "Classify image-gen successor before schema compatibility proof",
      ready: true,
    },
    {
      target: "image-gen",
      stepName: "Recheck image-gen successor before recovery mutation",
      ready: true,
      recheck: true,
    },
    {
      target: "storage-proxy",
      stepName: "Classify storage-proxy successor from exact approved source",
      ready: true,
    },
  ];
  for (const { target, stepName, ready, recheck } of successorSpecs) {
    const [step] = namedWorkflowStepBodies(workflow, stepName);
    if (
      step &&
      /(?:\bnpm\s+(?:ci|install)\b|\bpnpm[^\n]*\binstall\b|\byarn\s+install\b)/.test(
        step,
      )
    ) {
      fail(
        `${PRODUCTION_RECONCILIATION_WORKFLOW_PATH} must install dependencies before exposing a recovery credential`,
      );
    }
    if (
      !step ||
      !step.includes(
        "FLY_API_TOKEN: ${{ secrets.FLY_RECOVERY_READONLY_TOKEN }}",
      ) ||
      !step.includes("GITHUB_TOKEN: ${{ github.token }}") ||
      !step.includes(
        `--prepare-successor-root ${target} "$live_identity" "$interrupted_identity" "$successor_root"`,
      ) ||
      !step.includes(
        'successor_sha="$(jq -er \'.sourceSha\' <<<"$successor")"',
      ) ||
      !step.includes(`--settled-live ${target}`) ||
      !step.includes('--root-dir "$successor_root"') ||
      !step.includes('--expected-source-sha "$successor_sha"') ||
      !step.includes("--require-current-reviewed-image") ||
      !referencesExactHttpUrl(
        step,
        `https://${CANONICAL_TARGETS[target].app}.fly.dev/healthz`,
      ) ||
      (ready &&
        !referencesExactHttpUrl(
          step,
          `https://${CANONICAL_TARGETS[target].app}.fly.dev/readyz`,
        )) ||
      (target === "storage-proxy" &&
        !step.includes(
          "jq -e '.ok == true and .rateLimiter == \"shared_redis\"'",
        )) ||
      !step.includes('echo "superseded=true" >> "$GITHUB_OUTPUT"') ||
      (recheck &&
        !step.includes("if: steps.successor.outputs.superseded != 'true'")) ||
      /FLY_(?:GATEWAY|IMAGE_GEN|STORAGE_PROXY)_RECOVERY_TOKEN/.test(step) ||
      /\bflyctl\s+(?!config\s+show\b)/.test(step) ||
      /\b(?:node|bash|sh)\s+["']?\$successor_root/.test(step) ||
      /\bcd\s+["']?\$successor_root/.test(step)
    ) {
      fail(
        `${PRODUCTION_RECONCILIATION_WORKFLOW_PATH} must validate ${target} successors from their exact approved source with only metadata credentials`,
      );
    }
  }
  const [successorStep] = namedWorkflowStepBodies(
    workflow,
    "Classify image-gen successor before schema compatibility proof",
  );
  const [successorRecheckStep] = namedWorkflowStepBodies(
    workflow,
    "Recheck image-gen successor before recovery mutation",
  );
  const imageDownloadIndex = workflow.indexOf(
    "Download exact durable rollback plan",
    workflow.indexOf("recover-image-gen:"),
  );
  const successorIndex = workflow.indexOf(
    "Classify image-gen successor before schema compatibility proof",
    imageDownloadIndex,
  );
  const schemaEvidenceIndex = workflow.indexOf(
    "Prove captured rollback schema compatibility evidence",
    successorIndex,
  );
  const successorRecheckIndex = workflow.indexOf(
    "Recheck image-gen successor before recovery mutation",
    schemaEvidenceIndex,
  );
  const releaseMachineCleanupIndex = workflow.indexOf(
    "Remove exact image-gen recovery release-command Machines",
    successorRecheckIndex,
  );
  const imageRestoreIndex = workflow.indexOf(
    "Restore and verify captured image-gen release",
    releaseMachineCleanupIndex,
  );
  if (
    !successorStep ||
    !successorRecheckStep ||
    imageDownloadIndex < 0 ||
    successorIndex <= imageDownloadIndex ||
    schemaEvidenceIndex <= successorIndex ||
    successorRecheckIndex <= schemaEvidenceIndex ||
    releaseMachineCleanupIndex <= successorRecheckIndex ||
    imageRestoreIndex <= releaseMachineCleanupIndex ||
    !schemaEvidenceStep.includes(
      "if: steps.successor.outputs.superseded != 'true'",
    ) ||
    !successorRecheckStep.includes(
      "if: steps.successor.outputs.superseded != 'true'",
    ) ||
    !namedWorkflowStepBodies(
      workflow,
      "Restore and verify captured image-gen release",
    )[0]?.includes(
      "if: steps.successor.outputs.superseded != 'true' && steps.successor_recheck.outputs.superseded != 'true'",
    )
  ) {
    fail(
      `${PRODUCTION_RECONCILIATION_WORKFLOW_PATH} must classify and recheck a true newer image-gen successor around the metadata-only schema compatibility proof and immediately before mutation`,
    );
  }
  const [releaseMachineCleanupStep] = namedWorkflowStepBodies(
    workflow,
    "Remove exact image-gen recovery release-command Machines",
  );
  if (
    !releaseMachineCleanupStep ||
    !releaseMachineCleanupStep.includes(
      "if: steps.successor.outputs.superseded != 'true' && steps.successor_recheck.outputs.superseded != 'true'",
    ) ||
    namedWorkflowStepTimeout(
      workflow,
      "Remove exact image-gen recovery release-command Machines",
    ) < 10 ||
    !releaseMachineCleanupStep.includes(
      "FLY_API_TOKEN: ${{ secrets.FLY_IMAGE_GEN_RECOVERY_TOKEN }}",
    ) ||
    occurrenceCount(
      releaseMachineCleanupStep,
      '--recovery-release-command-machines image-gen --interrupted-deployment-identity "$interrupted_identity" --captured-prior-identity "$prior_identity" --captured-prior-image "$rollback_image"',
    ) !== 3 ||
    !releaseMachineCleanupStep.includes(
      'type=="array" and length<=2 and all(.[]; (.id|test("^[a-f0-9]{14}$")) and (.needsDestroy|type=="boolean"))',
    ) ||
    !releaseMachineCleanupStep.includes(
      'flyctl machine destroy --force --app leaderbot-fb-image-gen "$machine_id"',
    ) ||
    !releaseMachineCleanupStep.includes("if ! flyctl machine destroy") ||
    !releaseMachineCleanupStep.includes(
      'after_destroy_error="$(node "$RECOVERY_CONTROLLER"',
    ) ||
    !releaseMachineCleanupStep.includes(
      'test "$(jq -er \'.[0].needsDestroy\' <<<"$remaining_target")" = "false"',
    ) ||
    !releaseMachineCleanupStep.includes("for _ in {1..60}; do") ||
    occurrenceCount(
      releaseMachineCleanupStep,
      "flyctl config show --app leaderbot-fb-image-gen",
    ) !== 2 ||
    !releaseMachineCleanupStep.includes(
      'cmp --silent "$expected_config" "$rollback_config"',
    ) ||
    /\b(?:GH|GITHUB)_TOKEN:/.test(releaseMachineCleanupStep) ||
    /(?:\bnpm\s+(?:ci|install)\b|\bpnpm[^\n]*\binstall\b|\byarn\s+install\b)/.test(
      releaseMachineCleanupStep,
    )
  ) {
    fail(
      `${PRODUCTION_RECONCILIATION_WORKFLOW_PATH} must revalidate and remove at most one exact release-command Machine per recovery tuple before full-state mutation gates`,
    );
  }
  const imageRecoveryJob = namedWorkflowJobBody(workflow, "recover-image-gen");
  const imageRecoveryTimeout = Number(
    imageRecoveryJob?.match(/^    timeout-minutes:\s*([0-9]+)\s*$/m)?.[1] ?? 0,
  );
  if (
    !imageRecoveryJob ||
    imageRecoveryTimeout < 110 ||
    namedWorkflowStepTimeout(
      workflow,
      "Restore and verify captured image-gen release",
    ) < 45
  ) {
    fail(
      `${PRODUCTION_RECONCILIATION_WORKFLOW_PATH} must leave enough time for schema compatibility proof, release command, worker drain, restore, and verification`,
    );
  }
  if (
    occurrenceCount(workflow, "environment: production-recovery") !== 3 ||
    occurrenceCount(
      workflow,
      "ref: ${{ needs.inspect.outputs.source_sha }}",
    ) !== 3 ||
    occurrenceCount(
      workflow,
      "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6",
    ) !== 6 ||
    occurrenceCount(workflow, "run: npm ci") !== 0 ||
    occurrenceCount(
      workflow,
      'flyctl deploy --config "$rollback_config" --strategy rolling',
    ) !== 3 ||
    occurrenceCount(workflow, "--allow-reviewed-machine-images") !== 3 ||
    occurrenceCount(workflow, "--allow-scale-count-drift") !== 3 ||
    occurrenceCount(workflow, "--allow-interrupted-scale-count-drift") !== 3 ||
    occurrenceCount(workflow, "--captured-prior-identity") !== 9 ||
    occurrenceCount(workflow, "--captured-prior-image") !== 9 ||
    occurrenceCount(workflow, "--interrupted-deployment-identity") !== 6 ||
    occurrenceCount(workflow, "--recovery-release-command-machines") !== 3 ||
    occurrenceCount(workflow, "FLY_RECOVERY_READONLY_TOKEN") !== 4 ||
    occurrenceCount(workflow, "GITHUB_TOKEN: ${{ github.token }}") !== 4 ||
    occurrenceCount(workflow, "--prepare-successor-root") !== 4 ||
    occurrenceCount(workflow, '--root-dir "$successor_root"') !== 4 ||
    occurrenceCount(workflow, '--expected-source-sha "$successor_sha"') !== 4 ||
    occurrenceCount(workflow, "--require-current-reviewed-image") !== 4 ||
    occurrenceCount(workflow, "--verify-settled-baseline") !== 0 ||
    occurrenceCount(workflow, "--settled-live") !== 4 ||
    occurrenceCount(workflow, 'node "$RECOVERY_CONTROLLER"') !== 43 ||
    occurrenceCount(workflow, '--root-dir "$GITHUB_WORKSPACE"') !== 39 ||
    occurrenceCount(workflow, "--validate-recovery-protocol") !== 3 ||
    occurrenceCount(workflow, "--reviewed-scale-plan") !== 3 ||
    occurrenceCount(workflow, 'flyctl scale count "$count"') !== 3 ||
    occurrenceCount(
      workflow,
      'test "$(sha256sum "$RECOVERY_CONTROLLER" | cut -d \' \' -f1)" = "$RECOVERY_CONTROLLER_SHA256"',
    ) !== 11 ||
    /node scripts\/validate-production-deployment\.mjs/.test(workflow) ||
    /flyctl scale count [0-9]+/.test(workflow) ||
    occurrenceCount(
      workflow,
      'cmp --silent "$expected_config" "$rollback_config"',
    ) !== 4 ||
    occurrenceCount(
      workflow,
      '--env "LEADERBOT_DEPLOYMENT_IDENTITY=$prior_identity"',
    ) !== 3 ||
    workflow.includes("LEADERBOT_DEPLOYMENT_IDENTITY=rollback-") ||
    workflow.includes('--expected-deployment-identity "rollback-') ||
    workflow.includes("(deploy|rollback)-[0-9]+-[0-9]+") ||
    workflow.includes("baseline_version") ||
    workflow.includes("latest_version") ||
    workflow.includes("RUN_COMPLETED_AT") ||
    workflow.includes("run_completed_at") ||
    workflow.includes("Date.parse") ||
    occurrenceCount(workflow, "workflow_dispatch:") !== 1 ||
    workflow.includes("workflow_call:") ||
    workflow.includes("workflow_run:") ||
    workflow.includes("repository_dispatch:") ||
    workflow.includes("pull_request:") ||
    workflow.includes("push:") ||
    workflow.includes("schedule:") ||
    workflow.includes("fly config save") ||
    workflow.includes("node scripts/migrate-production.mjs") ||
    /group: production-deploy-(?:gateway|image-gen|storage-proxy)/.test(
      workflow,
    ) ||
    /FLY_(?:GATEWAY|IMAGE_GEN|STORAGE_PROXY)_DEPLOY_TOKEN/.test(workflow)
  ) {
    fail(
      `${PRODUCTION_RECONCILIATION_WORKFLOW_PATH} must keep all three recovery jobs independent, exact-source, and least-privileged`,
    );
  }
}

function sameStringSet(actual, expected) {
  return (
    JSON.stringify([...(actual ?? [])].sort()) ===
    JSON.stringify([...expected].sort())
  );
}

function validateImageGenSchemaTransition(app) {
  if (app.databaseSchemaPhase === "0017_contract") {
    fail(
      "image-gen 0017 contract is production-blocked until a separate reviewed writer-fencing design exists",
    );
  }
  if (Object.hasOwn(app, "contractWriterSourceCommit")) {
    fail("image-gen must not expose the retired self-attested contract gate");
  }
  const transition = app.databaseSchemaTransition;
  if (
    !transition ||
    typeof transition !== "object" ||
    Array.isArray(transition)
  ) {
    fail("image-gen must declare its reviewed 0015-to-0016 transition state");
  }
  if (
    transition.from !== "0015_base" ||
    transition.to !== "0016_expand" ||
    !IMAGE_GEN_TRANSITION_STATES.includes(transition.state)
  ) {
    fail("image-gen has an unsupported database schema transition");
  }
  if (!isImmutableAppImage(app, transition.legacyBaseImage)) {
    fail("image-gen transition must pin the exact proven legacy base digest");
  }
  if (
    transition.bridgePredicateType !==
    "https://leaderbot.live/attestations/migration-bridge/v1"
  ) {
    fail("image-gen transition must use the reviewed bridge attestation type");
  }
  const recovery = app.databaseRecovery;
  if (
    recovery?.app !== "leaderbot-portal-mysql" ||
    !/^vol_[a-z0-9]+$/.test(recovery?.volumeId ?? "") ||
    recovery?.databaseName !== "leaderbot" ||
    recovery?.region !== "ams" ||
    recovery?.sizeGb !== 10 ||
    recovery?.probeVmMemoryMb !== 2048 ||
    !/^docker-hub-mirror\.fly\.io\/library\/mysql:8\.4\.11@sha256:[a-f0-9]{64}$/.test(
      recovery?.mysqlImage ?? "",
    )
  ) {
    fail("image-gen must pin its encrypted MySQL snapshot/restore contract");
  }

  const bridgeReviewed = transition.state !== "awaiting_attested_bridge";
  if (bridgeReviewed) {
    if (
      !isImmutableAppImage(app, transition.bridgeImage) ||
      !isReviewedSourceCommit(transition.bridgeSourceCommit)
    ) {
      fail("image-gen transition needs an attested bridge digest and source");
    }
  } else if (
    transition.bridgeImage !== null ||
    transition.bridgeSourceCommit !== null
  ) {
    fail("image-gen unreviewed bridge metadata must remain empty");
  }

  if (transition.state === "awaiting_attested_bridge") {
    if (
      app.databaseSchemaPhase !== "0015_base" ||
      app.deploymentEnabled !== false ||
      app.reviewedArtifactKind !== "legacy-bootstrap" ||
      app.reviewedImage !== transition.legacyBaseImage ||
      !sameStringSet(app.reviewedRollbackImages, [transition.legacyBaseImage])
    ) {
      fail(
        "image-gen must stay deployment-blocked on the proven base while its bridge is unreviewed",
      );
    }
    return;
  }

  const bridgeIsCurrent =
    app.reviewedImage === transition.bridgeImage &&
    app.reviewedArtifactKind === "migration-bridge" &&
    app.reviewedSourceCommit === transition.bridgeSourceCommit &&
    JSON.stringify(app.reviewedImageSchemaPhases) ===
      JSON.stringify(["0015_base", "0016_expand"]);

  if (transition.state === "bridge_reviewed") {
    if (
      app.databaseSchemaPhase !== "0015_base" ||
      app.deploymentEnabled !== true ||
      !bridgeIsCurrent ||
      !sameStringSet(app.reviewedRollbackImages, [transition.legacyBaseImage])
    ) {
      fail(
        "image-gen bridge_reviewed must deploy only the bridge with the proven base as pre-expand rollback",
      );
    }
    return;
  }

  if (transition.state === "expand_pending") {
    if (
      app.databaseSchemaPhase !== "0015_base" ||
      app.deploymentEnabled !== false ||
      !bridgeIsCurrent ||
      !sameStringSet(app.reviewedRollbackImages, [transition.bridgeImage]) ||
      app.reviewedRollbackArtifactKinds[transition.bridgeImage] !==
        "migration-bridge"
    ) {
      fail(
        "image-gen expand_pending must freeze deploys with the bridge as its only recovery image",
      );
    }
    return;
  }

  if (transition.state === "runtime_build_pending") {
    if (
      app.databaseSchemaPhase !== "0016_expand" ||
      app.deploymentEnabled !== false ||
      !bridgeIsCurrent ||
      !sameStringSet(app.reviewedRollbackImages, [transition.bridgeImage])
    ) {
      fail(
        "image-gen runtime_build_pending must stay frozen on the bridge after expand",
      );
    }
    return;
  }

  const settledPredecessorImage = app.reviewedSettledPredecessor?.image;
  const hasDistinctRuntimePredecessor =
    settledPredecessorImage != null &&
    settledPredecessorImage !== app.reviewedImage &&
    settledPredecessorImage !== transition.bridgeImage;
  const expectedRuntimeRollbacks = [
    ...(hasDistinctRuntimePredecessor
      ? [transition.bridgeImage, settledPredecessorImage]
      : []),
  ];
  const hasExactRuntimePredecessor =
    hasDistinctRuntimePredecessor &&
    app.reviewedRollbackArtifactKinds[settledPredecessorImage] === "runtime" &&
      isReviewedSourceCommit(
        app.reviewedRollbackSourceCommits[settledPredecessorImage],
      ) &&
      JSON.stringify(
        app.reviewedRollbackImageSchemaPhases[settledPredecessorImage],
      ) === JSON.stringify(["0016_expand"]);

  if (
    app.databaseSchemaPhase !== "0016_expand" ||
    app.deploymentEnabled !== true ||
    app.reviewedArtifactKind !== "runtime" ||
    !isReviewedSourceCommit(app.reviewedSourceCommit) ||
    !sameStringSet(app.reviewedRollbackImages, expectedRuntimeRollbacks) ||
    app.reviewedRollbackArtifactKinds[transition.bridgeImage] !==
      "migration-bridge" ||
    !hasExactRuntimePredecessor
  ) {
    fail(
      "image-gen reviewed runtime must support expand and retain only the bridge plus exact settled runtime predecessor",
    );
  }
}

function validateStorageProxyArtifactTransition(app) {
  const transition = app.artifactTransition;
  if (
    !transition ||
    ![
      "awaiting_attested_runtime",
      "runtime_reviewed",
      "runtime_deployed",
      "complete",
    ].includes(transition.state) ||
    !isImmutableAppImage(app, transition.legacyImage) ||
    typeof transition.legacyFlyctlVersion !== "string" ||
    !/^(?:v)?[0-9]+\.[0-9]+\.[0-9]+$/.test(transition.legacyFlyctlVersion)
  ) {
    fail("storage-proxy must declare its exact trusted artifact transition");
  }
  if (transition.state === "awaiting_attested_runtime") {
    if (
      app.deploymentEnabled !== false ||
      app.reviewedImage !== transition.legacyImage ||
      app.reviewedArtifactKind !== "legacy-bootstrap" ||
      !sameStringSet(app.reviewedRollbackImages, [transition.legacyImage])
    ) {
      fail(
        "storage-proxy must stay blocked on its proven image until a runtime is attested",
      );
    }
    return;
  }
  if (
    app.deploymentEnabled !== true ||
    app.reviewedArtifactKind !== "runtime" ||
    !isReviewedSourceCommit(app.reviewedSourceCommit)
  ) {
    fail("storage-proxy trusted rollout requires an attested runtime");
  }
  if (
    transition.state === "runtime_reviewed" ||
    transition.state === "runtime_deployed"
  ) {
    if (
      !sameStringSet(app.reviewedRollbackImages, [transition.legacyImage]) ||
      app.reviewedRollbackArtifactKinds[transition.legacyImage] !==
        "legacy-bootstrap"
    ) {
      fail(
        "storage-proxy first trusted rollout must retain only its exact legacy rollback",
      );
    }
    return;
  }
  if (
    app.reviewedRollbackImages.length === 0 ||
    app.reviewedRollbackImages.includes(transition.legacyImage) ||
    app.reviewedRollbackImages.some(
      (image) => app.reviewedRollbackArtifactKinds[image] !== "runtime",
    )
  ) {
    fail(
      "storage-proxy completed transition must keep only attested runtime rollbacks",
    );
  }
}

export function validateProductionRepository(rootDir = process.cwd()) {
  const manifest = loadProductionManifest(rootDir);
  const packageJson = readJson(path.join(rootDir, "package.json"));
  const productionRunbookPath = path.join(
    rootDir,
    "docs/operations/production-deployments.md",
  );
  if (!fs.existsSync(productionRunbookPath)) {
    fail("Missing production deployment runbook");
  }
  const productionRunbook = fs.readFileSync(productionRunbookPath, "utf8");
  for (const [needle, message] of [
    [
      PINNED_FLYCTL_ASSET_URL,
      "must document the exact reviewed flyctl Linux x86_64 asset",
    ],
    [
      PINNED_FLYCTL_ASSET_SHA256,
      "must document the exact reviewed flyctl asset SHA256",
    ],
    [
      "immutable: false",
      "must explain why the flyctl release tag is not a trust anchor",
    ],
    [
      "production-inspection",
      "must document the protected inspection environment",
    ],
    ["FLY_PRODUCTION_READONLY_TOKEN", "must document the inspection token"],
    [
      "production-recovery",
      "must document the automatic protected recovery environment",
    ],
    [
      "FLY_RECOVERY_READONLY_TOKEN",
      "must document the recovery successor-inspection token",
    ],
    [
      "organization-readonly token",
      "must keep recovery inspection metadata-only",
    ],
    [
      "config, release, image, Machine, and scale reads",
      "must bound recovery inspection commands",
    ],
    [
      "no reviewer or wait timer",
      "must keep automatic recovery free of an approval deadlock",
    ],
    [
      "no deployment,",
      "must deny mutation authority to the recovery inspection token",
    ],
    [
      "customer-content access",
      "must deny customer data access to recovery inspection",
    ],
    [
      "Automatic app recovery receives no SQL credential or database URL",
      "must deny SQL and customer-table access to automatic recovery",
    ],
    [
      "rollback-schema-phase.txt",
      "must document immutable metadata-only rollback schema evidence",
    ],
    [
      "exact interrupted manifest-bound",
      "must bind recovery schema evidence to the interrupted reviewed source",
    ],
    [
      "No MySQL principal is provisioned to automatic no-review",
      "must keep automatic recovery outside the database privilege boundary",
    ],
    [
      "persistent trigger definer: table-level `SELECT, TRIGGER` on",
      "must document the exact persistent trigger-definer privilege boundary",
    ],
    [
      "`billing_scheduler_tenants`, with no rights on any other table",
      "must restrict the persistent trigger definer to the two subject tables",
    ],
    [
      "Never repair it by adding `TRIGGER`",
      "must keep trigger remediation least-privileged and outside the app runtime",
    ],
    [
      "three-trigger metadata/body tuple plus exact two-table grant check",
      "must use an executable dedicated-definer verification gate",
    ],
    [
      "contains only these three app rollback tokens and this one",
      "must keep production-recovery free of database-provider write authority",
    ],
    [
      "The orphan schema-probe janitor is `workflow_dispatch` only",
      "must document reviewer-approved manual orphan cleanup",
    ],
    [
      "completes a reviewer-gated `production` approval job",
      "must keep database resource cleanup behind production approval",
    ],
    [
      "its separate mutation job enters the shared image-gen lock",
      "must document approval-before-lock ordering for manual orphan cleanup",
    ],
    [
      "protected-main, reviewerless `production-schema-cleanup`",
      "must document the isolated post-approval schema-cleanup environment",
    ],
    [
      "Never put this database write token in `production-recovery`",
      "must keep schema-cleanup database authority out of automatic recovery",
    ],
    [
      "bounded `if: always()` cleanup",
      "must retain same-job cleanup inside the approved schema transition",
    ],
    [
      "recovery-protocol.txt",
      "must document the versioned cross-commit recovery contract",
    ],
    [
      "current protected workflow commit",
      "must execute current trusted recovery controller code",
    ],
    [
      "only as manifest/configuration data",
      "must never execute interrupted recovery code",
    ],
    [
      "full 30-day",
      "must retain protocol v1 support for every live rollback artifact",
    ],
    [
      "never from hardcoded counts",
      "must derive recovery scale only from validated interrupted data",
    ],
  ]) {
    if (!productionRunbook.includes(needle)) {
      fail(`Production deployment runbook ${message}`);
    }
  }
  if (
    productionRunbook.includes("IMAGE_GEN_DATABASE_RECOVERY_INSPECTION_URL") ||
    productionRunbook.includes("recovery inspection: exactly `SELECT`") ||
    productionRunbook.includes("FLY_DATABASE_RECOVERY_TOKEN")
  ) {
    fail(
      "Production deployment runbook must not provision database inspection or provider-write capability to automatic no-review recovery",
    );
  }
  for (const requiredWorkflow of [
    PRODUCTION_COMPLETION_RECOVERY_WORKFLOW_PATH,
    PRODUCTION_RECONCILIATION_WORKFLOW_PATH,
  ]) {
    if (!fs.existsSync(path.join(rootDir, requiredWorkflow))) {
      fail(`Missing ${requiredWorkflow}`);
    }
  }
  validateVerifiedFlyctlSupplyChain(rootDir);
  const workflowDir = path.join(rootDir, ".github/workflows");
  const workflowFiles = fs
    .readdirSync(workflowDir)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"));
  const reconciliationDispatchers = workflowFiles
    .filter((file) =>
      fs
        .readFileSync(path.join(workflowDir, file), "utf8")
        .includes(
          "/actions/workflows/reconcile-production-deployment.yml/dispatches",
        ),
    )
    .sort();
  if (
    JSON.stringify(reconciliationDispatchers) !==
    JSON.stringify([
      "deploy-production.yml",
      "recover-completed-production-deployment.yml",
    ])
  ) {
    fail(
      "Production reconciliation may be dispatched only by its two exact reviewed local workflows",
    );
  }
  for (const dispatcher of reconciliationDispatchers) {
    const source = fs.readFileSync(path.join(workflowDir, dispatcher), "utf8");
    if (
      source.includes("secrets: inherit") ||
      source.includes(
        "uses: ./.github/workflows/reconcile-production-deployment.yml",
      )
    ) {
      fail(
        `${dispatcher} production recovery dispatchers must never expose a reusable caller-secret boundary`,
      );
    }
  }
  const inspectionSecretHolders = fs
    .readdirSync(workflowDir)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .filter((file) =>
      fs
        .readFileSync(path.join(workflowDir, file), "utf8")
        .includes("FLY_PRODUCTION_READONLY_TOKEN"),
    )
    .sort();
  if (
    JSON.stringify(inspectionSecretHolders) !==
    JSON.stringify(["deploy-production.yml", "image-gen-schema-transition.yml"])
  ) {
    fail(
      "FLY_PRODUCTION_READONLY_TOKEN may exist only in the two trusted production-inspection preflights",
    );
  }
  for (const [target, script] of [
    ["gateway", "production:drift:gateway"],
    ["image-gen", "production:drift:image-gen"],
    ["storage-proxy", "production:drift:storage-proxy"],
  ]) {
    if (
      packageJson.scripts?.[script] !==
      `node scripts/validate-production-deployment.mjs --settled-live ${target}`
    ) {
      fail(`${script} must verify drift against the settled live identity`);
    }
  }
  for (const dockerfilePath of [
    "deploy/fly-gateway/Dockerfile",
    "deploy/fly-gateway/Dockerfile.route-guard-hotfix",
  ]) {
    const dockerfile = fs.readFileSync(
      path.join(rootDir, dockerfilePath),
      "utf8",
    );
    const frontend = dockerfile.match(/^#\s*syntax=(\S+)\s*$/m)?.[1];
    if (frontend && !/@sha256:[a-f0-9]{64}$/.test(frontend)) {
      fail(`${dockerfilePath} must not use a mutable Dockerfile frontend`);
    }
  }
  assertPinnedGatewayDockerfile(rootDir);
  validateStorageProxySafety(rootDir);
  validateImageGenMigrationCi(rootDir);
  validateTrustedArtifactWorkflow(rootDir);
  validateSchemaTransitionWorkflow(rootDir);
  validateSchemaProbeCleanupWorkflow(rootDir);
  validateProductionCompletionRecoveryWorkflow(rootDir);
  validateProductionReconciliationWorkflow(rootDir);
  const appNames = new Set();
  const manifestTargets = Object.keys(manifest.apps).sort();
  const canonicalTargets = Object.keys(CANONICAL_TARGETS).sort();
  if (JSON.stringify(manifestTargets) !== JSON.stringify(canonicalTargets)) {
    fail(
      `Production manifest must define exactly: ${canonicalTargets.join(", ")}`,
    );
  }
  const gatewayFlyConfig = fs.readFileSync(
    path.join(rootDir, "fly.toml"),
    "utf8",
  );
  if (
    !gatewayFlyConfig.includes(
      'dockerfile = "deploy/fly-gateway/Dockerfile"',
    ) ||
    gatewayFlyConfig.includes("LEADERBOT_AI_ANSWER_ENFORCEMENT_ENABLED") ||
    gatewayFlyConfig.includes("Dockerfile.route-guard-hotfix")
  ) {
    fail(
      "personal gateway must select the pinned full runtime without customer AI answer enforcement",
    );
  }
  for (const retiredGatewayCap of [
    "MESSENGER_GATEWAY_DAILY_IMAGE_FORWARD_CAP",
    "MESSENGER_GATEWAY_DAILY_LEADERBOT_EVENT_FORWARD_CAP",
  ]) {
    if (allAssignments(gatewayFlyConfig, retiredGatewayCap).length > 0) {
      fail(`fly.toml must not set retired ${retiredGatewayCap}`);
    }
  }

  for (const [target, app] of Object.entries(manifest.apps)) {
    const canonical = CANONICAL_TARGETS[target];
    if (
      !canonical ||
      app.app !== canonical.app ||
      app.config !== canonical.config ||
      app.deployScript !== canonical.deployScript
    ) {
      fail(`${target} must use its canonical app, config, and deploy script`);
    }
    if (appNames.has(app.app)) fail(`Duplicate production Fly app: ${app.app}`);
    appNames.add(app.app);
    if (!packageJson.scripts?.[app.deployScript]) {
      fail(`Missing package script ${app.deployScript}`);
    }
    if (
      !packageJson.scripts[app.deployScript].includes(
        `--validate-target-enabled ${target}`,
      )
    ) {
      fail(`${target} deploy script must enforce the manifest deployment gate`);
    }
    if (
      (target === "gateway" || app.sourceDeployEnabled === false) &&
      (!canonical.reviewedImageEnv ||
        !packageJson.scripts[app.deployScript].includes(
          `--validate-rollback-image ${target} "$${canonical.reviewedImageEnv}"`,
        ) ||
        !packageJson.scripts[app.deployScript].includes(
          `--image "$${canonical.reviewedImageEnv}"`,
        ))
    ) {
      fail(`${target} deploy script must require the reviewed manifest image`);
    }
    if (
      target === "gateway" &&
      occurrenceCount(
        packageJson.scripts[app.deployScript],
        '--image "$FLY_GATEWAY_REVIEWED_IMAGE"',
      ) !== 1
    ) {
      fail(
        "gateway deploy script must pass exactly one reviewed immutable image",
      );
    }
    if (app.strategy !== "rolling") {
      fail(`${target} must use the reviewed rolling deployment strategy`);
    }
    if (app.serviceCheckPath !== "/healthz") {
      fail(`${target} must route on the liveness-only /healthz check`);
    }
    if (app.allowDetachedMachines !== false) {
      fail(`${target} must reject detached production Machines`);
    }
    if (!Array.isArray(app.reviewedRollbackImages)) {
      fail(`${target} must define reviewedRollbackImages`);
    }
    if (typeof app.deploymentEnabled !== "boolean") {
      fail(`${target} must define deploymentEnabled`);
    }
    if (app.deploymentEnabled === false && !app.deploymentBlockReason) {
      fail(`${target} must explain why deployment is blocked`);
    }
    if (target === "gateway" && app.deploymentEnabled !== false) {
      fail(
        "gateway must remain deployment-disabled until its stateful migration is approved",
      );
    }
    if (target === "gateway") {
      validateGatewayStateRebaseline(app, gatewayFlyConfig);
    }
    if (
      new Set(app.reviewedRollbackImages).size !==
      app.reviewedRollbackImages.length
    ) {
      fail(`${target} reviewedRollbackImages must not contain duplicates`);
    }
    for (const image of app.reviewedRollbackImages) {
      if (!isImmutableAppImage(app, image)) {
        fail(`${target} has an invalid reviewed rollback image`);
      }
    }
    if (target !== "gateway") {
      if (app.trustedBuilderWorkflow !== TRUSTED_ARTIFACT_WORKFLOW_PATH) {
        fail(
          `${target} must use the canonical trusted production artifact builder`,
        );
      }
      if (!REVIEWED_ARTIFACT_KINDS.includes(app.reviewedArtifactKind)) {
        fail(`${target} reviewedImage must declare its artifact kind`);
      }
      if (
        !app.reviewedRollbackArtifactKinds ||
        typeof app.reviewedRollbackArtifactKinds !== "object" ||
        Array.isArray(app.reviewedRollbackArtifactKinds)
      ) {
        fail(`${target} must define reviewedRollbackArtifactKinds`);
      }
      if (
        JSON.stringify(
          Object.keys(app.reviewedRollbackArtifactKinds).sort(),
        ) !== JSON.stringify([...app.reviewedRollbackImages].sort())
      ) {
        fail(
          `${target} artifact kinds must cover exactly every reviewed rollback image`,
        );
      }
      for (const [image, kind] of Object.entries(
        app.reviewedRollbackArtifactKinds,
      )) {
        if (
          !app.reviewedRollbackImages.includes(image) ||
          !REVIEWED_ARTIFACT_KINDS.includes(kind)
        ) {
          fail(`${target} has an invalid reviewed rollback artifact kind`);
        }
      }
      if (
        !app.reviewedRollbackConfigs ||
        typeof app.reviewedRollbackConfigs !== "object" ||
        Array.isArray(app.reviewedRollbackConfigs) ||
        JSON.stringify(Object.keys(app.reviewedRollbackConfigs).sort()) !==
          JSON.stringify([...app.reviewedRollbackImages].sort())
      ) {
        fail(
          `${target} reviewed rollback configs must cover exactly every allowlisted rollback image`,
        );
      }
      for (const image of app.reviewedRollbackImages) {
        getReviewedRollbackConfig(target, image, rootDir);
      }
      if (app.reviewedSettledPredecessor != null) {
        getReviewedSettledPredecessorConfig(
          target,
          app.reviewedSettledPredecessor.identity,
          app.reviewedSettledPredecessor.image,
          rootDir,
        );
      }
      if (
        app.reviewedSourceCommit !== null &&
        !isReviewedSourceCommit(app.reviewedSourceCommit)
      ) {
        fail(`${target} reviewedSourceCommit must be null or an exact Git SHA`);
      }
      if (
        !app.reviewedRollbackSourceCommits ||
        typeof app.reviewedRollbackSourceCommits !== "object" ||
        Array.isArray(app.reviewedRollbackSourceCommits)
      ) {
        fail(`${target} must define reviewedRollbackSourceCommits`);
      }
      for (const [image, sourceCommit] of Object.entries(
        app.reviewedRollbackSourceCommits,
      )) {
        if (
          !app.reviewedRollbackImages.includes(image) ||
          !isReviewedSourceCommit(sourceCommit)
        ) {
          fail(
            `${target} rollback source provenance must map an allowlisted digest to an exact Git SHA`,
          );
        }
      }
      if (
        app.reviewedArtifactKind !== "legacy-bootstrap" &&
        !isReviewedSourceCommit(app.reviewedSourceCommit)
      ) {
        fail(`${target} trusted reviewed artifact needs an exact source SHA`);
      }
      for (const image of app.reviewedRollbackImages) {
        const kind = app.reviewedRollbackArtifactKinds[image];
        const sourceCommit = app.reviewedRollbackSourceCommits[image];
        if (
          kind !== "legacy-bootstrap" &&
          !isReviewedSourceCommit(sourceCommit)
        ) {
          fail(`${target} trusted rollback artifact needs an exact source SHA`);
        }
        if (kind === "legacy-bootstrap" && sourceCommit !== undefined) {
          fail(
            `${target} legacy bootstrap rollback must not claim trusted source provenance`,
          );
        }
      }
      if (
        app.deploymentEnabled === true &&
        app.reviewedArtifactKind === "legacy-bootstrap"
      ) {
        fail(`${target} cannot deploy an unattested legacy bootstrap image`);
      }
    }
    if (target === "storage-proxy" && app.reviewedRollbackImages.length === 0) {
      fail(
        "storage-proxy must retain an independently reviewed rollback image",
      );
    }
    if (target === "storage-proxy") {
      validateStorageProxyArtifactTransition(app);
    }
    if (
      app.deploymentEnabled === true &&
      app.sourceDeployEnabled !== false &&
      !app.reviewedImage &&
      app.reviewedRollbackImages.length === 0
    ) {
      fail(
        `${target} must seed a reviewed rollback digest before deployment is enabled`,
      );
    }
    if (app.sourceDeployEnabled === false && !app.sourceDeployBlockReason) {
      fail(`${target} must document why source deploys are blocked`);
    }
    const reviewedImagePrefix = `registry.fly.io/${app.app}@sha256:`;
    const reviewedImageDigest = (app.reviewedImage ?? "").slice(
      reviewedImagePrefix.length,
    );
    if (
      app.sourceDeployEnabled === false &&
      !(
        app.reviewedImage?.startsWith(reviewedImagePrefix) &&
        /^[a-f0-9]{64}$/.test(reviewedImageDigest)
      )
    ) {
      fail(`${target} must pin its reviewed immutable production image`);
    }

    const configPath = path.join(rootDir, app.config);
    const text = fs.readFileSync(configPath, "utf8");
    if (/(?:'''|""")/.test(text)) {
      fail(`${app.config} must not use multiline TOML strings`);
    }
    const tables = readTomlTables(text);
    const rootAssignments = tableAssignments(tables, "");
    const envAssignments = tableAssignments(tables, "env");
    const processes = tableAssignments(tables, "processes");
    const httpService = tableAssignments(tables, "http_service");
    const deploy = tableAssignments(tables, "deploy");
    const configuredGroups = Object.keys(processes).sort();
    const desiredGroups = Object.keys(app.desiredScale).sort();
    if (rootAssignments.app !== app.app) {
      fail(`${app.config} must target ${app.app}`);
    }
    if (target === "image-gen") {
      if (!PRODUCTION_SCHEMA_PHASES.includes(app.databaseSchemaPhase)) {
        fail(`${target} must declare one exact databaseSchemaPhase`);
      }
      if (
        !app.reviewedRollbackImageSchemaPhases ||
        typeof app.reviewedRollbackImageSchemaPhases !== "object" ||
        Array.isArray(app.reviewedRollbackImageSchemaPhases)
      ) {
        fail(`${target} must define reviewedRollbackImageSchemaPhases`);
      }
      const rollbackSchemaImages = Object.keys(
        app.reviewedRollbackImageSchemaPhases,
      ).sort();
      if (
        JSON.stringify(rollbackSchemaImages) !==
        JSON.stringify([...app.reviewedRollbackImages].sort())
      ) {
        fail(
          `${target} schema compatibility must cover exactly every reviewed rollback image`,
        );
      }
      assertReviewedSchemaPhases(target, app, app.reviewedImage);
      for (const rollbackImage of app.reviewedRollbackImages) {
        assertReviewedSchemaPhases(target, app, rollbackImage);
      }
      validateImageGenSchemaTransition(app);
      if (
        rootAssignments.kill_signal !== "SIGTERM" ||
        rootAssignments.kill_timeout !== 300
      ) {
        fail(
          `${app.config} must give image workers a 300s graceful SIGTERM drain`,
        );
      }
      for (const [name, expected] of [
        [
          "PUBLIC_BASE_URL",
          "https://pub-7e5beae089c4457a89cb65cf300daf75.r2.dev",
        ],
        ["MESSENGER_FREE_DAILY_LIMIT", "5"],
        ["MESSENGER_FREE_MONTHLY_LIMIT", "20"],
        ["MESSENGER_IMAGE_QUOTA_TIME_ZONE", "Europe/Brussels"],
        ["OPENAI_IMAGE_MAX_RETRIES", "0"],
        [
          "MESSENGER_GENERATION_QUEUE_WRITE_VERSION",
          app.generationQueueWriteVersion,
        ],
      ]) {
        if (!expected) {
          fail(`${target} must declare generationQueueWriteVersion`);
        }
        if (String(envAssignments[name] ?? "") !== expected) {
          fail(`${app.config} must set ${name}=${expected}`);
        }
      }
      if (!["v1", "v2"].includes(app.generationQueueWriteVersion)) {
        fail(`${target} generationQueueWriteVersion must be v1 or v2`);
      }
      if (!Array.isArray(app.generationQueueV2ReaderImages)) {
        fail(`${target} must define generationQueueV2ReaderImages`);
      }
      if (
        new Set(app.generationQueueV2ReaderImages).size !==
        app.generationQueueV2ReaderImages.length
      ) {
        fail(
          `${target} generationQueueV2ReaderImages must not contain duplicates`,
        );
      }
      for (const image of app.generationQueueV2ReaderImages) {
        if (!isImmutableAppImage(app, image)) {
          fail(`${target} has an invalid v2 queue reader image`);
        }
      }
      if (app.generationQueueWriteVersion === "v2") {
        for (const image of reviewedProductionImages(app)) {
          if (!app.generationQueueV2ReaderImages.includes(image)) {
            fail(
              `${target} cannot write v2 while a reviewed rollback image lacks the v2 queue reader`,
            );
          }
        }
      }
      for (const retiredImageSetting of [
        "MESSENGER_GLOBAL_DAILY_IMAGE_CAP",
        "OPENAI_IMAGE_ESTIMATED_COST_USD",
      ]) {
        if (retiredImageSetting in envAssignments) {
          fail(
            `${app.config} must not configure retired image setting ${retiredImageSetting}`,
          );
        }
      }

      const imageService = fs.readFileSync(
        path.join(rootDir, "apps/image-gen/server/_core/imageService.ts"),
        "utf8",
      );
      for (const forbiddenAdmissionCall of [
        "assertMessengerDailyImageBudgetAvailable(",
        "admitMessengerProviderSpend(",
        "estimateOpenAiImageRequestCost(",
        'safeLog("image_generation_cost_estimate"',
      ]) {
        if (imageService.includes(forbiddenAdmissionCall)) {
          fail(
            `imageService.ts must not calculate or gate on internal image prices`,
          );
        }
      }

      if (
        fs.existsSync(
          path.join(
            rootDir,
            "apps/image-gen/server/_core/image-generation/imageCostEstimate.ts",
          ),
        )
      ) {
        fail("the retired internal image-price calculator must stay removed");
      }

      if (
        deploy.release_command !==
        "timeout -k 30s 8m env LEADERBOT_PRODUCTION_MIGRATION_MODE=verify-artifact node dist/migrate-production.cjs"
      ) {
        fail(
          `${app.config} must bound artifact-specific schema verification below the Fly release timeout`,
        );
      }
      if (deploy.release_command_timeout !== "10m") {
        fail(`${app.config} must bound the migration release command to 10m`);
      }

      const imageGenPackage = readJson(
        path.join(rootDir, "apps/image-gen/package.json"),
      );
      if (
        imageGenPackage.scripts?.["db:migrate:expand"] !== undefined ||
        imageGenPackage.scripts?.["db:migrate:contract"] !== undefined
      ) {
        fail(
          "image-gen package must not expose direct production schema-apply scripts",
        );
      }
      const dockerBuild = String(
        imageGenPackage.scripts?.["build:docker"] ?? "",
      );
      for (const requiredBuildFragment of [
        "scripts/run-production-migrations.mjs",
        "--format=cjs",
        "--outfile=dist/migrate-production.cjs",
      ]) {
        if (!dockerBuild.includes(requiredBuildFragment)) {
          fail(
            `image-gen build:docker must bundle the reviewed production migrator`,
          );
        }
      }
      for (const requiredProvisioningFragment of [
        "server/cli/provisionWhatsAppBinding.ts",
        "--outfile=dist/provision-whatsapp-binding.cjs",
      ]) {
        if (!dockerBuild.includes(requiredProvisioningFragment)) {
          fail(
            "image-gen build:docker must bundle the provider-silent WhatsApp provisioning command",
          );
        }
      }
      for (const requiredTriggerProbeFragment of [
        "scripts/run-billing-trigger-runtime-preflight.mjs",
        "--outfile=dist/billing-trigger-runtime-preflight.cjs",
      ]) {
        if (!dockerBuild.includes(requiredTriggerProbeFragment)) {
          fail(
            "image-gen build:docker must bundle the reversible billing-trigger runtime probe",
          );
        }
      }
      const dockerfile = fs.readFileSync(
        path.join(rootDir, "apps/image-gen/Dockerfile"),
        "utf8",
      );
      assertPinnedNodeDockerfile(dockerfile, "apps/image-gen/Dockerfile", {
        ffmpeg: true,
      });
      const firstDockerFrom = dockerfile.search(/^FROM\s+/m);
      const bridgeBaseArg =
        "ARG MIGRATION_BRIDGE_BASE_IMAGE=registry.fly.io/leaderbot-fb-image-gen@sha256:28d862568aa3cb049ac4aba164bb1e01792691feec646ff87c657f72bd306804";
      if (
        firstDockerFrom < 0 ||
        dockerfile.indexOf(bridgeBaseArg) < 0 ||
        dockerfile.indexOf(bridgeBaseArg) > firstDockerFrom ||
        occurrenceCount(dockerfile, bridgeBaseArg) !== 1 ||
        (dockerfile.match(/^ARG MIGRATION_BRIDGE_BASE_IMAGE=/gm) ?? [])
          .length !== 1
      ) {
        fail(
          "image-gen Dockerfile must declare its exact migration bridge base before the first FROM instruction",
        );
      }
      for (const requiredDockerFragment of [
        "COPY --from=build /app/drizzle ./drizzle",
        "AS migration_bridge",
        bridgeBaseArg,
        'io.leaderbot.artifact.kind="migration-bridge"',
        'io.leaderbot.schema.minimum="0015_base"',
        'io.leaderbot.schema.minimum="0016_expand"',
        'io.leaderbot.schema.maximum="0016_expand"',
        "'migration-bridge' > /app/.leaderbot-artifact-kind",
        "'runtime' > /app/.leaderbot-artifact-kind",
        "RUN test -s /app/dist/provision-whatsapp-binding.cjs",
        "RUN test -s /app/dist/billing-trigger-runtime-preflight.cjs",
      ]) {
        if (!dockerfile.includes(requiredDockerFragment)) {
          fail(
            "image-gen Dockerfile must include the hashed migration contract and exact schema range",
          );
        }
      }
      const runtimeStage = dockerfile.split(" AS runtime", 2)[1] ?? "";
      if (
        !runtimeStage.includes('io.leaderbot.schema.minimum="0016_expand"') ||
        !runtimeStage.includes('io.leaderbot.schema.maximum="0016_expand"') ||
        runtimeStage.includes("0017_contract")
      ) {
        fail(
          "image-gen runtime artifact must stay on the exact 0016_expand schema range until 0017 writer fencing is reviewed",
        );
      }
      const imageGenCi = fs.readFileSync(
        path.join(rootDir, ".github/workflows/image-gen-ci.yml"),
        "utf8",
      );
      if (
        !imageGenCi.includes(
          'docker run --rm "$image" test -s /app/dist/provision-whatsapp-binding.cjs',
        )
      ) {
        fail(
          "image-gen CI must inspect the bundled WhatsApp provisioning command",
        );
      }
      if (
        !imageGenCi.includes(
          'docker run --rm "$image" test -s /app/dist/billing-trigger-runtime-preflight.cjs',
        )
      ) {
        fail(
          "image-gen CI must inspect the bundled billing-trigger runtime probe",
        );
      }
      if (!imageGenCi.includes("server/billingExecution.mysql.test.ts")) {
        fail(
          "image-gen CI must run the billing trigger probe against disposable MySQL",
        );
      }
      const migrationRunner = fs.readFileSync(
        path.join(
          rootDir,
          "apps/image-gen/scripts/run-production-migrations.mjs",
        ),
        "utf8",
      );
      const hasExactExplicitModeAssignment =
        /^\s*const migrationMode = configuredMode;\s*$/m.test(migrationRunner);
      if (
        !hasExactExplicitModeAssignment ||
        !migrationRunner.includes("productionMigrationOptionsForMode(") ||
        !migrationRunner.includes(".leaderbot-artifact-kind") ||
        !migrationRunner.includes(
          'migrationMode === "verify-artifact" || migrationMode === "apply-expand"',
        ) ||
        !migrationRunner.includes("explicit staged mode")
      ) {
        fail(
          "production migration runner must require one explicit staged mode",
        );
      }
    }
    if (JSON.stringify(configuredGroups) !== JSON.stringify(desiredGroups)) {
      fail(`${app.config} process groups must match desiredScale`);
    }
    const serviceGroups = parseStringArray(String(httpService.processes ?? ""));
    if (
      JSON.stringify([...serviceGroups].sort()) !==
      JSON.stringify([...app.serviceProcessGroups].sort())
    ) {
      fail(
        `${app.config} HTTP service process groups do not match the manifest`,
      );
    }
    const serviceCheckPaths = allAssignments(text, "path").filter((value) =>
      ["/healthz", "/readyz"].includes(String(value)),
    );
    if (!serviceCheckPaths.includes(app.serviceCheckPath)) {
      fail(`${app.config} must define a /healthz service check`);
    }
    if (
      target === "storage-proxy" &&
      (app.readinessCheckPath !== "/readyz" ||
        app.readinessMonitor !== ".github/workflows/production-uptime.yml")
    ) {
      fail(
        "storage-proxy must retain its exact external readiness monitor contract",
      );
    }
    if (target === "image-gen") {
      const configuredChecks = tableAssignmentGroups(
        text,
        "http_service.checks",
      ).sort((left, right) =>
        String(left.path ?? "").localeCompare(String(right.path ?? "")),
      );
      const canonicalChecks = [
        {
          interval: "15s",
          timeout: "5s",
          grace_period: "10s",
          method: "GET",
          path: "/healthz",
        },
        {
          interval: "15s",
          timeout: "5s",
          grace_period: "45s",
          method: "GET",
          path: "/readyz",
        },
      ];
      if (
        JSON.stringify(configuredChecks) !== JSON.stringify(canonicalChecks)
      ) {
        fail(
          `${app.config} must define exactly the canonical /healthz and /readyz service checks`,
        );
      }
    }
    if (app.readinessCheckPath) {
      if (!app.readinessMonitor) {
        fail(`${target} must define an external readiness monitor`);
      }
      const monitorPath = path.join(rootDir, app.readinessMonitor);
      const monitor = fs.readFileSync(monitorPath, "utf8");
      const readinessUrl = `https://${app.app}.fly.dev${app.readinessCheckPath}`;
      if (!referencesExactHttpUrl(monitor, readinessUrl)) {
        fail(`${app.readinessMonitor} must monitor ${app.readinessCheckPath}`);
      }
      if (target === "storage-proxy") {
        const readinessJob = namedWorkflowJobBody(monitor, "readiness");
        if (!readinessJob) {
          fail(`${app.readinessMonitor} must define its readiness job`);
        }
        const checkoutSteps = namedWorkflowStepBodies(
          readinessJob,
          "Check out production readiness contract",
        );
        const readinessSteps = namedWorkflowStepBodies(
          readinessJob,
          "Check storage proxy readiness",
        );
        const checkoutStepIndex =
          checkoutSteps.length === 1
            ? readinessJob.indexOf(checkoutSteps[0])
            : -1;
        const readinessStepIndex =
          readinessSteps.length === 1
            ? readinessJob.indexOf(readinessSteps[0])
            : -1;
        if (
          checkoutSteps.length !== 1 ||
          checkoutStepIndex < 0 ||
          readinessStepIndex < 0 ||
          checkoutStepIndex >= readinessStepIndex ||
          !checkoutSteps[0].includes(
            "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6",
          ) ||
          !checkoutSteps[0].includes("persist-credentials: false") ||
          /^\s+(?:ref|repository):/mu.test(checkoutSteps[0]) ||
          !checkoutSteps[0].includes(
            "if: github.event_name != 'pull_request'",
          )
        ) {
          fail(
            `${app.readinessMonitor} must check out the exact manifest without persisting credentials`,
          );
        }
        if (
          readinessSteps.length !== 1 ||
          !referencesExactHttpUrl(readinessSteps[0], readinessUrl) ||
          !readinessSteps[0].includes(
            "jq -e '.ok == true and .rateLimiter == \"shared_redis\"'",
          )
        ) {
          fail(
            `${app.readinessMonitor} must verify storage-proxy shared Redis readiness`,
          );
        }
        if (
          !readinessSteps[0].includes(
            '.apps["storage-proxy"].reviewedArtifactKind',
          ) ||
          !readinessSteps[0].includes(
            '.apps["storage-proxy"].artifactTransition.state',
          ) ||
          !readinessSteps[0].includes(
            '"$artifact_kind" == "legacy-bootstrap" && "$transition_state" == "awaiting_attested_runtime"',
          ) ||
          !readinessSteps[0].includes(
            '"$artifact_kind" == "runtime" && "$transition_state" == "runtime_reviewed"',
          ) ||
          !referencesExactHttpUrl(
            readinessSteps[0],
            `https://${app.app}.fly.dev${app.serviceCheckPath}`,
          ) ||
          !readinessSteps[0].includes('grep -Fx "ok" "$body"') ||
          !readinessSteps[0].includes(
            '"$artifact_kind" != "runtime" || ( "$transition_state" != "runtime_deployed" && "$transition_state" != "complete" )',
          )
        ) {
          fail(
            `${app.readinessMonitor} must bind legacy liveness and runtime readiness to the exact storage-proxy artifact transition`,
          );
        }
        if (
          !readinessSteps[0].includes("if: github.event_name != 'pull_request'")
        ) {
          fail(
            `${app.readinessMonitor} must defer storage-proxy readiness until post-deploy monitoring`,
          );
        }
      }
    }
  }

  for (const legacyScript of ["deploy", "gateway:deploy", "image-gen:deploy"]) {
    if (packageJson.scripts?.[legacyScript]) {
      fail(`Remove duplicate or multi-app deploy script: ${legacyScript}`);
    }
  }

  const expectedCallbacks = new Set();
  for (const [object, config] of Object.entries(manifest.meta)) {
    const expected = normalizeUrl(config.expectedCallback);
    if (expectedCallbacks.has(expected)) {
      fail(`Duplicate canonical Meta callback: ${expected}`);
    }
    expectedCallbacks.add(expected);
    if (
      config.temporarilyAllowedCallbacks.map(normalizeUrl).includes(expected)
    ) {
      fail(`${object} lists its canonical callback as temporary drift`);
    }
    if (
      config.migrationState === "canonical" &&
      config.temporarilyAllowedCallbacks.length
    ) {
      fail(
        `${object} cannot allow callback drift after migration is canonical`,
      );
    }
    if (
      !Array.isArray(config.allowedFields) ||
      config.allowedFields.length === 0 ||
      config.allowedFields.some((field) => typeof field !== "string" || !field)
    ) {
      fail(`${object} must define explicit allowed Meta fields`);
    }
    if (new Set(config.allowedFields).size !== config.allowedFields.length) {
      fail(`${object} allowed Meta fields must not contain duplicates`);
    }
  }

  validateProductionWorkflow(rootDir);
  validateRootValidationTriggers(rootDir);

  return {
    apps: Object.keys(manifest.apps).length,
    callbacks: Object.keys(manifest.meta).length,
  };
}

function runFly(args, cwd) {
  return execFileSync("flyctl", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function parseFlyDurationMilliseconds(value) {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value * 1000;
  }
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const text = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text) * 1000;
  const units = { h: 3_600_000, m: 60_000, s: 1000, ms: 1 };
  const pattern = /(\d+(?:\.\d+)?)(ms|h|m|s)/g;
  let cursor = 0;
  let total = 0;
  let matched = false;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match.index !== cursor) return null;
    matched = true;
    total += Number(match[1]) * units[match[2]];
    cursor = pattern.lastIndex;
  }
  return matched && cursor === text.length ? total : null;
}

function flyDurationsEqual(actual, expected) {
  const actualMilliseconds = parseFlyDurationMilliseconds(actual);
  const expectedMilliseconds = parseFlyDurationMilliseconds(expected);
  return (
    actualMilliseconds !== null &&
    expectedMilliseconds !== null &&
    actualMilliseconds === expectedMilliseconds
  );
}

function splitFlyProcessCommand(command) {
  if (typeof command !== "string" || command.trim() === "") return [];
  const words = [];
  let word = "";
  let quote = null;
  let escaped = false;
  let started = false;
  for (const character of command) {
    if (escaped) {
      word += character;
      escaped = false;
      started = true;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
      started = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else word += character;
      started = true;
    } else if (character === '"' || character === "'") {
      quote = character;
      started = true;
    } else if (/\s/.test(character)) {
      if (started) {
        words.push(word);
        word = "";
        started = false;
      }
    } else {
      word += character;
      started = true;
    }
  }
  if (escaped || quote)
    fail("production process command is not valid shell syntax");
  if (started) words.push(word);
  return words;
}

function normalizedMachineInit(init) {
  const result = {};
  for (const key of ["exec", "entrypoint", "cmd", "kernel_args"]) {
    if (Array.isArray(init?.[key]) && init[key].length > 0) {
      result[key] = init[key].map(String);
    }
  }
  if (init?.tty === true) result.tty = true;
  if (init?.swap_size_mb != null && Number(init.swap_size_mb) !== 0) {
    result.swap_size_mb = Number(init.swap_size_mb);
  }
  for (const key of Object.keys(init ?? {})) {
    if (
      ![
        "exec",
        "entrypoint",
        "cmd",
        "kernel_args",
        "tty",
        "swap_size_mb",
      ].includes(key)
    ) {
      result[`unexpected:${key}`] = init[key];
    }
  }
  return result;
}

function normalizedAutostop(value) {
  if (value === false || value === "off") return "off";
  if (value === true || value === "stop") return "stop";
  return value;
}

function normalizedMachinePort(port) {
  const result = {
    port: Number(port?.port),
    handlers: [...(port?.handlers ?? [])].map(String).sort(),
  };
  if (port?.force_https === true) result.force_https = true;
  for (const key of Object.keys(port ?? {})) {
    if (
      !["port", "handlers", "force_https"].includes(key) &&
      port[key] != null
    ) {
      result[`unexpected:${key}`] = port[key];
    }
  }
  return result;
}

function normalizedMachineServiceCheck(check, options = {}) {
  const result = {};
  const scalarKeys = [
    "type",
    "port",
    "method",
    "path",
    "protocol",
    "tls_server_name",
  ];
  for (const key of scalarKeys) {
    if (check?.[key] != null && check[key] !== "") result[key] = check[key];
  }
  for (const key of ["interval", "timeout", "grace_period"]) {
    if (check?.[key] != null) {
      if (
        options.numericNanoseconds === true &&
        typeof check[key] === "number"
      ) {
        result[key] =
          Number.isSafeInteger(check[key]) &&
          check[key] >= 0 &&
          check[key] % 1_000_000 === 0
            ? check[key] / 1_000_000
            : `invalid-nanoseconds:${check[key]}`;
      } else {
        const milliseconds = parseFlyDurationMilliseconds(check[key]);
        result[key] = milliseconds ?? String(check[key]);
      }
    }
  }
  if (check?.tls_skip_verify === true) result.tls_skip_verify = true;
  if (check?.headers != null) {
    const emptyHeaders =
      (Array.isArray(check.headers) && check.headers.length === 0) ||
      (typeof check.headers === "object" &&
        !Array.isArray(check.headers) &&
        Object.keys(check.headers).length === 0);
    if (!emptyHeaders) result.headers = check.headers;
  }
  for (const key of Object.keys(check ?? {})) {
    if (
      ![
        ...scalarKeys,
        "interval",
        "timeout",
        "grace_period",
        "tls_skip_verify",
        "headers",
      ].includes(key) &&
      check[key] != null
    ) {
      result[`unexpected:${key}`] = check[key];
    }
  }
  return result;
}

function normalizedMachineService(service) {
  const result = {
    protocol: service?.protocol ?? "tcp",
    internal_port: Number(service?.internal_port),
    autostop: normalizedAutostop(service?.autostop),
    autostart: service?.autostart,
    min_machines_running: Number(service?.min_machines_running),
    ports: (service?.ports ?? [])
      .map(normalizedMachinePort)
      .sort(
        (left, right) =>
          Number(left.port) - Number(right.port) ||
          JSON.stringify(left.handlers).localeCompare(
            JSON.stringify(right.handlers),
          ),
      ),
    checks: (service?.checks ?? [])
      .map((check) =>
        normalizedMachineServiceCheck(check, { numericNanoseconds: true }),
      )
      .sort((left, right) =>
        `${left.type ?? ""}\0${left.path ?? ""}\0${left.port ?? ""}\0${left.method ?? ""}`.localeCompare(
          `${right.type ?? ""}\0${right.path ?? ""}\0${right.port ?? ""}\0${right.method ?? ""}`,
        ),
      ),
  };
  if (service?.concurrency != null) result.concurrency = service.concurrency;
  for (const key of Object.keys(service ?? {})) {
    if (
      ![
        "protocol",
        "internal_port",
        "autostop",
        "autostart",
        "min_machines_running",
        "ports",
        "checks",
        "concurrency",
      ].includes(key) &&
      service[key] != null
    ) {
      result[`unexpected:${key}`] = service[key];
    }
  }
  return result;
}

function expectedMachineService(httpService, httpChecks) {
  if (Object.keys(httpService).length === 0) return [];
  const service = {
    protocol: "tcp",
    internal_port: Number(httpService.internal_port),
    autostop: normalizedAutostop(httpService.auto_stop_machines),
    autostart: httpService.auto_start_machines,
    min_machines_running: Number(httpService.min_machines_running),
    ports: [
      {
        port: 80,
        handlers: ["http"],
        ...(httpService.force_https === true ? { force_https: true } : {}),
      },
      { port: 443, handlers: ["http", "tls"] },
    ],
    checks: httpChecks.map((httpCheck) =>
      normalizedMachineServiceCheck({
        type: "http",
        interval: httpCheck.interval,
        timeout: httpCheck.timeout,
        grace_period: httpCheck.grace_period,
        method: httpCheck.method,
        path: httpCheck.path,
        protocol: httpCheck.protocol,
        tls_server_name: httpCheck.tls_server_name,
        tls_skip_verify: httpCheck.tls_skip_verify,
      }),
    ),
  };
  service.ports.sort((left, right) => Number(left.port) - Number(right.port));
  service.checks.sort((left, right) =>
    `${left.type ?? ""}\0${left.path ?? ""}\0${left.port ?? ""}\0${left.method ?? ""}`.localeCompare(
      `${right.type ?? ""}\0${right.path ?? ""}\0${right.port ?? ""}\0${right.method ?? ""}`,
    ),
  );
  return [service];
}

function normalizedMachineMounts(mounts) {
  return (mounts ?? [])
    .map((mount) => {
      const normalized = {
        source: mount?.source ?? mount?.name ?? mount?.volume,
        path: mount?.path,
      };
      for (const key of Object.keys(mount ?? {})) {
        if (!["source", "name", "volume", "path"].includes(key)) {
          normalized[`unexpected:${key}`] = mount[key];
        }
      }
      return normalized;
    })
    .sort((left, right) =>
      `${left.source ?? ""}\0${left.path ?? ""}`.localeCompare(
        `${right.source ?? ""}\0${right.path ?? ""}`,
      ),
    );
}

function sortedStringRecord(record) {
  return Object.fromEntries(
    Object.entries(record ?? {})
      .map(([key, value]) => [key, String(value)])
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function immutableMachineImage(app, machine, resolveMutableImage) {
  const imageRef = machine?.image_ref;
  if (
    imageRef?.registry === "registry.fly.io" &&
    imageRef?.repository === app.app &&
    /^sha256:[a-f0-9]{64}$/.test(imageRef?.digest ?? "")
  ) {
    return `${imageRef.registry}/${imageRef.repository}@${imageRef.digest}`;
  }
  const configuredImage = machine?.config?.image;
  if (isImmutableAppImage(app, configuredImage)) return configuredImage;
  if (
    typeof resolveMutableImage === "function" &&
    typeof configuredImage === "string"
  ) {
    const resolved = resolveMutableImage(configuredImage);
    if (isImmutableAppImage(app, resolved)) return resolved;
  }
  return null;
}

function normalizedMachineStopConfig(stopConfig, options = {}) {
  if (stopConfig == null) return null;
  const result = {};
  if (stopConfig.signal != null) result.signal = String(stopConfig.signal);
  if (stopConfig.timeout != null) {
    if (
      options.numericNanoseconds === true &&
      typeof stopConfig.timeout === "number"
    ) {
      result.timeout =
        Number.isSafeInteger(stopConfig.timeout) &&
        stopConfig.timeout >= 0 &&
        stopConfig.timeout % 1_000_000 === 0
          ? stopConfig.timeout / 1_000_000
          : `invalid-nanoseconds:${stopConfig.timeout}`;
    } else {
      result.timeout =
        parseFlyDurationMilliseconds(stopConfig.timeout) ??
        String(stopConfig.timeout);
    }
  }
  for (const key of Object.keys(stopConfig)) {
    if (!["signal", "timeout"].includes(key)) {
      result[`unexpected:${key}`] = stopConfig[key];
    }
  }
  return result;
}

function compareObject(actual, expected, label, errors, durationKeys = []) {
  const normalizedDurationKeys = new Set(durationKeys);
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = actual?.[key];
    if (
      actualValue !== expectedValue &&
      !(
        normalizedDurationKeys.has(key) &&
        flyDurationsEqual(actualValue, expectedValue)
      )
    ) {
      errors.push(
        `${label}.${key}: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actualValue)}`,
      );
    }
  }
}

function compareExactObject(
  actual,
  expected,
  label,
  errors,
  durationKeys = [],
) {
  compareObject(actual, expected, label, errors, durationKeys);
  for (const key of Object.keys(actual ?? {})) {
    if (!(key in (expected ?? {}))) {
      errors.push(`${label}.${key}: live-only value`);
    }
  }
}

function normalizeMounts(mounts) {
  return (mounts ?? [])
    .map((mount) => ({
      source: mount?.source,
      destination: mount?.destination,
    }))
    .sort((left, right) =>
      `${left.source ?? ""}\0${left.destination ?? ""}`.localeCompare(
        `${right.source ?? ""}\0${right.destination ?? ""}`,
      ),
    );
}

function readMachineConfigProfile(rootDir, selectedConfigPath, app) {
  const configPath = path.isAbsolute(selectedConfigPath)
    ? selectedConfigPath
    : path.join(rootDir, selectedConfigPath);
  const configText = fs.readFileSync(configPath, "utf8");
  const tables = readTomlTables(configText);
  const root = tableAssignments(tables, "");
  const httpService = tableAssignments(tables, "http_service");
  const configuredServiceGroups = parseStringArray(
    String(httpService.processes ?? ""),
  );
  return {
    configPath,
    configText,
    tables,
    root,
    build: tableAssignments(tables, "build"),
    deploy: tableAssignments(tables, "deploy"),
    env: tableAssignments(tables, "env"),
    processes: tableAssignments(tables, "processes"),
    httpService,
    httpChecks: tableAssignmentGroups(configText, "http_service.checks"),
    mount: tableAssignments(tables, "mounts"),
    serviceGroups: [
      ...(configuredServiceGroups.length > 0
        ? configuredServiceGroups
        : app.serviceProcessGroups),
    ].sort(),
  };
}

function hasReleaseCommandMarker(machine) {
  const metadata = machine?.config?.metadata ?? {};
  const env = machine?.config?.env ?? {};
  return (
    metadata.fly_process_group === FLY_RELEASE_COMMAND_PROCESS_GROUP ||
    env.FLY_PROCESS_GROUP === FLY_RELEASE_COMMAND_PROCESS_GROUP ||
    Object.hasOwn(env, "RELEASE_COMMAND")
  );
}

function isEmptyMachineCollection(value) {
  return (
    value == null ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value).length === 0)
  );
}

function normalizedReleaseMachineGuest(guest) {
  if (!guest || typeof guest !== "object" || Array.isArray(guest)) return null;
  const allowedKeys = new Set(["cpu_kind", "cpus", "memory_mb"]);
  if (Object.keys(guest).some((key) => !allowedKeys.has(key))) return null;
  const normalized = {
    cpu_kind: String(guest.cpu_kind ?? ""),
    cpus: Number(guest.cpus),
    memory_mb: Number(guest.memory_mb),
  };
  return new Set(["shared", "performance"]).has(normalized.cpu_kind) &&
    Number.isSafeInteger(normalized.cpus) &&
    normalized.cpus > 0 &&
    normalized.cpus <= 32 &&
    Number.isSafeInteger(normalized.memory_mb) &&
    normalized.memory_mb >= 256 &&
    normalized.memory_mb <= 131_072
    ? normalized
    : null;
}

function releaseMachineTuple(app, profile, image, identity, name) {
  const releaseCommand = String(profile.deploy.release_command ?? "");
  if (releaseCommand.length === 0) return null;
  const expectedEnv = {
    ...profile.env,
    FLY_PROCESS_GROUP: FLY_RELEASE_COMMAND_PROCESS_GROUP,
    RELEASE_COMMAND: "1",
    LEADERBOT_DEPLOYMENT_IDENTITY: identity,
  };
  if (profile.root.primary_region) {
    expectedEnv.PRIMARY_REGION = String(profile.root.primary_region);
  }
  const expectedStopConfig =
    profile.root.kill_signal != null || profile.root.kill_timeout != null
      ? normalizedMachineStopConfig({
          signal: profile.root.kill_signal,
          timeout: profile.root.kill_timeout,
        })
      : null;
  return {
    name,
    image,
    identity,
    profile,
    expectedEnv: sortedStringRecord(expectedEnv),
    expectedInit: { cmd: splitFlyProcessCommand(releaseCommand) },
    expectedStopConfig,
  };
}

/**
 * Selects the sole Fly release-command Machine that a recovery retry may
 * destroy. The selector returns null when no release Machine exists and throws
 * for every partial, crossed, duplicated, or unreviewed shape.
 */
export function classifyRecoveryReleaseCommandMachines(
  target,
  machines,
  options = {},
) {
  const rootDir = options.rootDir ?? process.cwd();
  if (target !== "image-gen") {
    fail("release-command recovery cleanup is available only for image-gen");
  }
  const app = validateDeploymentEnabled(target, rootDir);
  const interruptedIdentity = options.interruptedDeploymentIdentity;
  const capturedPriorIdentity = options.capturedPriorIdentity;
  const capturedPriorImage = options.capturedPriorImage;
  if (
    !/^deploy-[0-9]+-[0-9]+$/.test(interruptedIdentity ?? "") ||
    !/^(?:none|deploy-[0-9]+-[0-9]+)$/.test(capturedPriorIdentity ?? "") ||
    capturedPriorIdentity === interruptedIdentity ||
    typeof capturedPriorImage !== "string"
  ) {
    fail(
      "release-command cleanup requires the exact interrupted and prior recovery tuple",
    );
  }
  validateReviewedRollbackImage(target, capturedPriorImage, rootDir);
  const capturedConfig = getReviewedRestoreConfig(
    target,
    capturedPriorImage,
    capturedPriorIdentity,
    rootDir,
  );
  const tuples = [
    releaseMachineTuple(
      app,
      readMachineConfigProfile(rootDir, app.config, app),
      app.reviewedImage,
      interruptedIdentity,
      "interrupted candidate",
    ),
    releaseMachineTuple(
      app,
      readMachineConfigProfile(rootDir, capturedConfig, app),
      capturedPriorImage,
      capturedPriorIdentity,
      "captured rollback",
    ),
  ].filter(Boolean);
  if (!Array.isArray(machines)) {
    fail("release-command cleanup requires a Fly Machine list");
  }
  const candidates = machines.filter(hasReleaseCommandMarker);
  if (candidates.length > 2) {
    fail(
      "release-command cleanup permits at most two exact temporary Machines",
    );
  }

  const classifyCandidate = (machine) => {
    const errors = [];
    if (!/^[a-f0-9]{14}$/.test(String(machine?.id ?? ""))) {
      errors.push("invalid Machine id");
    }
    if (
      !new Set([
        "created",
        "starting",
        "started",
        "stopping",
        "stopped",
        "suspended",
        "failed",
        "destroying",
        "destroyed",
      ]).has(machine?.state)
    ) {
      errors.push("invalid Machine state");
    }
    const imageRef = machine?.image_ref;
    const machineImage =
      imageRef?.registry === "registry.fly.io" &&
      imageRef?.repository === app.app &&
      /^sha256:[a-f0-9]{64}$/.test(imageRef?.digest ?? "")
        ? `${imageRef.registry}/${imageRef.repository}@${imageRef.digest}`
        : null;
    if (!machineImage) errors.push("missing exact immutable image_ref");
    const env = machine?.config?.env ?? {};
    const machineIdentity = Object.hasOwn(env, "LEADERBOT_DEPLOYMENT_IDENTITY")
      ? String(env.LEADERBOT_DEPLOYMENT_IDENTITY)
      : null;
    const tuple = tuples.find(
      (candidate) =>
        candidate.image === machineImage &&
        candidate.identity === machineIdentity,
    );
    if (!tuple)
      errors.push("image and identity are outside the exact recovery tuples");

    const config = machine?.config ?? {};
    const allowedConfigKeys = new Set([
      "auto_destroy",
      "checks",
      "dns",
      "env",
      "files",
      "guest",
      "image",
      "init",
      "metadata",
      "mounts",
      "restart",
      "services",
      "statics",
      "stop_config",
    ]);
    if (Object.keys(config).some((key) => !allowedConfigKeys.has(key))) {
      errors.push("unreviewed MachineConfig field");
    }
    if (config.auto_destroy !== true) errors.push("auto_destroy is not true");
    for (const key of ["checks", "files", "mounts", "services", "statics"]) {
      if (!isEmptyMachineCollection(config[key])) {
        errors.push(`${key} are not empty`);
      }
    }
    if (
      JSON.stringify(config.restart ?? null) !==
      JSON.stringify({ policy: "no" })
    ) {
      errors.push("restart policy is not exact");
    }
    if (
      JSON.stringify(config.dns ?? null) !==
      JSON.stringify({ skip_registration: true })
    ) {
      errors.push("DNS policy is not exact");
    }
    const configuredImage = String(config.image ?? "");
    const escapedApp = app.app.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (
      configuredImage !== machineImage &&
      !new RegExp(
        `^registry\\.fly\\.io/${escapedApp}:deployment-[A-Za-z0-9._-]+$`,
      ).test(configuredImage)
    ) {
      errors.push("config.image is not the exact app digest or deployment tag");
    }

    const metadata = config.metadata ?? {};
    const exactMetadataKeys = [
      "fly_flyctl_version",
      "fly_platform_version",
      "fly_process_group",
      "fly_release_id",
      "fly_release_version",
    ];
    if (
      JSON.stringify(Object.keys(metadata).sort()) !==
        JSON.stringify(exactMetadataKeys) ||
      metadata.fly_platform_version !== "v2" ||
      metadata.fly_process_group !== FLY_RELEASE_COMMAND_PROCESS_GROUP ||
      !new RegExp(
        `^(?:v)?${PINNED_FLYCTL_VERSION.replaceAll(".", "\\.")}$`,
      ).test(String(metadata.fly_flyctl_version ?? "")) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(String(metadata.fly_release_id ?? "")) ||
      !/^[1-9][0-9]*$/.test(String(metadata.fly_release_version ?? ""))
    ) {
      errors.push("platform release metadata is not exact");
    }

    if (tuple) {
      if (machine.region !== tuple.profile.root.primary_region) {
        errors.push("region differs from the exact reviewed config");
      }
      if (
        JSON.stringify(normalizedMachineInit(config.init)) !==
        JSON.stringify(tuple.expectedInit)
      ) {
        errors.push("init command differs from the exact reviewed config");
      }
      if (
        JSON.stringify(sortedStringRecord(env)) !==
        JSON.stringify(tuple.expectedEnv)
      ) {
        errors.push("environment differs from the exact recovery tuple");
      }
      if (!normalizedReleaseMachineGuest(config.guest)) {
        errors.push(
          "guest resources are outside the bounded Fly release profile",
        );
      }
      if (
        JSON.stringify(
          normalizedMachineStopConfig(config.stop_config, {
            numericNanoseconds: true,
          }),
        ) !== JSON.stringify(tuple.expectedStopConfig)
      ) {
        errors.push(
          "stop configuration differs from the exact reviewed config",
        );
      }
    }
    if (errors.length > 0) {
      fail(
        `release-command Machine is not safe to destroy: ${[
          ...new Set(errors),
        ].join("; ")}`,
      );
    }
    return {
      id: machine.id,
      tuple: tuple.name,
      needsDestroy: !new Set(["destroying", "destroyed"]).has(machine.state),
    };
  };
  const classified = candidates.map(classifyCandidate);
  if (
    new Set(classified.map((machine) => machine.tuple)).size !==
    classified.length
  ) {
    fail(
      "release-command cleanup permits at most one Machine per exact recovery tuple",
    );
  }
  return classified.map(({ id, needsDestroy }) => ({ id, needsDestroy }));
}

export function checkLiveFlyDrift(target, options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const run = options.runFly ?? ((args) => runFly(args, rootDir));
  const manifest = loadProductionManifest(rootDir);
  const app = manifest.apps[target];
  if (!app) fail(`Unknown production target: ${target}`);
  const allowScaleCountDrift = options.allowScaleCountDrift === true;
  const allowInterruptedScaleCountDrift =
    options.allowInterruptedScaleCountDrift === true;
  const allowFirstTrustedBootstrapDrift =
    options.allowFirstTrustedBootstrapDrift === true;
  const allowStorageProxyFirstTrustedBootstrapDrift =
    options.allowStorageProxyFirstTrustedBootstrapDrift === true;
  if (
    allowFirstTrustedBootstrapDrift &&
    allowStorageProxyFirstTrustedBootstrapDrift
  ) {
    fail("first trusted bootstrap drift allowances are mutually exclusive");
  }
  const capturedPriorImage = options.capturedPriorImage;
  if (
    allowInterruptedScaleCountDrift &&
    (options.allowReviewedRollbackImage !== true ||
      options.expectedImage !== undefined ||
      options.configPath !== undefined ||
      !/^deploy-[0-9]+-[0-9]+$/.test(
        options.expectedDeploymentIdentity ?? "",
      ) ||
      !/^(?:none|deploy-[0-9]+-[0-9]+)$/.test(
        options.capturedPriorIdentity ?? "",
      ) ||
      options.capturedPriorIdentity === options.expectedDeploymentIdentity)
  ) {
    fail(
      "interrupted count drift allowance requires exact reviewed predeploy context",
    );
  }
  if (allowInterruptedScaleCountDrift) {
    validateReviewedRollbackImage(target, capturedPriorImage, rootDir);
    getReviewedRestoreConfig(
      target,
      capturedPriorImage,
      options.capturedPriorIdentity,
      rootDir,
    );
  }
  if (allowScaleCountDrift) {
    if (
      options.expectedImage === undefined ||
      options.configPath === undefined ||
      options.allowReviewedMachineImages !== true ||
      capturedPriorImage !== options.expectedImage
    ) {
      fail(
        "scale count drift allowance requires restored-release verification context",
      );
    }
    if (
      !Object.hasOwn(options, "expectedDeploymentIdentity") ||
      !/^(?:none|deploy-[0-9]+-[0-9]+)$/.test(
        options.expectedDeploymentIdentity,
      ) ||
      options.capturedPriorIdentity !== options.expectedDeploymentIdentity ||
      !/^deploy-[0-9]+-[0-9]+$/.test(
        options.interruptedDeploymentIdentity ?? "",
      ) ||
      options.interruptedDeploymentIdentity ===
        options.expectedDeploymentIdentity
    ) {
      fail(
        "scale count drift allowance requires the exact captured prior identity",
      );
    }
    validateReviewedRollbackImage(target, options.expectedImage, rootDir);
    assertReviewedRestoreConfigCopy(
      target,
      options.expectedImage,
      options.capturedPriorIdentity,
      options.configPath,
      rootDir,
    );
  }

  const live = JSON.parse(run(["config", "show", "--app", app.app]));
  const machines = JSON.parse(
    run(["machine", "list", "--app", app.app, "--json"]),
  );
  const scale = JSON.parse(run(["scale", "show", "--app", app.app, "--json"]));
  const selectedConfigPath = options.configPath ?? app.config;
  const selectedProfile = readMachineConfigProfile(
    rootDir,
    selectedConfigPath,
    app,
  );
  const {
    configText,
    root: expectedRoot,
    build: expectedBuild,
    deploy: expectedDeploy,
    env: expectedEnv,
    processes: expectedProcesses,
    httpService: expectedHttpService,
    httpChecks: expectedHttpChecks,
    mount: configuredMount,
  } = selectedProfile;
  const expectedMounts = Object.keys(configuredMount).length
    ? [configuredMount]
    : [];
  const currentMachineProfile =
    selectedConfigPath === app.config
      ? selectedProfile
      : readMachineConfigProfile(rootDir, app.config, app);
  const capturedPriorMachineProfile =
    allowScaleCountDrift || allowInterruptedScaleCountDrift
      ? readMachineConfigProfile(
          rootDir,
          getReviewedRestoreConfig(
            target,
            capturedPriorImage,
            options.capturedPriorIdentity,
            rootDir,
          ),
          app,
        )
      : null;
  const expectedImage = options.expectedImage ?? app.reviewedImage;
  const reconcilableDrift = [];
  const blockingErrors = [];
  const expectedDeploymentIdentity =
    options.expectedDeploymentIdentity ?? "none";
  if (
    !/^(?:none|(?:deploy|rollback)-[0-9]+-[0-9]+)$/.test(
      expectedDeploymentIdentity,
    )
  ) {
    fail("expected deployment identity is invalid");
  }
  if (allowFirstTrustedBootstrapDrift) {
    const transition = app.databaseSchemaTransition;
    if (
      target !== "image-gen" ||
      expectedDeploymentIdentity !== "none" ||
      transition?.state !== "bridge_reviewed" ||
      options.expectedImage !== transition.legacyBaseImage ||
      !allowsFirstTrustedBootstrap(target, app, options.expectedImage)
    ) {
      fail(
        "first trusted bootstrap drift requires the exact reviewed image-gen legacy predecessor",
      );
    }
    assertReviewedRestoreConfigCopy(
      target,
      options.expectedImage,
      expectedDeploymentIdentity,
      selectedConfigPath,
      rootDir,
      "first trusted bootstrap drift requires the exact reviewed image-gen legacy predecessor",
    );
  }
  if (allowStorageProxyFirstTrustedBootstrapDrift) {
    const transition = app.artifactTransition;
    if (
      target !== "storage-proxy" ||
      expectedDeploymentIdentity !== "none" ||
      transition?.state !== "runtime_reviewed" ||
      app.reviewedArtifactKind !== "runtime" ||
      options.expectedImage !== transition.legacyImage ||
      !allowsFirstTrustedBootstrap(target, app, options.expectedImage)
    ) {
      fail(
        "storage-proxy first trusted bootstrap drift requires the exact reviewed legacy predecessor",
      );
    }
    assertReviewedRestoreConfigCopy(
      target,
      options.expectedImage,
      expectedDeploymentIdentity,
      selectedConfigPath,
      rootDir,
      "storage-proxy first trusted bootstrap drift requires the exact reviewed legacy predecessor",
    );
  }
  const acceptedBootstrapDrift = [];
  if (allowStorageProxyFirstTrustedBootstrapDrift) {
    const legacyMachine = machines[0];
    const exactSingleAppMachine =
      machines.length === 1 &&
      legacyMachine?.state === "started" &&
      legacyMachine?.region === selectedProfile.root.primary_region &&
      legacyMachine?.config?.metadata?.fly_process_group === "app" &&
      JSON.stringify(Object.keys(app.desiredScale).sort()) ===
        JSON.stringify(["app"]) &&
      app.desiredScale.app?.count === 1;
    if (!exactSingleAppMachine) {
      blockingErrors.push(
        "storage-proxy first trusted bootstrap requires one exact started app Machine",
      );
    }
  }
  const liveEnv = { ...(live.env ?? {}) };
  const actualDeploymentIdentity =
    liveEnv.LEADERBOT_DEPLOYMENT_IDENTITY ?? "none";
  delete liveEnv.LEADERBOT_DEPLOYMENT_IDENTITY;
  const canonicalEnv = { ...expectedEnv };
  delete canonicalEnv.LEADERBOT_DEPLOYMENT_IDENTITY;
  if (actualDeploymentIdentity !== expectedDeploymentIdentity) {
    blockingErrors.push(
      `deployment identity: expected ${expectedDeploymentIdentity}, got ${actualDeploymentIdentity}`,
    );
  }

  if (live.app !== app.app)
    blockingErrors.push(`live app mismatch: ${live.app}`);
  for (const key of ["primary_region", "kill_signal", "kill_timeout"]) {
    if (
      key in expectedRoot &&
      live[key] !== expectedRoot[key] &&
      !(
        key === "kill_timeout" &&
        flyDurationsEqual(live[key], expectedRoot[key])
      )
    ) {
      const drift = `${key}: expected ${JSON.stringify(expectedRoot[key])}, got ${JSON.stringify(live[key])}`;
      (key === "primary_region" ? reconcilableDrift : blockingErrors).push(
        drift,
      );
    }
  }
  compareExactObject(live.build, expectedBuild, "build", blockingErrors);
  const liveDeployIsObject =
    live.deploy != null &&
    typeof live.deploy === "object" &&
    !Array.isArray(live.deploy);
  const storageProxyDeployRepresentationIsCanonical =
    target === "storage-proxy" &&
    Object.keys(expectedDeploy).length === 0 &&
    (live.deploy == null ||
      (liveDeployIsObject && Object.keys(live.deploy).length === 0) ||
      (liveDeployIsObject &&
        Object.keys(live.deploy).length === 1 &&
        live.deploy.strategy === app.strategy));
  if (storageProxyDeployRepresentationIsCanonical) {
    if (
      allowStorageProxyFirstTrustedBootstrapDrift &&
      live.deploy == null
    ) {
      acceptedBootstrapDrift.push(
        "legacy Fly config omits the transient rolling deploy strategy",
      );
    }
  } else {
    const canonicalDeploy = {
      strategy: expectedDeploy.strategy ?? app.strategy,
      ...expectedDeploy,
    };
    compareExactObject(live.deploy, canonicalDeploy, "deploy", blockingErrors, [
      "release_command_timeout",
    ]);
  }
  compareObject(liveEnv, canonicalEnv, "env", blockingErrors);
  for (const liveKey of Object.keys(liveEnv)) {
    if (!(liveKey in canonicalEnv)) {
      blockingErrors.push(`env.${liveKey}: live-only value`);
    }
  }
  if (
    JSON.stringify(live.processes ?? {}) !== JSON.stringify(expectedProcesses)
  ) {
    blockingErrors.push(
      "live process commands differ from the production fly.toml",
    );
  }
  if (
    live.services != null &&
    (!Array.isArray(live.services) || live.services.length > 0)
  ) {
    blockingErrors.push(
      "live top-level services are not present in the reviewed config",
    );
  }
  if (
    live.files != null &&
    (!Array.isArray(live.files) || live.files.length > 0)
  ) {
    blockingErrors.push(
      "live top-level files are not present in the reviewed config",
    );
  }
  const expectedServiceGroups = selectedProfile.serviceGroups;
  const liveServiceGroups = [...(live.http_service?.processes ?? [])].sort();
  const storageProxySingleProcessOmissionIsCanonical =
    target === "storage-proxy" &&
    !Object.hasOwn(live.http_service ?? {}, "processes") &&
    JSON.stringify(liveServiceGroups) === "[]" &&
    JSON.stringify(expectedServiceGroups) === JSON.stringify(["app"]) &&
    JSON.stringify(Object.keys(app.desiredScale).sort()) ===
      JSON.stringify(["app"]);
  if (storageProxySingleProcessOmissionIsCanonical) {
    if (allowStorageProxyFirstTrustedBootstrapDrift) {
      acceptedBootstrapDrift.push(
        "legacy Fly config omits the sole app HTTP service process group",
      );
    }
  } else if (
    JSON.stringify(liveServiceGroups) !== JSON.stringify(expectedServiceGroups)
  ) {
    reconcilableDrift.push(
      "live HTTP service process groups differ from the manifest",
    );
  }
  for (const key of [
    "internal_port",
    "force_https",
    "auto_stop_machines",
    "auto_start_machines",
    "min_machines_running",
  ]) {
    const actualHttpServiceValue = live.http_service?.[key];
    const expectedHttpServiceValue = expectedHttpService[key];
    const normalizedAutoStopMatch =
      key === "auto_stop_machines" &&
      normalizedAutostop(actualHttpServiceValue) ===
        normalizedAutostop(expectedHttpServiceValue);
    if (
      key in expectedHttpService &&
      actualHttpServiceValue !== expectedHttpServiceValue &&
      !normalizedAutoStopMatch
    ) {
      const drift = `http_service.${key}: expected ${JSON.stringify(expectedHttpService[key])}, got ${JSON.stringify(live.http_service?.[key])}`;
      (["internal_port", "force_https"].includes(key)
        ? blockingErrors
        : reconcilableDrift
      ).push(drift);
    } else if (
      key === "auto_stop_machines" &&
      allowStorageProxyFirstTrustedBootstrapDrift &&
      actualHttpServiceValue === true &&
      expectedHttpServiceValue === "stop"
    ) {
      acceptedBootstrapDrift.push(
        "legacy Fly config reports auto-stop stop as boolean true",
      );
    }
  }
  const liveCheckPaths = (live.http_service?.checks ?? [])
    .map((check) => check.path)
    .filter(Boolean)
    .sort();
  if (expectedHttpChecks.length > 0) {
    const liveChecks = [...(live.http_service?.checks ?? [])].sort(
      (left, right) =>
        String(left.path ?? "").localeCompare(String(right.path ?? "")),
    );
    const canonicalChecks = [...expectedHttpChecks].sort((left, right) =>
      String(left.path ?? "").localeCompare(String(right.path ?? "")),
    );
    if (liveChecks.length !== canonicalChecks.length) {
      reconcilableDrift.push(
        `live HTTP service must have exactly ${canonicalChecks.length} canonical checks; found ${liveChecks.length}`,
      );
    } else {
      canonicalChecks.forEach((expectedCheck, index) => {
        compareObject(
          liveChecks[index],
          expectedCheck,
          `http_service.checks[${index}]`,
          reconcilableDrift,
        );
      });
    }
  }
  if (options.configPath) {
    const expectedCheckPaths = allAssignments(configText, "path")
      .filter((value) => String(value).startsWith("/"))
      .map(String)
      .sort();
    if (JSON.stringify(liveCheckPaths) !== JSON.stringify(expectedCheckPaths)) {
      reconcilableDrift.push(
        "live service checks differ from the captured Fly configuration",
      );
    }
  } else if (!liveCheckPaths.includes(app.serviceCheckPath)) {
    reconcilableDrift.push(
      `live service check must use ${app.serviceCheckPath}`,
    );
  }
  const liveMounts = normalizeMounts(live.mounts);
  if (
    JSON.stringify(liveMounts) !==
    JSON.stringify(normalizeMounts(expectedMounts))
  ) {
    blockingErrors.push(
      "live volume mounts differ from the production fly.toml",
    );
  }

  for (const machine of machines) {
    const metadata = machine.config?.metadata ?? {};
    const machineIdentity =
      machine.config?.env?.LEADERBOT_DEPLOYMENT_IDENTITY ?? "none";
    const actualMachineImage = immutableMachineImage(
      app,
      machine,
      options.resolveMachineImage,
    );
    let machineProfile = selectedProfile;
    if (allowInterruptedScaleCountDrift || allowScaleCountDrift) {
      const currentIdentity = allowInterruptedScaleCountDrift
        ? expectedDeploymentIdentity
        : options.interruptedDeploymentIdentity;
      const priorIdentity = allowInterruptedScaleCountDrift
        ? options.capturedPriorIdentity
        : expectedDeploymentIdentity;
      const currentTuple =
        actualMachineImage === app.reviewedImage &&
        machineIdentity === currentIdentity;
      const priorTuple =
        actualMachineImage === capturedPriorImage &&
        machineIdentity === priorIdentity;
      if (currentTuple) {
        machineProfile = currentMachineProfile;
      } else if (priorTuple) {
        machineProfile = capturedPriorMachineProfile;
      } else if (metadata.fly_process_group) {
        blockingErrors.push(
          `Machine ${machine.id} is outside the exact prior/current recovery tuple`,
        );
      }
    }
    const bootstrapRegionDrift =
      allowFirstTrustedBootstrapDrift &&
      metadata.fly_process_group === "app" &&
      machineProfile.root.primary_region === "ams" &&
      machine.region === "fra";
    if (
      machine.region !== machineProfile.root.primary_region &&
      !bootstrapRegionDrift
    ) {
      blockingErrors.push(
        `Machine ${machine.id} region differs from its exact reviewed release config`,
      );
    } else if (bootstrapRegionDrift) {
      acceptedBootstrapDrift.push(
        `Machine ${machine.id} legacy app region will be reconciled`,
      );
    }
    const allowedMachineConfigKeys = new Set([
      "env",
      "init",
      "guest",
      "metadata",
      "mounts",
      "services",
      "image",
      "stop_config",
      "restart",
      "dns",
      "auto_destroy",
    ]);
    const unexpectedMachineConfigKeys = Object.keys(
      machine.config ?? {},
    ).filter(
      (key) =>
        !allowedMachineConfigKeys.has(key) &&
        !(allowFirstTrustedBootstrapDrift && key === "standbys"),
    );
    if (unexpectedMachineConfigKeys.length > 0) {
      blockingErrors.push(
        `Machine ${machine.id} has unreviewed MachineConfig fields: ${unexpectedMachineConfigKeys.sort().join(", ")}`,
      );
    }
    if (
      machine.config?.auto_destroy != null &&
      machine.config.auto_destroy !== false
    ) {
      blockingErrors.push(`Machine ${machine.id} must not auto-destroy`);
    }
    const dns = machine.config?.dns;
    if (
      dns != null &&
      (Object.keys(dns).some((key) => key !== "skip_registration") ||
        dns.skip_registration === true)
    ) {
      blockingErrors.push(`Machine ${machine.id} has unreviewed DNS policy`);
    }
    const restart = machine.config?.restart;
    if (
      restart != null &&
      (restart.policy !== "on-failure" ||
        (restart.max_retries != null && Number(restart.max_retries) !== 10) ||
        Object.keys(restart).some(
          (key) => !["policy", "max_retries"].includes(key),
        ))
    ) {
      blockingErrors.push(
        `Machine ${machine.id} has unreviewed restart policy`,
      );
    }
    const expectedStopConfig =
      machineProfile.root.kill_signal != null ||
      machineProfile.root.kill_timeout != null
        ? normalizedMachineStopConfig({
            signal: machineProfile.root.kill_signal,
            timeout: machineProfile.root.kill_timeout,
          })
        : null;
    if (
      JSON.stringify(
        normalizedMachineStopConfig(machine.config?.stop_config, {
          numericNanoseconds: true,
        }),
      ) !== JSON.stringify(expectedStopConfig)
    ) {
      blockingErrors.push(
        `Machine ${machine.id} stop configuration differs from the reviewed config`,
      );
    }
    const allowedMetadataKeys = new Set([
      "fly_platform_version",
      "fly_process_group",
      "fly_release_id",
      "fly_release_version",
      "fly_flyctl_version",
      "fly_builder_id",
      "fly_previous_alloc",
      "fly_bluegreen_deployment_tag",
    ]);
    const unexpectedMetadataKeys = Object.keys(metadata).filter(
      (key) => !allowedMetadataKeys.has(key),
    );
    if (unexpectedMetadataKeys.length > 0) {
      blockingErrors.push(`Machine ${machine.id} has unreviewed metadata`);
    }
    const hasBuilderId = Object.hasOwn(metadata, "fly_builder_id");
    const builderId = metadata.fly_builder_id;
    if (
      hasBuilderId &&
      (typeof builderId !== "string" || !/^[a-f0-9]{14}$/.test(builderId))
    ) {
      blockingErrors.push(`Machine ${machine.id} has invalid builder metadata`);
    } else if (allowFirstTrustedBootstrapDrift && hasBuilderId) {
      acceptedBootstrapDrift.push(
        `Machine ${machine.id} legacy builder metadata will be replaced`,
      );
    }
    if (
      metadata.fly_release_version != null &&
      !/^[0-9]+$/.test(String(metadata.fly_release_version))
    ) {
      blockingErrors.push(`Machine ${machine.id} has invalid release metadata`);
    }
    const exactStorageProxyLegacyFlyctlVersion =
      allowStorageProxyFirstTrustedBootstrapDrift &&
      metadata.fly_flyctl_version === app.artifactTransition.legacyFlyctlVersion;
    const usesPinnedFlyctlVersion =
      typeof metadata.fly_flyctl_version === "string" &&
      /^(?:v)?0\.4\.85$/.test(metadata.fly_flyctl_version);
    if (
      allowStorageProxyFirstTrustedBootstrapDrift &&
      !exactStorageProxyLegacyFlyctlVersion &&
      !usesPinnedFlyctlVersion
    ) {
      blockingErrors.push(
        `Machine ${machine.id} does not match the reviewed legacy or pinned flyctl version`,
      );
    } else if (
      metadata.fly_flyctl_version != null &&
      !usesPinnedFlyctlVersion &&
      !exactStorageProxyLegacyFlyctlVersion
    ) {
      blockingErrors.push(
        `Machine ${machine.id} was not reconciled by pinned flyctl`,
      );
    } else if (exactStorageProxyLegacyFlyctlVersion) {
      acceptedBootstrapDrift.push(
        `Machine ${machine.id} uses the exact reviewed legacy flyctl version`,
      );
    }
    if (
      !app.allowDetachedMachines &&
      (metadata.fly_platform_version !== "v2" || !metadata.fly_process_group)
    ) {
      blockingErrors.push(`detached Machine detected: ${machine.id}`);
    }
    if (
      metadata.fly_process_group &&
      !(metadata.fly_process_group in app.desiredScale)
    ) {
      blockingErrors.push(`unexpected process group on Machine ${machine.id}`);
    }
    const desiredMachine = app.desiredScale[metadata.fly_process_group];
    if (desiredMachine) {
      const guest = machine.config?.guest;
      if (
        guest?.cpu_kind !== desiredMachine.cpuKind ||
        guest?.cpus !== desiredMachine.cpus ||
        guest?.memory_mb !== desiredMachine.memoryMb
      ) {
        blockingErrors.push(
          `Machine ${machine.id} guest resources differ from the manifest`,
        );
      }
      const unexpectedGuestKeys = Object.keys(guest ?? {}).filter(
        (key) => !["cpu_kind", "cpus", "memory_mb"].includes(key),
      );
      if (unexpectedGuestKeys.length > 0) {
        blockingErrors.push(
          `Machine ${machine.id} has unreviewed guest overrides`,
        );
      }
    }
    const processGroup = metadata.fly_process_group;
    if (processGroup in app.desiredScale) {
      const expectedInit = {
        cmd: splitFlyProcessCommand(
          String(machineProfile.processes[processGroup] ?? ""),
        ),
      };
      if (expectedInit.cmd.length === 0) delete expectedInit.cmd;
      if (
        JSON.stringify(normalizedMachineInit(machine.config?.init)) !==
        JSON.stringify(expectedInit)
      ) {
        blockingErrors.push(
          `Machine ${machine.id} init command differs from process group ${processGroup}`,
        );
      }

      const actualMachineEnv = { ...(machine.config?.env ?? {}) };
      delete actualMachineEnv.LEADERBOT_DEPLOYMENT_IDENTITY;
      const expectedMachineEnv = {
        ...machineProfile.env,
        FLY_PROCESS_GROUP: processGroup,
      };
      delete expectedMachineEnv.LEADERBOT_DEPLOYMENT_IDENTITY;
      if (machineProfile.root.primary_region) {
        expectedMachineEnv.PRIMARY_REGION = String(
          machineProfile.root.primary_region,
        );
      }
      const differingEnvironmentKeys = [
        ...new Set([
          ...Object.keys(actualMachineEnv),
          ...Object.keys(expectedMachineEnv),
        ]),
      ]
        .filter(
          (key) =>
            String(actualMachineEnv[key]) !== String(expectedMachineEnv[key]),
        )
        .sort();
      const exactLegacyCostDrift =
        allowFirstTrustedBootstrapDrift &&
        JSON.stringify(differingEnvironmentKeys) ===
          JSON.stringify([
            "MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD",
            "OPENAI_IMAGE_ESTIMATED_COST_USD",
          ]) &&
        actualMachineEnv.MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD === "50.00" &&
        actualMachineEnv.OPENAI_IMAGE_ESTIMATED_COST_USD === "0.30" &&
        expectedMachineEnv.MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD === "25.00" &&
        expectedMachineEnv.OPENAI_IMAGE_ESTIMATED_COST_USD === "1.00";
      if (differingEnvironmentKeys.length > 0 && !exactLegacyCostDrift) {
        blockingErrors.push(
          `Machine ${machine.id} environment differs from the exact reviewed process environment`,
        );
      } else if (exactLegacyCostDrift) {
        acceptedBootstrapDrift.push(
          `Machine ${machine.id} legacy cost limits will be tightened`,
        );
      }

      const mountGroups = parseStringArray(
        String(machineProfile.mount.processes ?? ""),
      );
      const expectedMachineMounts =
        Object.keys(machineProfile.mount).length > 0 &&
        (mountGroups.length === 0 || mountGroups.includes(processGroup))
          ? [
              {
                source: machineProfile.mount.source,
                path: machineProfile.mount.destination,
              },
            ]
          : [];
      if (
        JSON.stringify(normalizedMachineMounts(machine.config?.mounts)) !==
        JSON.stringify(normalizedMachineMounts(expectedMachineMounts))
      ) {
        blockingErrors.push(
          `Machine ${machine.id} mounts differ from process group ${processGroup}`,
        );
      }

      const expectedServices = machineProfile.serviceGroups.includes(
        processGroup,
      )
        ? expectedMachineService(
            machineProfile.httpService,
            machineProfile.httpChecks,
          )
        : [];
      const actualServices = (machine.config?.services ?? []).map(
        normalizedMachineService,
      );
      if (JSON.stringify(actualServices) !== JSON.stringify(expectedServices)) {
        blockingErrors.push(
          `Machine ${machine.id} services differ from process group ${processGroup}`,
        );
      }
      if ((machine.config?.files ?? []).length > 0) {
        blockingErrors.push(
          `Machine ${machine.id} has unreviewed injected files`,
        );
      }
    }
    const standbyTargets = machine.config?.standbys;
    const validBootstrapStandby =
      allowFirstTrustedBootstrapDrift &&
      machine.state === "stopped" &&
      metadata.fly_process_group === "worker" &&
      Array.isArray(standbyTargets) &&
      standbyTargets.length === 1 &&
      machines.some(
        (candidate) =>
          candidate.id === standbyTargets[0] &&
          candidate.state === "started" &&
          candidate.config?.metadata?.fly_process_group === "worker" &&
          immutableMachineImage(app, candidate, options.resolveMachineImage) ===
            actualMachineImage,
      );
    if (
      allowFirstTrustedBootstrapDrift &&
      standbyTargets != null &&
      !validBootstrapStandby
    ) {
      blockingErrors.push(
        `Machine ${machine.id} has an invalid legacy standby binding`,
      );
    } else if (validBootstrapStandby) {
      acceptedBootstrapDrift.push(
        `Machine ${machine.id} legacy worker standby will be reconciled`,
      );
    }
    if (
      metadata.fly_process_group &&
      machine.state !== "started" &&
      !(
        allowInterruptedScaleCountDrift ||
        allowScaleCountDrift ||
        validBootstrapStandby
      )
    ) {
      blockingErrors.push(
        `Machine ${machine.id} in ${metadata.fly_process_group} is not started`,
      );
    }
    const allowedMachineIdentities = new Set([expectedDeploymentIdentity]);
    if (allowInterruptedScaleCountDrift) {
      allowedMachineIdentities.add(options.capturedPriorIdentity);
    }
    if (allowScaleCountDrift) {
      allowedMachineIdentities.add(options.interruptedDeploymentIdentity);
    }
    if (
      metadata.fly_process_group &&
      !allowedMachineIdentities.has(machineIdentity)
    ) {
      blockingErrors.push(
        `Machine ${machine.id} deployment identity is outside the exact recovery set`,
      );
    }
    if (
      actualMachineImage &&
      isImmutableAppImage(app, machine.config?.image) &&
      machine.config.image !== actualMachineImage
    ) {
      blockingErrors.push(
        `Machine ${machine.id} image_ref conflicts with config.image`,
      );
    }
    if (!actualMachineImage) {
      blockingErrors.push(
        `Machine ${machine.id} image cannot be bound to an immutable app digest`,
      );
    }
    if (expectedImage && actualMachineImage !== expectedImage) {
      const allowReviewedMachineImages =
        options.allowReviewedMachineImages === true ||
        (options.expectedImage === undefined &&
          options.allowReviewedRollbackImage === true);
      if (
        allowReviewedMachineImages &&
        (allowScaleCountDrift || allowInterruptedScaleCountDrift
          ? new Set([app.reviewedImage, capturedPriorImage]).has(
              actualMachineImage,
            )
          : reviewedProductionImages(app).has(actualMachineImage))
      ) {
        if (options.allowReviewedMachineImages !== true) {
          reconcilableDrift.push(
            `Machine ${machine.id} uses an approved rollback image before deployment`,
          );
        }
      } else if (allowReviewedMachineImages) {
        blockingErrors.push(
          `Machine ${machine.id} image is not an approved rollback image`,
        );
      } else {
        blockingErrors.push(
          options.expectedImage === undefined
            ? `Machine ${machine.id} image differs from the reviewed production digest`
            : `Machine ${machine.id} image differs from the captured rollback digest`,
        );
      }
    }
  }

  const scaleByProcess = Object.fromEntries(
    scale.map((entry) => [entry.Process, entry]),
  );
  for (const [process, desired] of Object.entries(app.desiredScale)) {
    const startedMachineCount = machines.filter(
      (machine) =>
        machine.state === "started" &&
        machine.config?.metadata?.fly_process_group === process,
    ).length;
    if (startedMachineCount !== desired.count) {
      const drift = `started Machines for ${process}: expected ${desired.count}, got ${startedMachineCount}`;
      if (allowFirstTrustedBootstrapDrift) {
        acceptedBootstrapDrift.push(drift);
      } else {
        (allowScaleCountDrift || allowInterruptedScaleCountDrift
          ? reconcilableDrift
          : blockingErrors
        ).push(drift);
      }
    }
    const actual = scaleByProcess[process];
    if (!actual) {
      const drift = `missing live scale for process group ${process}`;
      if (
        (allowScaleCountDrift || allowInterruptedScaleCountDrift) &&
        machines.length === 0 &&
        scale.length === 0
      ) {
        reconcilableDrift.push(drift);
      } else {
        blockingErrors.push(drift);
      }
      continue;
    }
    const actualScale = {
      count: actual.Count,
      cpuKind: actual.CPUKind,
      cpus: actual.CPUs,
      memoryMb: actual.Memory,
    };
    if (
      allowFirstTrustedBootstrapDrift &&
      actualScale.count !== desired.count
    ) {
      acceptedBootstrapDrift.push(
        `scale.${process}.count: expected ${JSON.stringify(desired.count)}, got ${JSON.stringify(actualScale.count)}`,
      );
    } else if (
      (allowScaleCountDrift || allowInterruptedScaleCountDrift) &&
      actualScale.count !== desired.count
    ) {
      reconcilableDrift.push(
        `scale.${process}.count: expected ${JSON.stringify(desired.count)}, got ${JSON.stringify(actualScale.count)}`,
      );
    } else if (actualScale.count !== desired.count) {
      blockingErrors.push(
        `scale.${process}.count: expected ${JSON.stringify(desired.count)}, got ${JSON.stringify(actualScale.count)}`,
      );
    }
    compareObject(
      {
        cpuKind: actualScale.cpuKind,
        cpus: actualScale.cpus,
        memoryMb: actualScale.memoryMb,
      },
      {
        cpuKind: desired.cpuKind,
        cpus: desired.cpus,
        memoryMb: desired.memoryMb,
      },
      `scale.${process}`,
      blockingErrors,
    );
  }
  for (const actual of scale) {
    if (!(actual.Process in app.desiredScale)) {
      blockingErrors.push(
        `unexpected live scale process group ${actual.Process}`,
      );
    }
  }

  if (options.allowReviewedRollbackImage === true) {
    const allowedMachineImageDrift = reconcilableDrift.filter(
      (drift) =>
        /^Machine .+ uses an approved rollback image before deployment$/.test(
          drift,
        ) ||
        (allowInterruptedScaleCountDrift &&
          /^(?:scale\.[^.]+\.count:|started Machines for |missing live scale for process group )/.test(
            drift,
          )),
    );
    for (const drift of reconcilableDrift) {
      if (!allowedMachineImageDrift.includes(drift)) {
        blockingErrors.push(drift);
      }
    }
    reconcilableDrift.splice(
      0,
      reconcilableDrift.length,
      ...allowedMachineImageDrift,
    );
  }

  return {
    target,
    app: app.app,
    reconcilableDrift,
    blockingErrors,
    acceptedBootstrapDrift,
  };
}

export async function checkSettledLiveFlyDrift(target, options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const underlyingRun = options.runFly ?? ((args) => runFly(args, rootDir));
  const run = (args) => {
    const command = args.slice(0, 2).join(" ");
    if (
      !new Set([
        "config show",
        "machine list",
        "scale show",
        "image show",
        "releases --app",
      ]).has(command)
    ) {
      fail(`settled-live preflight forbids Fly command: ${command}`);
    }
    return underlyingRun(args);
  };
  const app = loadProductionManifest(rootDir).apps[target];
  if (!app) fail(`Unknown production target: ${target}`);
  const configArgs = ["config", "show", "--app", app.app];
  const machineArgs = ["machine", "list", "--app", app.app, "--json"];
  const scaleArgs = ["scale", "show", "--app", app.app, "--json"];
  const cachedOutputs = new Map();
  for (const args of [configArgs, machineArgs, scaleArgs]) {
    cachedOutputs.set(args.join("\0"), run(args));
  }
  const live = JSON.parse(cachedOutputs.get(configArgs.join("\0")));
  const machines = JSON.parse(cachedOutputs.get(machineArgs.join("\0")));
  const identity = live?.env?.LEADERBOT_DEPLOYMENT_IDENTITY ?? "none";
  if (!/^(?:none|deploy-[0-9]+-[0-9]+)$/.test(identity)) {
    fail("live deployment identity is not a trusted settled baseline");
  }
  const rawMachineImages = new Set(
    machines.map((machine) => machine?.config?.image).filter(Boolean),
  );
  if (
    rawMachineImages.size === 0 &&
    machines.every((machine) => !immutableMachineImage(app, machine))
  ) {
    fail("settled-live preflight found no production Machine image");
  }
  let imageRecords = [];
  let releaseImage;
  if ([...rawMachineImages].some((image) => !isImmutableAppImage(app, image))) {
    imageRecords = JSON.parse(
      run(["image", "show", "--app", app.app, "--json"]),
    );
    const releases = JSON.parse(
      run(["releases", "--app", app.app, "--image", "--json"]),
    );
    releaseImage = releases
      .filter(
        (release) =>
          (release?.Status === "complete" || release?.Status === "running") &&
          typeof release?.ImageRef === "string",
      )
      .sort(
        (left, right) => Number(right.Version) - Number(left.Version),
      )[0]?.ImageRef;
    if (!releaseImage) {
      fail("settled-live preflight could not bind the current release image");
    }
  }
  const resolvedImages = new Map(
    [...rawMachineImages].map((image) => [
      image,
      isImmutableAppImage(app, image)
        ? image
        : resolveImmutableReleaseImage(target, image, imageRecords, rootDir),
    ]),
  );
  const immutableImages = new Set(
    machines.map((machine) => {
      const boundFromImageRef = immutableMachineImage(app, machine);
      const configuredImage = machine?.config?.image;
      const resolvedConfiguredImage = resolvedImages.get(configuredImage);
      if (
        boundFromImageRef &&
        resolvedConfiguredImage &&
        boundFromImageRef !== resolvedConfiguredImage
      ) {
        fail(
          `settled-live preflight Machine ${machine.id} image_ref conflicts with config.image`,
        );
      }
      const resolved = boundFromImageRef ?? resolvedConfiguredImage;
      if (!resolved) {
        fail(
          `settled-live preflight Machine ${machine.id} image cannot be resolved immutably`,
        );
      }
      return resolved;
    }),
  );
  if (immutableImages.size !== 1) {
    fail("settled-live preflight requires one uniform immutable Machine image");
  }
  const expectedImage = [...immutableImages][0];
  if (releaseImage) {
    const resolvedReleaseImage = isImmutableAppImage(app, releaseImage)
      ? releaseImage
      : resolveImmutableReleaseImage(
          target,
          releaseImage,
          imageRecords,
          rootDir,
        );
    if (resolvedReleaseImage !== expectedImage) {
      fail(
        "settled-live preflight Machine image does not match the current release",
      );
    }
  }
  if (!reviewedProductionImages(app).has(expectedImage)) {
    fail("settled-live preflight image is outside the reviewed allowlist");
  }
  if (
    options.requireCurrentReviewedImage === true &&
    expectedImage !== app.reviewedImage
  ) {
    fail(
      "successor live image is not the exact reviewed image from its source",
    );
  }
  const configPaths = [];
  if (expectedImage === app.reviewedImage) configPaths.push(app.config);
  if (options.requireCurrentReviewedImage !== true) {
    const settledPredecessorConfig = getReviewedSettledPredecessorConfig(
      target,
      identity,
      expectedImage,
      rootDir,
    );
    if (settledPredecessorConfig) configPaths.push(settledPredecessorConfig);
  }
  if (
    options.requireCurrentReviewedImage !== true &&
    app.reviewedRollbackImages?.includes(expectedImage)
  ) {
    configPaths.push(getReviewedRollbackConfig(target, expectedImage, rootDir));
  }
  const uniqueConfigPaths = [...new Set(configPaths)];
  if (uniqueConfigPaths.length === 0) {
    fail("settled-live preflight has no reviewed config for the live image");
  }
  const cachedRun = (args) => {
    const key = args.join("\0");
    if (!cachedOutputs.has(key))
      fail(`Unexpected uncached Fly read: ${args.join(" ")}`);
    return cachedOutputs.get(key);
  };
  const reviewedLegacyConfig =
    identity === "none" &&
    allowsFirstTrustedBootstrap(target, app, expectedImage)
      ? getReviewedRollbackConfig(target, expectedImage, rootDir)
      : null;
  const results = uniqueConfigPaths.map((configPath) =>
    checkLiveFlyDrift(target, {
      rootDir,
      runFly: cachedRun,
      expectedImage,
      configPath,
      expectedDeploymentIdentity: identity,
      allowFirstTrustedBootstrapDrift:
        target === "image-gen" &&
        reviewedLegacyConfig != null &&
        path.resolve(rootDir, configPath) ===
          path.resolve(rootDir, reviewedLegacyConfig),
      allowStorageProxyFirstTrustedBootstrapDrift:
        target === "storage-proxy" &&
        reviewedLegacyConfig != null &&
        path.resolve(rootDir, configPath) ===
          path.resolve(rootDir, reviewedLegacyConfig),
      resolveMachineImage: (image) => resolvedImages.get(image) ?? image,
    }),
  );
  const result =
    results.find(
      (candidate) =>
        candidate.blockingErrors.length === 0 &&
        candidate.reconcilableDrift.length === 0,
    ) ?? results[0];
  const errors = [...result.blockingErrors, ...result.reconcilableDrift];
  if (errors.length) return { ...result, identity, expectedImage };
  await verifySettledBaseline(target, identity, {
    ...options,
    rootDir,
    expectedImage,
  });
  return { ...result, identity, expectedImage };
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const enabledIndex = process.argv.indexOf("--validate-target-enabled");
  const reviewedIndex = process.argv.indexOf("--validate-reviewed-image");
  const sourceCommitIndex = process.argv.indexOf("--reviewed-source-commit");
  const artifactKindIndex = process.argv.indexOf("--reviewed-artifact-kind");
  const schemaMinimumIndex = process.argv.indexOf("--reviewed-schema-minimum");
  const schemaMaximumIndex = process.argv.indexOf("--reviewed-schema-maximum");
  const schemaPhaseIndex = process.argv.indexOf(
    "--validate-reviewed-schema-phase",
  );
  const reviewedCiIndex = process.argv.indexOf("--verify-reviewed-ci");
  const sourceCiIndex = process.argv.indexOf("--verify-source-ci");
  const resolveIndex = process.argv.indexOf("--resolve-release-image");
  const rollbackIndex = process.argv.indexOf("--validate-rollback-image");
  const rollbackConfigIndex = process.argv.indexOf(
    "--reviewed-rollback-config",
  );
  const restoreConfigIndex = process.argv.indexOf("--reviewed-restore-config");
  const legacyRollbackIndex = process.argv.indexOf(
    "--validate-legacy-transition-rollback",
  );
  const restoreIndex = process.argv.indexOf("--verify-restored-release");
  const settledBaselineIndex = process.argv.indexOf(
    "--verify-settled-baseline",
  );
  const deploymentCandidateIndex = process.argv.indexOf(
    "--verify-deployment-candidate",
  );
  const prepareSuccessorIndex = process.argv.indexOf(
    "--prepare-successor-root",
  );
  const recoveryReleaseMachinesIndex = process.argv.indexOf(
    "--recovery-release-command-machines",
  );
  const recoveryProtocolIndex = process.argv.indexOf(
    "--validate-recovery-protocol",
  );
  const scalePlanIndex = process.argv.indexOf("--reviewed-scale-plan");
  const settledLiveIndex = process.argv.indexOf("--settled-live");
  const liveIndex = process.argv.indexOf("--live");
  const deploymentIdentityIndex = process.argv.indexOf(
    "--expected-deployment-identity",
  );
  const expectedDeploymentIdentity =
    deploymentIdentityIndex >= 0
      ? process.argv[deploymentIdentityIndex + 1]
      : "none";
  const allowReviewedMachineImages = process.argv.includes(
    "--allow-reviewed-machine-images",
  );
  const allowScaleCountDrift = process.argv.includes(
    "--allow-scale-count-drift",
  );
  const allowInterruptedScaleCountDrift = process.argv.includes(
    "--allow-interrupted-scale-count-drift",
  );
  const allowFirstTrustedBootstrapDrift = process.argv.includes(
    "--allow-first-trusted-bootstrap-drift",
  );
  const capturedPriorIdentityIndex = process.argv.indexOf(
    "--captured-prior-identity",
  );
  const capturedPriorIdentity =
    capturedPriorIdentityIndex >= 0
      ? process.argv[capturedPriorIdentityIndex + 1]
      : undefined;
  const interruptedDeploymentIdentityIndex = process.argv.indexOf(
    "--interrupted-deployment-identity",
  );
  const interruptedDeploymentIdentity =
    interruptedDeploymentIdentityIndex >= 0
      ? process.argv[interruptedDeploymentIdentityIndex + 1]
      : undefined;
  const capturedPriorImageIndex = process.argv.indexOf(
    "--captured-prior-image",
  );
  const capturedPriorImage =
    capturedPriorImageIndex >= 0
      ? process.argv[capturedPriorImageIndex + 1]
      : undefined;
  const rootDirIndex = process.argv.indexOf("--root-dir");
  const cliRootDir =
    rootDirIndex >= 0
      ? path.resolve(process.argv[rootDirIndex + 1])
      : process.cwd();
  if (allowScaleCountDrift && restoreIndex < 0) {
    fail(
      "--allow-scale-count-drift is available only for restored-release verification",
    );
  }
  if (allowFirstTrustedBootstrapDrift && restoreIndex < 0) {
    fail(
      "--allow-first-trusted-bootstrap-drift is available only for restored-release verification",
    );
  }
  if (
    allowInterruptedScaleCountDrift &&
    (liveIndex < 0 ||
      restoreIndex >= 0 ||
      !process.argv.includes("--predeploy") ||
      !/^deploy-[0-9]+-[0-9]+$/.test(expectedDeploymentIdentity) ||
      !/^(?:none|deploy-[0-9]+-[0-9]+)$/.test(capturedPriorIdentity ?? "") ||
      typeof capturedPriorImage !== "string" ||
      capturedPriorImage.length < 1 ||
      capturedPriorIdentity === expectedDeploymentIdentity)
  ) {
    fail(
      "--allow-interrupted-scale-count-drift requires exact interrupted predeploy identity context",
    );
  }
  if (
    allowScaleCountDrift &&
    (deploymentIdentityIndex < 0 ||
      !/^(?:none|deploy-[0-9]+-[0-9]+)$/.test(expectedDeploymentIdentity) ||
      capturedPriorIdentity !== expectedDeploymentIdentity ||
      typeof capturedPriorImage !== "string" ||
      capturedPriorImage.length < 1 ||
      !/^deploy-[0-9]+-[0-9]+$/.test(interruptedDeploymentIdentity ?? "") ||
      interruptedDeploymentIdentity === expectedDeploymentIdentity ||
      !allowReviewedMachineImages)
  ) {
    fail(
      "--allow-scale-count-drift requires the exact captured prior identity and reviewed Machine-image allowance",
    );
  }
  if (recoveryProtocolIndex >= 0) {
    const protocolPath = path.resolve(
      process.argv[recoveryProtocolIndex + 1] ?? "",
    );
    const stat = fs.statSync(protocolPath);
    if (!stat.isFile() || stat.size < 1 || stat.size > 16) {
      fail("Production recovery protocol artifact has an unsafe shape");
    }
    const protocol = validateRecoveryProtocol(
      fs.readFileSync(protocolPath, "utf8"),
    );
    process.stdout.write(
      `Production recovery protocol ${protocol} is supported.\n`,
    );
  } else if (scalePlanIndex >= 0) {
    const target = process.argv[scalePlanIndex + 1];
    process.stdout.write(
      `${JSON.stringify(getReviewedScalePlan(target, cliRootDir))}\n`,
    );
  } else if (enabledIndex >= 0) {
    const target = process.argv[enabledIndex + 1];
    validateDeploymentEnabled(target, cliRootDir);
    process.stdout.write(`${target} production deployment is enabled.\n`);
  } else if (reviewedIndex >= 0) {
    const target = process.argv[reviewedIndex + 1];
    const image = process.argv[reviewedIndex + 2];
    validateReviewedImage(target, image, cliRootDir);
    process.stdout.write(
      `${target} image exactly matches the reviewed manifest digest.\n`,
    );
  } else if (sourceCommitIndex >= 0) {
    const target = process.argv[sourceCommitIndex + 1];
    const image = process.argv[sourceCommitIndex + 2];
    process.stdout.write(
      `${getReviewedArtifactSourceCommit(target, image, cliRootDir)}\n`,
    );
  } else if (artifactKindIndex >= 0) {
    const target = process.argv[artifactKindIndex + 1];
    const image = process.argv[artifactKindIndex + 2];
    process.stdout.write(
      `${getReviewedArtifactKind(target, image, cliRootDir)}\n`,
    );
  } else if (schemaMinimumIndex >= 0) {
    const target = process.argv[schemaMinimumIndex + 1];
    const image = process.argv[schemaMinimumIndex + 2];
    process.stdout.write(
      `${getReviewedArtifactSchemaSupport(target, image, cliRootDir).minimum}\n`,
    );
  } else if (schemaMaximumIndex >= 0) {
    const target = process.argv[schemaMaximumIndex + 1];
    const image = process.argv[schemaMaximumIndex + 2];
    process.stdout.write(
      `${getReviewedArtifactSchemaSupport(target, image, cliRootDir).maximum}\n`,
    );
  } else if (schemaPhaseIndex >= 0) {
    const target = process.argv[schemaPhaseIndex + 1];
    const image = process.argv[schemaPhaseIndex + 2];
    const phase = process.argv[schemaPhaseIndex + 3];
    validateReviewedArtifactSchemaPhase(target, image, phase, cliRootDir);
    process.stdout.write(`${target} image supports database phase ${phase}.\n`);
  } else if (reviewedCiIndex >= 0) {
    const target = process.argv[reviewedCiIndex + 1];
    const image = process.argv[reviewedCiIndex + 2];
    const result = await verifyReviewedArtifactCi(target, image, {
      rootDir: cliRootDir,
    });
    process.stdout.write(
      `${target} source ${result.sourceCommit} passed every required main CI workflow.\n`,
    );
  } else if (sourceCiIndex >= 0) {
    const sourceCommit = process.argv[sourceCiIndex + 1];
    const result = await verifySourceCi(sourceCommit, { rootDir: cliRootDir });
    process.stdout.write(
      `Source ${result.sourceCommit} passed every required main CI workflow.\n`,
    );
  } else if (deploymentCandidateIndex >= 0) {
    const target = process.argv[deploymentCandidateIndex + 1];
    const liveIdentity = process.argv[deploymentCandidateIndex + 2];
    const candidateIdentity = process.argv[deploymentCandidateIndex + 3];
    const sourceIndex = process.argv.indexOf("--expected-source-sha");
    const liveImageIndex = process.argv.indexOf("--expected-live-image");
    await verifyDeploymentCandidate(target, liveIdentity, candidateIdentity, {
      rootDir: cliRootDir,
      expectedSourceSha:
        sourceIndex >= 0 ? process.argv[sourceIndex + 1] : undefined,
      expectedLiveImage:
        liveImageIndex >= 0 ? process.argv[liveImageIndex + 1] : undefined,
    });
    process.stdout.write(
      `${candidateIdentity} is newer than settled ${liveIdentity}.\n`,
    );
  } else if (prepareSuccessorIndex >= 0) {
    const target = process.argv[prepareSuccessorIndex + 1];
    const identity = process.argv[prepareSuccessorIndex + 2];
    const supersedesIdentity = process.argv[prepareSuccessorIndex + 3];
    const destination = process.argv[prepareSuccessorIndex + 4];
    const result = await materializeSuccessorSourceRoot(
      target,
      identity,
      supersedesIdentity,
      destination,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (recoveryReleaseMachinesIndex >= 0) {
    const target = process.argv[recoveryReleaseMachinesIndex + 1];
    const app = loadProductionManifest(cliRootDir).apps[target];
    if (!app) fail(`Unknown production target: ${target}`);
    const machines = JSON.parse(
      runFly(["machine", "list", "--app", app.app, "--json"], cliRootDir),
    );
    const machineIds = classifyRecoveryReleaseCommandMachines(
      target,
      machines,
      {
        rootDir: cliRootDir,
        interruptedDeploymentIdentity,
        capturedPriorIdentity,
        capturedPriorImage,
      },
    );
    process.stdout.write(`${JSON.stringify(machineIds)}\n`);
  } else if (settledBaselineIndex >= 0) {
    const target = process.argv[settledBaselineIndex + 1];
    const identity = process.argv[settledBaselineIndex + 2];
    const expectedImageIndex = process.argv.indexOf("--expected-image");
    const supersedesIndex = process.argv.indexOf(
      "--supersedes-deployment-identity",
    );
    const expectedSourceIndex = process.argv.indexOf("--expected-source-sha");
    const result = await verifySettledBaseline(target, identity, {
      rootDir: cliRootDir,
      expectedImage:
        expectedImageIndex >= 0
          ? process.argv[expectedImageIndex + 1]
          : undefined,
      supersedesIdentity:
        supersedesIndex >= 0 ? process.argv[supersedesIndex + 1] : undefined,
      expectedSourceSha:
        expectedSourceIndex >= 0
          ? process.argv[expectedSourceIndex + 1]
          : undefined,
    });
    process.stdout.write(
      process.argv.includes("--output-json")
        ? `${JSON.stringify(result)}\n`
        : `${target} identity ${identity} is a settled baseline.\n`,
    );
  } else if (resolveIndex >= 0) {
    const target = process.argv[resolveIndex + 1];
    const releaseImage = process.argv[resolveIndex + 2];
    const imageRecordsPath = process.argv[resolveIndex + 3];
    const imageRecords = readJson(path.resolve(imageRecordsPath));
    process.stdout.write(
      `${resolveImmutableReleaseImage(target, releaseImage, imageRecords, cliRootDir)}\n`,
    );
  } else if (rollbackConfigIndex >= 0) {
    const target = process.argv[rollbackConfigIndex + 1];
    const image = process.argv[rollbackConfigIndex + 2];
    process.stdout.write(
      `${getReviewedRollbackConfig(target, image, cliRootDir)}\n`,
    );
  } else if (restoreConfigIndex >= 0) {
    const target = process.argv[restoreConfigIndex + 1];
    const image = process.argv[restoreConfigIndex + 2];
    const identity = process.argv[restoreConfigIndex + 3];
    process.stdout.write(
      `${getReviewedRestoreConfig(target, image, identity, cliRootDir)}\n`,
    );
  } else if (rollbackIndex >= 0) {
    const target = process.argv[rollbackIndex + 1];
    const image = process.argv[rollbackIndex + 2];
    validateReviewedRollbackImage(target, image, cliRootDir);
    process.stdout.write(`${target} rollback image is reviewed.\n`);
  } else if (legacyRollbackIndex >= 0) {
    const target = process.argv[legacyRollbackIndex + 1];
    const image = process.argv[legacyRollbackIndex + 2];
    validateLegacyTransitionRollback(target, image, cliRootDir);
    process.stdout.write(
      `${target} legacy image is the exact reviewed pre-expand rollback.\n`,
    );
  } else if (restoreIndex >= 0) {
    const target = process.argv[restoreIndex + 1];
    const image = process.argv[restoreIndex + 2];
    const configPath = process.argv[restoreIndex + 3];
    validateReviewedRollbackImage(target, image, cliRootDir);
    if (!configPath)
      fail("Restored release verification requires the captured config");
    const allowStorageProxyFirstTrustedBootstrapDrift =
      allowsStorageProxyFirstTrustedBootstrapRestore(
        target,
        image,
        expectedDeploymentIdentity,
        cliRootDir,
      );
    const result = checkLiveFlyDrift(target, {
      rootDir: cliRootDir,
      expectedImage: image,
      configPath,
      expectedDeploymentIdentity,
      allowReviewedMachineImages,
      allowScaleCountDrift,
      allowFirstTrustedBootstrapDrift,
      allowStorageProxyFirstTrustedBootstrapDrift,
      capturedPriorIdentity,
      interruptedDeploymentIdentity,
      capturedPriorImage,
    });
    const unresolvedReconcilableDrift = allowScaleCountDrift
      ? result.reconcilableDrift.filter(
          (drift) =>
            !/^(?:scale\.[^.]+\.count:|started Machines for |missing live scale for process group )/.test(
              drift,
            ),
        )
      : result.reconcilableDrift;
    const errors = [...result.blockingErrors, ...unresolvedReconcilableDrift];
    if (errors.length) {
      process.stderr.write(
        `${result.app} restored release drift:\n- ${errors.join("\n- ")}\n`,
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(
        `${result.app} matches the captured rollback image and configuration.\n`,
      );
    }
  } else if (settledLiveIndex >= 0) {
    const target = process.argv[settledLiveIndex + 1];
    const expectedSourceIndex = process.argv.indexOf("--expected-source-sha");
    const result = await checkSettledLiveFlyDrift(target, {
      rootDir: cliRootDir,
      requireCurrentReviewedImage: process.argv.includes(
        "--require-current-reviewed-image",
      ),
      expectedSourceSha:
        expectedSourceIndex >= 0
          ? process.argv[expectedSourceIndex + 1]
          : undefined,
    });
    const errors = [...result.blockingErrors, ...result.reconcilableDrift];
    if (errors.length) {
      process.stderr.write(
        `${result.app} unsettled production drift:\n- ${errors.join("\n- ")}\n`,
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(
        `${result.app} matches settled identity ${result.identity}.\n`,
      );
    }
  } else if (liveIndex >= 0) {
    const target = process.argv[liveIndex + 1];
    const predeploy = process.argv.includes("--predeploy");
    const result = checkLiveFlyDrift(target, {
      rootDir: cliRootDir,
      // A new reviewed digest necessarily differs from the currently running
      // digest before rollout. Only an explicitly reviewed rollback image may
      // differ during predeploy; postdeploy remains strictly pinned.
      allowReviewedRollbackImage: predeploy,
      expectedDeploymentIdentity,
      allowInterruptedScaleCountDrift,
      capturedPriorIdentity,
      capturedPriorImage,
    });
    if (result.reconcilableDrift.length) {
      const stream = predeploy ? process.stdout : process.stderr;
      stream.write(
        `${result.app} reconcilable configuration drift:\n- ${result.reconcilableDrift.join("\n- ")}\n`,
      );
    }
    if (result.blockingErrors.length) {
      process.stderr.write(
        `${result.app} unsafe Machine drift:\n- ${result.blockingErrors.join("\n- ")}\n`,
      );
      process.exitCode = 1;
    } else if (result.reconcilableDrift.length && !predeploy) {
      process.exitCode = 1;
    } else {
      process.stdout.write(
        predeploy && result.reconcilableDrift.length
          ? `${result.app} can be reconciled by the reviewed deploy.\n`
          : `${result.app} matches its production deployment contract.\n`,
      );
    }
  } else {
    const result = validateProductionRepository(cliRootDir);
    process.stdout.write(
      `Production deployment contract validated (${result.apps} apps, ${result.callbacks} Meta callbacks).\n`,
    );
  }
}
