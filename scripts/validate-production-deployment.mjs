import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_PATH = "deploy/production/apps.json";
const PRODUCTION_WORKFLOW_PATH = ".github/workflows/deploy-production.yml";
const ROOT_VALIDATION_WORKFLOW_PATH = ".github/workflows/main.yml";
const CANONICAL_DEPLOY_SCRIPTS = new Set(["deploy:gateway", "deploy:image-gen"]);

function fail(message) {
  throw new Error(message);
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

function allAssignments(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...text.matchAll(new RegExp(`^\\s*${escaped}\\s*=\\s*(.+?)\\s*$`, "gm"))].map(
    (match) => unquoteToml(match[1]),
  );
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

export function loadProductionManifest(rootDir = process.cwd()) {
  const manifest = readJson(path.join(rootDir, MANIFEST_PATH));
  if (manifest.schemaVersion !== 1) {
    fail("Unsupported production deployment manifest schema");
  }
  return manifest;
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
  return new Set([app.reviewedImage, ...(app.reviewedRollbackImages ?? [])].filter(Boolean));
}

export function validateReviewedRollbackImage(target, image, rootDir = process.cwd()) {
  const app = loadProductionManifest(rootDir).apps[target];
  if (!app) fail(`Unknown production target: ${target}`);
  if (!isImmutableAppImage(app, image)) {
    fail(`${target} rollback image must be an immutable image for ${app.app}`);
  }
  if (!reviewedProductionImages(app).has(image)) {
    fail(`${target} rollback image is not in the reviewed production allowlist`);
  }
  return image;
}

export function validateDeploymentEnabled(target, rootDir = process.cwd()) {
  const app = loadProductionManifest(rootDir).apps[target];
  if (!app) fail(`Unknown production target: ${target}`);
  if (app.deploymentEnabled !== true) {
    fail(`${target} production deployment is blocked: ${app.deploymentBlockReason}`);
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
      .map((record) => `${record.Registry}/${record.Repository}@${record.Digest}`),
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
  const requirements = [
    ["workflow_dispatch:", "must be manually dispatched"],
    ['test "$GITHUB_REF" = "refs/heads/main"', "must require reviewed main"],
    ["environment: production", "must use the protected production environment"],
    ["FLY_GATEWAY_DEPLOY_TOKEN", "must use an app-scoped gateway deploy token"],
    ["FLY_IMAGE_GEN_DEPLOY_TOKEN", "must use an app-scoped image-gen deploy token"],
    ["npm run deploy:gateway", "must use the canonical gateway deploy script"],
    ["npm run deploy:image-gen", "must use the canonical image-gen deploy script"],
    ["--live gateway --predeploy", "must run gateway pre-deploy drift checks"],
    ["--live image-gen --predeploy", "must run image-gen pre-deploy drift checks"],
    [/--live gateway[ \t]*\r?$/m, "must run strict gateway post-deploy drift checks"],
    [/--live image-gen[ \t]*\r?$/m, "must run strict image-gen post-deploy drift checks"],
    ["scripts/check-meta-callbacks.mjs", "must verify Meta callbacks"],
    ["rollback-image.txt", "must preserve rollback image metadata"],
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
      "image-gen requires an exact reviewed registry digest",
      "must block unreconciled image-gen source deploys",
    ],
    [
      "image-gen image must exactly match the reviewed manifest digest",
      "must enforce the reviewed image-gen digest",
    ],
    [
      "apps['image-gen'].reviewedImage",
      "must read the reviewed image-gen digest from the manifest",
    ],
    [
      "FLY_IMAGE_GEN_REVIEWED_IMAGE: ${{ inputs.rollback_image }}",
      "must pass the reviewed manifest input to the canonical image-gen deploy command",
    ],
    ["Restore captured gateway release", "must include gateway rollback"],
    ["Restore captured image-gen release", "must include image-gen rollback"],
    ["--config \"$rollback_config\"", "must restore the captured Fly configuration"],
    ["fly config save --app", "must capture the pre-deploy Fly configuration"],
    ["FLYCTL_VERSION: 0.4.85", "must pin the reviewed flyctl version"],
    ["META_GRAPH_VERSION: v21.0", "must pin the reviewed Meta Graph API version"],
  ];
  for (const [needle, message] of requirements) {
    const matched = needle instanceof RegExp ? needle.test(workflow) : workflow.includes(needle);
    if (!matched) {
      fail(`${PRODUCTION_WORKFLOW_PATH} ${message}`);
    }
  }
  if (/\bfly\s+(?:m|machine|machines)\s+run\b/.test(workflow)) {
    fail(`${PRODUCTION_WORKFLOW_PATH} must not create detached Machines`);
  }
  for (const [needle, expectedCount, message] of [
    ["actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4.3.1", 3, "must pin all checkout steps"],
    [/^\s*timeout-minutes: 75\s*$/gm, 2, "must reserve time in both deploy jobs"],
    [/^\s*timeout-minutes: 3\s*$/gm, 8, "must bound setup and rollback-plan uploads"],
    [/^\s*timeout-minutes: 2\s*$/gm, 4, "must bound config and Meta checks"],
    [/^\s*timeout-minutes: 5\s*$/gm, 6, "must bound drift and rollback capture"],
    [/^\s*timeout-minutes: 4\s*$/gm, 2, "must bound smoke tests"],
    [/^\s*timeout-minutes: 20\s*$/gm, 2, "must bound both deployment steps"],
    [/^\s*timeout-minutes: 15\s*$/gm, 2, "must reserve bounded rollback steps"],
    ['release_image="$(jq -er', 2, "must fail closed when either rollback release is missing"],
    ["--retry-all-errors", 3, "must retry transient failures in every post-deploy smoke request"],
    ["--resolve-release-image gateway", 1, "must resolve the gateway rollback digest"],
    ["--resolve-release-image image-gen", 1, "must resolve the image-gen rollback digest"],
    ["--validate-rollback-image gateway", 3, "must validate gateway input, capture, and restore"],
    ["--validate-rollback-image image-gen", 2, "must validate image-gen capture and restore"],
    ["fly config save --app", 2, "must capture both pre-deploy configurations"],
    ["--config \"$rollback_config\"", 4, "must validate and restore both captured configurations"],
  ]) {
    const actualCount =
      needle instanceof RegExp
        ? (workflow.match(needle) ?? []).length
        : occurrenceCount(workflow, needle);
    if (actualCount !== expectedCount) {
      fail(`${PRODUCTION_WORKFLOW_PATH} ${message}`);
    }
  }
}

function validateRootValidationTriggers(rootDir) {
  const workflow = fs.readFileSync(
    path.join(rootDir, ROOT_VALIDATION_WORKFLOW_PATH),
    "utf8",
  );
  for (const requiredPath of [
    '"apps/image-gen/fly.toml"',
    '".github/workflows/production-uptime.yml"',
  ]) {
    if (!workflow.includes(requiredPath)) {
      fail(`${ROOT_VALIDATION_WORKFLOW_PATH} must run for ${requiredPath.slice(1, -1)}`);
    }
  }
}

export function validateProductionRepository(rootDir = process.cwd()) {
  const manifest = loadProductionManifest(rootDir);
  const packageJson = readJson(path.join(rootDir, "package.json"));
  const appNames = new Set();

  for (const [target, app] of Object.entries(manifest.apps)) {
    if (appNames.has(app.app)) fail(`Duplicate production Fly app: ${app.app}`);
    appNames.add(app.app);
    if (!CANONICAL_DEPLOY_SCRIPTS.has(app.deployScript)) {
      fail(`${target} uses an unreviewed deploy script: ${app.deployScript}`);
    }
    if (!packageJson.scripts?.[app.deployScript]) {
      fail(`Missing package script ${app.deployScript}`);
    }
    if (
      app.sourceDeployEnabled === false &&
      !packageJson.scripts[app.deployScript].includes(
        '--image "$FLY_IMAGE_GEN_REVIEWED_IMAGE"',
      )
    ) {
      fail(`${target} deploy script must require the reviewed manifest image`);
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
    if (new Set(app.reviewedRollbackImages).size !== app.reviewedRollbackImages.length) {
      fail(`${target} reviewedRollbackImages must not contain duplicates`);
    }
    for (const image of app.reviewedRollbackImages) {
      if (!isImmutableAppImage(app, image)) {
        fail(`${target} has an invalid reviewed rollback image`);
      }
    }
    if (
      app.deploymentEnabled === true &&
      app.sourceDeployEnabled !== false &&
      !app.reviewedImage &&
      app.reviewedRollbackImages.length === 0
    ) {
      fail(`${target} must seed a reviewed rollback digest before deployment is enabled`);
    }
    if (app.sourceDeployEnabled === false && !app.sourceDeployBlockReason) {
      fail(`${target} must document why source deploys are blocked`);
    }
    const reviewedImagePrefix = `registry.fly.io/${app.app}@sha256:`;
    const reviewedImageDigest = (app.reviewedImage ?? "").slice(reviewedImagePrefix.length);
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
    const processes = tableAssignments(tables, "processes");
    const httpService = tableAssignments(tables, "http_service");
    const configuredGroups = Object.keys(processes).sort();
    const desiredGroups = Object.keys(app.desiredScale).sort();
    if (rootAssignments.app !== app.app) {
      fail(`${app.config} must target ${app.app}`);
    }
    if (JSON.stringify(configuredGroups) !== JSON.stringify(desiredGroups)) {
      fail(`${app.config} process groups must match desiredScale`);
    }
    const serviceGroups = parseStringArray(String(httpService.processes ?? ""));
    if (
      JSON.stringify([...serviceGroups].sort()) !==
      JSON.stringify([...app.serviceProcessGroups].sort())
    ) {
      fail(`${app.config} HTTP service process groups do not match the manifest`);
    }
    const serviceCheckPaths = allAssignments(text, "path").filter((value) =>
      ["/healthz", "/readyz"].includes(String(value)),
    );
    if (!serviceCheckPaths.includes(app.serviceCheckPath)) {
      fail(`${app.config} must define a /healthz service check`);
    }
    if (app.readinessCheckPath) {
      if (!app.readinessMonitor) {
        fail(`${target} must define an external readiness monitor`);
      }
      const monitorPath = path.join(rootDir, app.readinessMonitor);
      const monitor = fs.readFileSync(monitorPath, "utf8");
      if (!monitor.includes(app.readinessCheckPath)) {
        fail(`${app.readinessMonitor} must monitor ${app.readinessCheckPath}`);
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
    if (config.temporarilyAllowedCallbacks.map(normalizeUrl).includes(expected)) {
      fail(`${object} lists its canonical callback as temporary drift`);
    }
    if (config.migrationState === "canonical" && config.temporarilyAllowedCallbacks.length) {
      fail(`${object} cannot allow callback drift after migration is canonical`);
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
  return execFileSync("fly", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function compareObject(actual, expected, label, errors) {
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (actual?.[key] !== expectedValue) {
      errors.push(`${label}.${key}: expected ${JSON.stringify(expectedValue)}, got ${JSON.stringify(actual?.[key])}`);
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

export function checkLiveFlyDrift(target, options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const run = options.runFly ?? ((args) => runFly(args, rootDir));
  const manifest = loadProductionManifest(rootDir);
  const app = manifest.apps[target];
  if (!app) fail(`Unknown production target: ${target}`);

  const live = JSON.parse(run(["config", "show", "--app", app.app]));
  const machines = JSON.parse(run(["machine", "list", "--app", app.app, "--json"]));
  const scale = JSON.parse(run(["scale", "show", "--app", app.app, "--json"]));
  const configText = fs.readFileSync(path.join(rootDir, app.config), "utf8");
  const tables = readTomlTables(configText);
  const expectedEnv = tableAssignments(tables, "env");
  const expectedProcesses = tableAssignments(tables, "processes");
  const configuredMount = tableAssignments(tables, "mounts");
  const expectedMounts = Object.keys(configuredMount).length ? [configuredMount] : [];
  const reconcilableDrift = [];
  const blockingErrors = [];

  if (live.app !== app.app) blockingErrors.push(`live app mismatch: ${live.app}`);
  compareObject(live.env, expectedEnv, "env", reconcilableDrift);
  for (const liveKey of Object.keys(live.env ?? {})) {
    if (!(liveKey in expectedEnv)) {
      reconcilableDrift.push(`env.${liveKey}: live-only value`);
    }
  }
  if (JSON.stringify(live.processes ?? {}) !== JSON.stringify(expectedProcesses)) {
    reconcilableDrift.push(
      "live process commands differ from the production fly.toml",
    );
  }
  const liveServiceGroups = [...(live.http_service?.processes ?? [])].sort();
  if (
    JSON.stringify(liveServiceGroups) !==
    JSON.stringify([...app.serviceProcessGroups].sort())
  ) {
    reconcilableDrift.push(
      "live HTTP service process groups differ from the manifest",
    );
  }
  const liveCheckPaths = (live.http_service?.checks ?? []).map((check) => check.path);
  if (!liveCheckPaths.includes(app.serviceCheckPath)) {
    reconcilableDrift.push(
      `live service check must use ${app.serviceCheckPath}`,
    );
  }
  const liveMounts = normalizeMounts(live.mounts);
  if (JSON.stringify(liveMounts) !== JSON.stringify(normalizeMounts(expectedMounts))) {
    blockingErrors.push("live volume mounts differ from the production fly.toml");
  }

  for (const machine of machines) {
    const metadata = machine.config?.metadata ?? {};
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
    if (app.reviewedImage && machine.config?.image !== app.reviewedImage) {
      if (
        options.allowReviewedRollbackImage === true &&
        reviewedProductionImages(app).has(machine.config?.image)
      ) {
        reconcilableDrift.push(
          `Machine ${machine.id} uses an approved rollback image before deployment`,
        );
      } else if (options.allowReviewedRollbackImage === true) {
        blockingErrors.push(
          `Machine ${machine.id} image is not an approved rollback image`,
        );
      } else {
        blockingErrors.push(
          `Machine ${machine.id} image differs from the reviewed production digest`,
        );
      }
    }
  }

  const scaleByProcess = Object.fromEntries(scale.map((entry) => [entry.Process, entry]));
  for (const [process, desired] of Object.entries(app.desiredScale)) {
    const actual = scaleByProcess[process];
    if (!actual) {
      blockingErrors.push(`missing live scale for process group ${process}`);
      continue;
    }
    compareObject(
      {
        count: actual.Count,
        cpuKind: actual.CPUKind,
        cpus: actual.CPUs,
        memoryMb: actual.Memory,
      },
      desired,
      `scale.${process}`,
      blockingErrors,
    );
  }

  return { target, app: app.app, reconcilableDrift, blockingErrors };
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const enabledIndex = process.argv.indexOf("--validate-target-enabled");
  const resolveIndex = process.argv.indexOf("--resolve-release-image");
  const rollbackIndex = process.argv.indexOf("--validate-rollback-image");
  const liveIndex = process.argv.indexOf("--live");
  if (enabledIndex >= 0) {
    const target = process.argv[enabledIndex + 1];
    validateDeploymentEnabled(target);
    process.stdout.write(`${target} production deployment is enabled.\n`);
  } else if (resolveIndex >= 0) {
    const target = process.argv[resolveIndex + 1];
    const releaseImage = process.argv[resolveIndex + 2];
    const imageRecordsPath = process.argv[resolveIndex + 3];
    const imageRecords = readJson(path.resolve(imageRecordsPath));
    process.stdout.write(
      `${resolveImmutableReleaseImage(target, releaseImage, imageRecords)}\n`,
    );
  } else if (rollbackIndex >= 0) {
    const target = process.argv[rollbackIndex + 1];
    const image = process.argv[rollbackIndex + 2];
    validateReviewedRollbackImage(target, image);
    process.stdout.write(`${target} rollback image is reviewed.\n`);
  } else if (liveIndex >= 0) {
    const target = process.argv[liveIndex + 1];
    const predeploy = process.argv.includes("--predeploy");
    const result = checkLiveFlyDrift(target, {
      // A new reviewed digest necessarily differs from the currently running
      // digest before rollout. Only an explicitly reviewed rollback image may
      // differ during predeploy; postdeploy remains strictly pinned.
      allowReviewedRollbackImage: predeploy,
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
    const result = validateProductionRepository();
    process.stdout.write(
      `Production deployment contract validated (${result.apps} apps, ${result.callbacks} Meta callbacks).\n`,
    );
  }
}
