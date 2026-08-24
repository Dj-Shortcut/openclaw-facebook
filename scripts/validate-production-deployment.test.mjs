import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { checkMetaCallbacks } from "./check-meta-callbacks.mjs";
import {
  checkLiveFlyDrift,
  checkSettledLiveFlyDrift,
  classifyRecoveryReleaseCommandMachines,
  getReviewedArtifactSchemaSupport,
  getReviewedArtifactSourceCommit,
  getReviewedRollbackConfig,
  getReviewedScalePlan,
  materializeSuccessorSourceRoot,
  referencesForbiddenFlyApiUrl,
  resolveImmutableReleaseImage,
  validateDeploymentEnabled,
  validateProductionRepository,
  validateRecoveryProtocol,
  validateReviewedImage,
  validateReviewedRollbackImage,
  verifyReviewedArtifactCi,
  verifyDeploymentCandidate,
  verifySettledBaseline,
} from "./validate-production-deployment.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tempDirs = [];

function createRepositoryFixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "leaderbot-production-contract-"),
  );
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, "deploy/production"), { recursive: true });
  fs.mkdirSync(path.join(root, "apps/image-gen"), { recursive: true });
  fs.mkdirSync(path.join(root, "apps/image-gen/server/_core"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(root, "apps/image-gen/scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "apps/image-gen/storage-proxy"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
  for (const relativePath of [
    "deploy/production/apps.json",
    "deploy/production/rollback-configs/image-gen-28d862568aa3.toml",
    "docs/operations/production-deployments.md",
    "deploy/fly-gateway/Dockerfile",
    "deploy/fly-gateway/Dockerfile.route-guard-hotfix",
    "package.json",
    "fly.toml",
    "apps/image-gen/fly.toml",
    "apps/image-gen/Dockerfile",
    "apps/image-gen/package.json",
    "apps/image-gen/scripts/run-production-migrations.mjs",
    "apps/image-gen/server/_core/imageService.ts",
    "apps/image-gen/storage-proxy/Dockerfile",
    "apps/image-gen/storage-proxy/fly.toml",
    "apps/image-gen/storage-proxy/index.ts",
    ".github/workflows/build-production-artifacts.yml",
    ".github/workflows/cleanup-image-gen-schema-probes.yml",
    ".github/workflows/deploy-production.yml",
    ".github/workflows/image-gen-ci.yml",
    ".github/workflows/image-gen-migration-smoke.yml",
    ".github/workflows/image-gen-schema-transition.yml",
    ".github/workflows/main.yml",
    ".github/workflows/production-uptime.yml",
    ".github/workflows/recover-completed-production-deployment.yml",
    ".github/workflows/reconcile-production-deployment.yml",
    "scripts/select-fresh-fly-snapshot.mjs",
    "scripts/validate-production-deployment.mjs",
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, relativePath)), {
      recursive: true,
    });
    fs.copyFileSync(
      path.join(repoRoot, relativePath),
      path.join(root, relativePath),
    );
  }
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, "deploy/production/apps.json"), "utf8"),
  );
  for (const app of Object.values(manifest.apps)) {
    for (const config of Object.values(app.reviewedRollbackConfigs ?? {})) {
      const destination = path.join(root, config.path);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(repoRoot, config.path), destination);
    }
  }
  return root;
}

function replaceFixtureText(root, relativePath, before, after) {
  const filePath = path.join(root, relativePath);
  const source = fs.readFileSync(filePath, "utf8");
  expect(source).toContain(before);
  fs.writeFileSync(filePath, source.replace(before, after));
}

function replaceLastFixtureText(root, relativePath, before, after) {
  const filePath = path.join(root, relativePath);
  const source = fs.readFileSync(filePath, "utf8");
  const index = source.lastIndexOf(before);
  expect(index).toBeGreaterThanOrEqual(0);
  fs.writeFileSync(
    filePath,
    `${source.slice(0, index)}${after}${source.slice(index + before.length)}`,
  );
}

function stageImageGenBridge(manifest, sourceCommit = "a".repeat(40)) {
  const app = manifest.apps["image-gen"];
  const legacyImage = app.databaseSchemaTransition.legacyBaseImage;
  const bridgeImage = `registry.fly.io/${app.app}@sha256:${"b".repeat(64)}`;
  app.deploymentEnabled = true;
  app.reviewedImage = bridgeImage;
  app.reviewedArtifactKind = "migration-bridge";
  app.reviewedSourceCommit = sourceCommit;
  app.reviewedRollbackImages = [legacyImage];
  app.reviewedRollbackConfigs = {
    [legacyImage]: {
      path: "deploy/production/rollback-configs/image-gen-28d862568aa3.toml",
      sha256:
        "c449016cd8a66ec563c71e8fbb7e6fc0a1953f5ad0a7d6c1313936aaff911b64",
    },
  };
  app.reviewedRollbackArtifactKinds = {
    [legacyImage]: "legacy-bootstrap",
  };
  app.reviewedRollbackSourceCommits = {};
  app.reviewedImageSchemaPhases = ["0015_base", "0016_expand"];
  app.reviewedRollbackImageSchemaPhases = {
    [legacyImage]: ["0015_base"],
  };
  app.databaseSchemaTransition.state = "bridge_reviewed";
  app.databaseSchemaTransition.bridgeImage = bridgeImage;
  app.databaseSchemaTransition.bridgeSourceCommit = sourceCommit;
  return { app, bridgeImage, legacyImage, sourceCommit };
}

function stageStorageProxyRuntime(manifest, sourceCommit = "b".repeat(40)) {
  const app = manifest.apps["storage-proxy"];
  const legacyImage = app.artifactTransition.legacyImage;
  const runtimeImage = `registry.fly.io/${app.app}@sha256:${"c".repeat(64)}`;
  app.deploymentEnabled = true;
  app.reviewedImage = runtimeImage;
  app.reviewedArtifactKind = "runtime";
  app.reviewedSourceCommit = sourceCommit;
  app.reviewedRollbackImages = [legacyImage];
  app.reviewedRollbackArtifactKinds = {
    [legacyImage]: "legacy-bootstrap",
  };
  app.reviewedRollbackSourceCommits = {};
  app.artifactTransition.state = "runtime_reviewed";
  return { app, legacyImage, runtimeImage, sourceCommit };
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

function metaResponse(pageCallback, transform = (data) => data) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        data: transform([
          {
            object: "page",
            active: true,
            callback_url: pageCallback,
            fields: [
              "messages",
              "messaging_postbacks",
              "message_deliveries",
              "message_reads",
            ],
          },
          {
            object: "whatsapp_business_account",
            active: true,
            callback_url:
              "https://leaderbot-fb-image-gen.fly.dev/webhook/whatsapp",
            fields: ["messages", "message_template_status_update"],
          },
        ]),
      };
    },
  };
}

function canonicalDeploymentRun(
  target,
  runId = "123",
  runAttempt = "2",
  overrides = {},
) {
  return {
    id: Number(runId),
    run_attempt: Number(runAttempt),
    run_number: 40,
    head_branch: "main",
    head_sha: "a".repeat(40),
    event: "workflow_dispatch",
    path: ".github/workflows/deploy-production.yml",
    display_title: `Deploy ${target} to production`,
    status: "completed",
    conclusion: "success",
    repository: { full_name: "leaderbot/repository" },
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

function textResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body;
    },
  };
}

function storageSuccessorFixture(mutator = () => {}) {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "deploy/production/apps.json"), "utf8"),
  );
  const sourceCommit = "b".repeat(40);
  const approvalCommit = "d".repeat(40);
  const { app } = stageStorageProxyRuntime(manifest, sourceCommit);
  mutator({ manifest, app, sourceCommit, approvalCommit });
  const files = new Map([
    ["deploy/production/apps.json", `${JSON.stringify(manifest, null, 2)}\n`],
    [app.config, fs.readFileSync(path.join(repoRoot, app.config), "utf8")],
    ...Object.values(app.reviewedRollbackConfigs).map((record) => [
      record.path,
      fs.readFileSync(path.join(repoRoot, record.path), "utf8"),
    ]),
  ]);
  const calls = [];
  const fetchImpl = async (input) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.pathname.endsWith("/actions/runs/200/attempts/1")) {
      return jsonResponse(
        canonicalDeploymentRun("storage-proxy", "200", "1", {
          run_number: 51,
          head_sha: approvalCommit,
        }),
      );
    }
    if (url.pathname.endsWith("/actions/runs/100/attempts/2")) {
      return jsonResponse(
        canonicalDeploymentRun("storage-proxy", "100", "2", {
          run_number: 50,
          status: "completed",
          conclusion: "failure",
          head_sha: "a".repeat(40),
        }),
      );
    }
    const contentsMarker = "/repos/leaderbot/repository/contents/";
    if (url.pathname.includes(contentsMarker)) {
      const relativePath = decodeURIComponent(
        url.pathname.slice(
          url.pathname.indexOf(contentsMarker) + contentsMarker.length,
        ),
      );
      const source = files.get(relativePath);
      return source != null && url.searchParams.get("ref") === approvalCommit
        ? textResponse(source)
        : textResponse("missing", 404);
    }
    const workflowMatch = url.pathname.match(
      /\/actions\/workflows\/([^/]+)\/runs$/,
    );
    if (workflowMatch) {
      const workflow = decodeURIComponent(workflowMatch[1]);
      const requestedSource = url.searchParams.get("head_sha");
      return jsonResponse({
        workflow_runs: [
          {
            head_sha: requestedSource,
            head_branch: "main",
            event: "push",
            status: "completed",
            conclusion: "success",
            path: `.github/workflows/${workflow}`,
          },
        ],
      });
    }
    return jsonResponse({}, 404);
  };
  return {
    manifest,
    app,
    sourceCommit,
    approvalCommit,
    files,
    calls,
    fetchImpl,
  };
}

function immutableImageRef(image) {
  const match = image.match(
    /^registry\.fly\.io\/([^@]+)@(sha256:[a-f0-9]{64})$/,
  );
  if (!match) return undefined;
  return {
    registry: "registry.fly.io",
    repository: match[1],
    digest: match[2],
  };
}

function checkedInTomlEnv(relativePath, root = repoRoot) {
  const text = fs.readFileSync(path.join(root, relativePath), "utf8");
  const envBlock =
    text.match(/^\s*\[env\]\s*$([\s\S]*?)(?=^\s*\[)/m)?.[1] ?? "";
  return Object.fromEntries(
    [
      ...envBlock.matchAll(/^\s*([A-Za-z0-9_]+)\s*=\s*["']([^"']*)["']\s*$/gm),
    ].map((match) => [match[1], match[2]]),
  );
}

function imageGenReleaseCommandMachine(
  image,
  identity,
  {
    root = repoRoot,
    configPath = "apps/image-gen/fly.toml",
    id = "a1b2c3d4e5f607",
    state = "started",
    configuredImage = image,
  } = {},
) {
  const configText = fs.readFileSync(path.join(root, configPath), "utf8");
  const releaseCommand = configText.match(
    /^\s*release_command\s*=\s*["']([^"']+)["']\s*$/m,
  )?.[1];
  if (!releaseCommand) throw new Error(`${configPath} has no release command`);
  return {
    id,
    state,
    region: "ams",
    image_ref: immutableImageRef(image),
    config: {
      image: configuredImage,
      init: { cmd: releaseCommand.split(" ") },
      env: {
        ...checkedInTomlEnv(configPath, root),
        FLY_PROCESS_GROUP: "fly_app_release_command",
        LEADERBOT_DEPLOYMENT_IDENTITY: identity,
        PRIMARY_REGION: "ams",
        RELEASE_COMMAND: "1",
      },
      guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 },
      metadata: {
        fly_flyctl_version: "0.4.85",
        fly_platform_version: "v2",
        fly_process_group: "fly_app_release_command",
        fly_release_id: "release_123",
        fly_release_version: "42",
      },
      auto_destroy: true,
      restart: { policy: "no" },
      dns: { skip_registration: true },
      checks: [],
      files: [],
      mounts: [],
      services: [],
      statics: [],
      stop_config: { signal: "SIGTERM", timeout: 300_000_000_000 },
    },
  };
}

function addReleaseCommandToCapturedImageConfig(root, manifest, image) {
  const record = manifest.apps["image-gen"].reviewedRollbackConfigs[image];
  const destination = path.join(root, record.path);
  const config = fs.readFileSync(path.join(root, "apps/image-gen/fly.toml"));
  fs.writeFileSync(destination, config);
  record.sha256 = createHash("sha256").update(config).digest("hex");
  return record.path;
}

function httpMachineService({
  port,
  autoStop,
  gracePeriod,
  readiness = false,
}) {
  return {
    protocol: "tcp",
    internal_port: port,
    autostop: autoStop,
    autostart: true,
    min_machines_running: 1,
    ports: [
      { port: 80, handlers: ["http"], force_https: true },
      { port: 443, handlers: ["http", "tls"] },
    ],
    checks: [
      {
        type: "http",
        interval: "15s",
        timeout: "5s",
        grace_period: gracePeriod,
        method: "GET",
        path: "/healthz",
      },
      ...(readiness
        ? [
            {
              type: "http",
              interval: "15s",
              timeout: "5s",
              grace_period: "45s",
              method: "GET",
              path: "/readyz",
            },
          ]
        : []),
    ],
  };
}

function imageGenMachineConfig(image, processGroup) {
  const command =
    processGroup === "app"
      ? [
          "env",
          "MESSENGER_GENERATION_QUEUE_ENABLED=1",
          "MESSENGER_GENERATION_INLINE_FALLBACK=0",
          "node",
          "dist/index.cjs",
        ]
      : [
          "env",
          "MESSENGER_GENERATION_QUEUE_ENABLED=1",
          "MESSENGER_GENERATION_WORKER_ONLY=1",
          "node",
          "dist/index.cjs",
        ];
  return {
    image,
    init: { cmd: command },
    env: {
      ...checkedInTomlEnv("apps/image-gen/fly.toml"),
      FLY_PROCESS_GROUP: processGroup,
      PRIMARY_REGION: "ams",
    },
    guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 },
    metadata: { fly_platform_version: "v2", fly_process_group: processGroup },
    mounts: [],
    services:
      processGroup === "app"
        ? [
            httpMachineService({
              port: 8080,
              autoStop: "off",
              gracePeriod: "10s",
              readiness: true,
            }),
          ]
        : [],
    stop_config: { signal: "SIGTERM", timeout: "5m" },
  };
}

function imageGenRollbackMachineConfig(image, processGroup) {
  const config = imageGenMachineConfig(image, processGroup);
  config.env = {
    ...checkedInTomlEnv(
      "deploy/production/rollback-configs/image-gen-28d862568aa3.toml",
    ),
    FLY_PROCESS_GROUP: processGroup,
    PRIMARY_REGION: "ams",
  };
  if (processGroup === "app") {
    config.services[0].checks = config.services[0].checks.filter(
      (check) => check.path === "/healthz",
    );
  }
  delete config.stop_config;
  return config;
}

function storageProxyMachineConfig(image) {
  return {
    image,
    init: { cmd: ["node", "dist/index.cjs"] },
    env: {
      STORAGE_OPERATION_TIMEOUT_MS: "60000",
      STORAGE_ALLOW_LEGACY_BEARER_AUTH: "true",
      STORAGE_ALLOW_LEGACY_KEYS: "true",
      STORAGE_TRUST_FLY_CLIENT_IP: "true",
      FLY_PROCESS_GROUP: "app",
      PRIMARY_REGION: "ams",
    },
    guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 },
    metadata: { fly_platform_version: "v2", fly_process_group: "app" },
    mounts: [],
    services: [
      httpMachineService({ port: 8787, autoStop: "stop", gracePeriod: "60s" }),
    ],
  };
}

function storageProxyRollbackMachineConfig(image) {
  const config = storageProxyMachineConfig(image);
  config.init = {};
  config.env = { FLY_PROCESS_GROUP: "app", PRIMARY_REGION: "ams" };
  config.services[0].checks = [];
  return config;
}

function imageGenFlyState(image) {
  return (args) => {
    const command = args.slice(0, 2).join(" ");
    if (command === "config show") {
      return JSON.stringify({
        app: "leaderbot-fb-image-gen",
        env: {},
        processes: {},
        http_service: { processes: ["app"], checks: [{ path: "/healthz" }] },
      });
    }
    if (command === "machine list") {
      return JSON.stringify([
        {
          id: "image-gen-machine",
          state: "started",
          region: "ams",
          image_ref: immutableImageRef(image),
          config: imageGenMachineConfig(image, "app"),
        },
        {
          id: "image-gen-app-2",
          state: "started",
          region: "ams",
          image_ref: immutableImageRef(image),
          config: imageGenMachineConfig(image, "app"),
        },
        {
          id: "image-gen-worker-1",
          state: "started",
          region: "ams",
          image_ref: immutableImageRef(image),
          config: imageGenMachineConfig(image, "worker"),
        },
        {
          id: "image-gen-worker-2",
          state: "started",
          region: "ams",
          image_ref: immutableImageRef(image),
          config: imageGenMachineConfig(image, "worker"),
        },
      ]);
    }
    if (command === "scale show") {
      return JSON.stringify([
        { Process: "app", Count: 2, CPUKind: "shared", CPUs: 1, Memory: 256 },
        {
          Process: "worker",
          Count: 2,
          CPUKind: "shared",
          CPUs: 1,
          Memory: 256,
        },
      ]);
    }
    throw new Error(`Unexpected fly command: ${args.join(" ")}`);
  };
}

function imageGenLegacyBootstrapFlyState(image, mutate = () => {}) {
  const live = imageGenLiveConfig("none", { rollback: true });
  live.http_service.auto_stop_machines = false;
  const machines = [
    {
      id: "legacy-app-ams",
      state: "started",
      region: "ams",
      image_ref: immutableImageRef(image),
      config: imageGenRollbackMachineConfig(image, "app"),
    },
    {
      id: "legacy-app-fra",
      state: "started",
      region: "fra",
      image_ref: immutableImageRef(image),
      config: imageGenRollbackMachineConfig(image, "app"),
    },
    {
      id: "legacy-worker-primary",
      state: "started",
      region: "ams",
      image_ref: immutableImageRef(image),
      config: imageGenRollbackMachineConfig(image, "worker"),
    },
    {
      id: "legacy-worker-standby",
      state: "stopped",
      region: "ams",
      image_ref: immutableImageRef(image),
      config: {
        ...imageGenRollbackMachineConfig(image, "worker"),
        standbys: ["legacy-worker-primary"],
      },
    },
  ];
  for (const machine of machines) {
    machine.config.metadata.fly_builder_id = "a".repeat(14);
    machine.config.env.MESSENGER_GLOBAL_MONTHLY_SPEND_CAP_USD = "50.00";
    machine.config.env.OPENAI_IMAGE_ESTIMATED_COST_USD = "0.30";
  }
  const scale = [
    { Process: "app", Count: 2, CPUKind: "shared", CPUs: 1, Memory: 256 },
    {
      Process: "worker",
      Count: 2,
      CPUKind: "shared",
      CPUs: 1,
      Memory: 256,
    },
  ];
  mutate({ live, machines, scale });
  return (args) => {
    const command = args.slice(0, 2).join(" ");
    if (command === "config show") return JSON.stringify(live);
    if (command === "machine list") return JSON.stringify(machines);
    if (command === "scale show") return JSON.stringify(scale);
    throw new Error(`Unexpected fly command: ${args.join(" ")}`);
  };
}

function imageGenLiveConfig(identity, { rollback = false } = {}) {
  const configPath = rollback
    ? "deploy/production/rollback-configs/image-gen-28d862568aa3.toml"
    : "apps/image-gen/fly.toml";
  const env = checkedInTomlEnv(configPath);
  if (identity !== "none") env.LEADERBOT_DEPLOYMENT_IDENTITY = identity;
  return {
    app: "leaderbot-fb-image-gen",
    primary_region: "ams",
    ...(rollback ? {} : { kill_signal: "SIGTERM", kill_timeout: 300 }),
    build: { dockerfile: "Dockerfile" },
    deploy: {
      strategy: "rolling",
      ...(rollback
        ? {}
        : {
            release_command:
              "timeout -k 30s 8m env LEADERBOT_PRODUCTION_MIGRATION_MODE=verify-artifact node dist/migrate-production.cjs",
            release_command_timeout: "10m",
          }),
    },
    env,
    processes: {
      app: "env MESSENGER_GENERATION_QUEUE_ENABLED=1 MESSENGER_GENERATION_INLINE_FALLBACK=0 node dist/index.cjs",
      worker:
        "env MESSENGER_GENERATION_QUEUE_ENABLED=1 MESSENGER_GENERATION_WORKER_ONLY=1 node dist/index.cjs",
    },
    http_service: {
      internal_port: 8080,
      force_https: true,
      auto_stop_machines: rollback ? "off" : false,
      auto_start_machines: true,
      min_machines_running: 1,
      processes: ["app"],
      checks: [
        {
          interval: "15s",
          timeout: "5s",
          grace_period: "10s",
          method: "GET",
          path: "/healthz",
        },
        ...(rollback
          ? []
          : [
              {
                interval: "15s",
                timeout: "5s",
                grace_period: "45s",
                method: "GET",
                path: "/readyz",
              },
            ]),
      ],
    },
  };
}

function storageProxyFlyState(image) {
  return (args) => {
    const command = args.slice(0, 2).join(" ");
    if (command === "config show") {
      return JSON.stringify({
        app: "leaderbot-storage-proxy",
        primary_region: "ams",
        deploy: { strategy: "rolling" },
        env: {
          STORAGE_OPERATION_TIMEOUT_MS: "60000",
          STORAGE_ALLOW_LEGACY_BEARER_AUTH: "true",
          STORAGE_ALLOW_LEGACY_KEYS: "true",
          STORAGE_TRUST_FLY_CLIENT_IP: "true",
        },
        processes: { app: "node dist/index.cjs" },
        http_service: {
          internal_port: 8787,
          force_https: true,
          auto_stop_machines: "stop",
          auto_start_machines: true,
          min_machines_running: 1,
          processes: ["app"],
          checks: [
            {
              interval: "15s",
              timeout: "5s",
              grace_period: "60s",
              method: "GET",
              path: "/healthz",
            },
          ],
        },
      });
    }
    if (command === "machine list") {
      return JSON.stringify([
        {
          id: "storage-proxy-machine",
          state: "started",
          region: "ams",
          image_ref: immutableImageRef(image),
          config: storageProxyMachineConfig(image),
        },
      ]);
    }
    if (command === "scale show") {
      return JSON.stringify([
        { Process: "app", Count: 1, CPUKind: "shared", CPUs: 1, Memory: 256 },
      ]);
    }
    throw new Error(`Unexpected fly command: ${args.join(" ")}`);
  };
}

describe("production deployment contract", () => {
  it("checks the parsed Fly API hostname instead of URL substrings", () => {
    expect(
      referencesForbiddenFlyApiUrl(
        "curl https://api.fly.io/app/flyctl_releases/v0.4.85/flyctl.tar.gz",
      ),
    ).toBe(true);
    expect(
      referencesForbiddenFlyApiUrl(
        "curl https://API.FLY.IO./app/flyctl_releases/v0.4.85/flyctl.tar.gz",
      ),
    ).toBe(true);

    for (const deceptiveUrl of [
      "https://example.invalid/api.fly.io/flyctl.tar.gz",
      "https://example.invalid/?host=api.fly.io",
      "https://api.fly.io@evil.example/flyctl.tar.gz",
      "https://api.fly.io.evil.example/flyctl.tar.gz",
      "https://evil-api.fly.io/flyctl.tar.gz",
    ]) {
      expect(referencesForbiddenFlyApiUrl(`curl ${deceptiveUrl}`)).toBe(false);
    }
  });

  it("accepts the checked-in production configs", () => {
    expect(validateProductionRepository(repoRoot)).toEqual({
      apps: 3,
      callbacks: 2,
    });
  });

  it("rejects the remote setup-flyctl action in every production path", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/build-production-artifacts.yml",
      "        shell: bash\n        run: |",
      "        uses: superfly/flyctl-actions/setup-flyctl@ed8efb33836e8b2096c7fd3ba1c8afe303ebbff1\n        run: |",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must never use an unverified remote flyctl installer",
    );
  });

  it("rejects the fly.io release resolver even when an installer remains pinned", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/build-production-artifacts.yml",
      "https://github.com/superfly/flyctl/releases/download/v0.4.85/flyctl_0.4.85_Linux_x86_64.tar.gz",
      "https://api.fly.io/app/flyctl_releases/v0.4.85/flyctl_Linux_x86_64.tar.gz",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must never use an unverified remote flyctl installer",
    );
  });

  it("rejects a flyctl asset from the wrong platform or URL", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/image-gen-schema-transition.yml",
      "https://github.com/superfly/flyctl/releases/download/v0.4.85/flyctl_0.4.85_Linux_x86_64.tar.gz",
      "https://github.com/superfly/flyctl/releases/download/v0.4.85/flyctl_0.4.85_Linux_arm64.tar.gz",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must download the exact Linux x86_64 flyctl asset",
    );
  });

  it("rejects a changed flyctl version pin", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      "FLYCTL_VERSION: 0.4.85",
      "FLYCTL_VERSION: 0.4.86",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must pin the reviewed flyctl version",
    );
  });

  it("rejects a changed flyctl archive digest", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/cleanup-image-gen-schema-probes.yml",
      "c3b5ed05319adf8a265d68171758ea7b37bd340c5c3dc4e09e17fb6344b8ff90",
      "d3b5ed05319adf8a265d68171758ea7b37bd340c5c3dc4e09e17fb6344b8ff90",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must download the exact Linux x86_64 flyctl asset",
    );
  });

  it("rejects a flyctl installer without SHA verification", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/deploy-production.yml",
      '"$archive" | sha256sum --check --strict',
      'test -s "$archive"',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must download the exact Linux x86_64 flyctl asset",
    );
  });

  it("rejects flyctl verification after archive extraction", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/build-production-artifacts.yml",
      '          printf \'%s  %s\\n\' \\\n            "c3b5ed05319adf8a265d68171758ea7b37bd340c5c3dc4e09e17fb6344b8ff90" \\\n            "$archive" | sha256sum --check --strict\n          tar --extract --gzip --file "$archive" --directory "$extract_dir" flyctl',
      '          tar --extract --gzip --file "$archive" --directory "$extract_dir" flyctl\n          printf \'%s  %s\\n\' \\\n            "c3b5ed05319adf8a265d68171758ea7b37bd340c5c3dc4e09e17fb6344b8ff90" \\\n            "$archive" | sha256sum --check --strict',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "before extraction or PATH exposure",
    );
  });

  it("rejects every new Fly-token job without the verified flyctl path", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/deploy-production.yml",
    );
    fs.appendFileSync(
      workflowPath,
      "\n  unsafe-fly-job:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Unsafe Fly access\n        env:\n          FLY_API_TOKEN: ${{ secrets.FLY_IMAGE_GEN_DEPLOY_TOKEN }}\n        run: flyctl status --app leaderbot-fb-image-gen\n",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "every Fly-token job must install only the exact verified flyctl binary",
    );
  });

  it("never exposes a Fly token to the installer itself", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/build-production-artifacts.yml",
      "        shell: bash\n        run: |",
      "        shell: bash\n        env:\n          FLY_API_TOKEN: ${{ secrets.FLY_IMAGE_GEN_DEPLOY_TOKEN }}\n        run: |",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must expose Fly tokens only after the exact verified flyctl path is installed",
    );
  });

  it("documents the dedicated metadata-only recovery inspection secret", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      "docs/operations/production-deployments.md",
      "FLY_RECOVERY_READONLY_TOKEN",
      "FLY_UNSCOPED_RECOVERY_TOKEN",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must document the recovery successor-inspection token",
    );
  });

  it("documents that automatic recovery has no SQL or customer-table access", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      "docs/operations/production-deployments.md",
      "Automatic app recovery receives no SQL credential or database URL",
      "Automatic app recovery receives a read-only SQL credential",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must deny SQL and customer-table access to automatic recovery",
    );
  });

  it("rejects a broad automatic-recovery database inspection principal", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      "docs/operations/production-deployments.md",
      "No MySQL principal is provisioned to automatic no-review",
      "recovery inspection: exactly `SELECT`. No MySQL principal is provisioned to automatic no-review",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must not provision database inspection or provider-write capability",
    );
  });

  it("keeps database-provider write authority out of production-recovery", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      "docs/operations/production-deployments.md",
      "Never add a database-app write token",
      "Add `FLY_DATABASE_RECOVERY_TOKEN`, then never add a database-app write token",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must not provision database inspection or provider-write capability",
    );
  });

  it("requires all three canonical production targets", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    delete manifest.apps["storage-proxy"];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => validateProductionRepository(root)).toThrow(
      "Production manifest must define exactly: gateway, image-gen, storage-proxy",
    );
  });

  it("rejects an unbounded production storage proxy", () => {
    const root = createRepositoryFixture();
    const configPath = path.join(root, "apps/image-gen/storage-proxy/fly.toml");
    const config = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(
      configPath,
      config.replace(
        'STORAGE_OPERATION_TIMEOUT_MS = "60000"',
        'STORAGE_OPERATION_TIMEOUT_MS = "900000"',
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must enforce the reviewed 60s R2 operation deadline",
    );
  });

  it("requires fail-closed shared storage-proxy rate limiting", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      "apps/image-gen/storage-proxy/index.ts",
      'app.use("/v1/storage", storageOperationRateLimiter)',
      "// operation limiter removed",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "storage proxy must fail closed on shared Redis rate limiting",
    );
  });

  it("requires the real shared-Redis storage-proxy CI test", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/image-gen-ci.yml",
      'RUN_STORAGE_RATE_LIMIT_REDIS_INTEGRATION: "1"',
      'RUN_STORAGE_RATE_LIMIT_REDIS_INTEGRATION: "0"',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "image-gen CI must validate the independently locked storage proxy",
    );
  });

  it("requires the independent storage-proxy dependency audit", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(root, ".github/workflows/image-gen-ci.yml");
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        "pnpm --dir storage-proxy audit --audit-level=moderate",
        "true # storage-proxy audit removed",
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "image-gen CI must validate the independently locked storage proxy",
    );
  });

  it("requires the storage-proxy runtime artifact label", () => {
    const root = createRepositoryFixture();
    const dockerfilePath = path.join(
      root,
      "apps/image-gen/storage-proxy/Dockerfile",
    );
    const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
    fs.writeFileSync(
      dockerfilePath,
      dockerfile.replace(
        'io.leaderbot.artifact.kind="runtime"',
        'io.leaderbot.artifact.kind="unknown"',
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "storage-proxy production image must declare the runtime artifact kind",
    );
  });

  it("requires the exact global Node base digest in the storage-proxy image", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      "apps/image-gen/storage-proxy/Dockerfile",
      "ARG NODE_BASE_IMAGE=node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43",
      "ARG NODE_BASE_IMAGE=node:24-alpine",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must use the exact globally pinned Node base digest",
    );
  });

  it("requires the exact global Node base digest in the image-gen image", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      "apps/image-gen/Dockerfile",
      "ARG NODE_BASE_IMAGE=node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43",
      "ARG NODE_BASE_IMAGE=node:24-alpine",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must use the exact globally pinned Node base digest",
    );
  });

  it("requires the pinned Node argument before the first Docker FROM", () => {
    const root = createRepositoryFixture();
    const relativePath = "apps/image-gen/Dockerfile";
    const dockerfilePath = path.join(root, relativePath);
    const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
    const nodeArg =
      "ARG NODE_BASE_IMAGE=node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43";
    fs.writeFileSync(
      dockerfilePath,
      dockerfile
        .replace(`${nodeArg}\n`, "")
        .replace(
          "FROM ${NODE_BASE_IMAGE} AS build",
          `FROM \${NODE_BASE_IMAGE} AS build\n${nodeArg}`,
        ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must use the exact globally pinned Node base digest",
    );
  });

  it("rejects a mutable gateway Dockerfile frontend", () => {
    const root = createRepositoryFixture();
    const dockerfilePath = path.join(root, "deploy/fly-gateway/Dockerfile");
    const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
    fs.writeFileSync(
      dockerfilePath,
      `# syntax=docker/dockerfile:1.7\n${dockerfile}`,
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must not use a mutable Dockerfile frontend",
    );
  });

  it("requires the exact ffmpeg package pin and runtime label", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      "apps/image-gen/Dockerfile",
      "ARG FFMPEG_VERSION=8.1.2-r0",
      "ARG FFMPEG_VERSION=8.1.2",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must pin ffmpeg exactly",
    );
  });

  it("declares the exact migration bridge base before the first FROM", () => {
    const root = createRepositoryFixture();
    const dockerfilePath = path.join(root, "apps/image-gen/Dockerfile");
    const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
    const bridgeArg =
      "ARG MIGRATION_BRIDGE_BASE_IMAGE=registry.fly.io/leaderbot-fb-image-gen@sha256:28d862568aa3cb049ac4aba164bb1e01792691feec646ff87c657f72bd306804";
    fs.writeFileSync(
      dockerfilePath,
      dockerfile
        .replace(`${bridgeArg}\n`, "")
        .replace(
          "FROM ${NODE_BASE_IMAGE} AS build",
          `FROM \${NODE_BASE_IMAGE} AS build\n${bridgeArg}`,
        ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must declare its exact migration bridge base before the first FROM instruction",
    );
  });

  it("keys the CI cache on the storage-proxy workspace policy", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(root, ".github/workflows/image-gen-ci.yml");
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        "            apps/image-gen/storage-proxy/pnpm-workspace.yaml\n",
        "",
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "image-gen CI must validate the independently locked storage proxy",
    );
  });

  it("forbids bypassing the storage-proxy workspace policy", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(root, ".github/workflows/image-gen-ci.yml");
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        "pnpm --dir storage-proxy audit --audit-level=moderate",
        "pnpm --dir storage-proxy audit --audit-level=moderate --ignore-workspace",
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "storage-proxy installs and audits must apply its local workspace policy",
    );
  });

  it("requires storage-proxy Fly liveness checks", () => {
    const root = createRepositoryFixture();
    const configPath = path.join(root, "apps/image-gen/storage-proxy/fly.toml");
    const config = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(
      configPath,
      config.replace('path = "/healthz"', 'path = "/readyz"'),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "apps/image-gen/storage-proxy/fly.toml must define a /healthz service check",
    );
  });

  it("requires separate external storage-proxy readiness monitoring", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/production-uptime.yml",
      "https://leaderbot-storage-proxy.fly.dev/readyz",
      "https://leaderbot-storage-proxy.fly.dev/healthz",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      ".github/workflows/production-uptime.yml must monitor /readyz",
    );
  });

  it("does not require an undeployed storage-proxy readiness route on pull requests", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/production-uptime.yml",
      "        if: github.event_name != 'pull_request'\n",
      "",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must defer storage-proxy readiness until post-deploy monitoring",
    );
  });

  it("requires deploy and rollback to prove storage-proxy readiness", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/deploy-production.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replaceAll(
        "https://leaderbot-storage-proxy.fly.dev/readyz",
        "https://leaderbot-storage-proxy.fly.dev/healthz",
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must prove storage-proxy liveness and shared-limiter readiness after deploy and rollback",
    );
  });

  it("gates rollback readiness on the reviewed storage-proxy image contract", () => {
    const root = createRepositoryFixture();
    replaceLastFixtureText(
      root,
      ".github/workflows/deploy-production.yml",
      'if [[ "$rollback_kind" != "legacy-bootstrap" ]]; then',
      'if [[ "$rollback_kind" != "unreviewed-legacy" ]]; then',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must prove storage-proxy liveness and shared-limiter readiness after deploy and rollback",
    );
  });

  it("requires successor and restore recovery to prove storage-proxy readiness", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replaceAll(
        "https://leaderbot-storage-proxy.fly.dev/readyz",
        "https://leaderbot-storage-proxy.fly.dev/healthz",
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must prove restored storage-proxy liveness and shared-limiter readiness",
    );
  });

  it("gates recovered readiness on the reviewed storage-proxy image contract", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      'if [[ "$rollback_kind" != "legacy-bootstrap" ]]; then',
      'if [[ "$rollback_kind" != "unreviewed-legacy" ]]; then',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must prove restored storage-proxy liveness and shared-limiter readiness",
    );
  });

  it("rejects deceptive storage-proxy readiness URL substrings", () => {
    for (const workflowFile of [
      ".github/workflows/deploy-production.yml",
      ".github/workflows/reconcile-production-deployment.yml",
    ]) {
      const root = createRepositoryFixture();
      const workflowPath = path.join(root, workflowFile);
      const workflow = fs.readFileSync(workflowPath, "utf8");
      fs.writeFileSync(
        workflowPath,
        workflow.replaceAll(
          "https://leaderbot-storage-proxy.fly.dev/readyz",
          "https://attacker.invalid/https://leaderbot-storage-proxy.fly.dev/readyz",
        ),
      );

      expect(() => validateProductionRepository(root)).toThrow(
        /must prove .*storage-proxy .*readiness/u,
      );
    }
  });

  it("rejects the retired global image-forward cap in gateway production", () => {
    const root = createRepositoryFixture();
    const configPath = path.join(root, "fly.toml");
    const config = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(
      configPath,
      config.replace(
        "[env]",
        '[env]\nMESSENGER_GATEWAY_DAILY_IMAGE_FORWARD_CAP = "1"',
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "fly.toml must not set retired MESSENGER_GATEWAY_DAILY_IMAGE_FORWARD_CAP",
    );
  });

  it("rejects the retired global Leaderbot event-forward cap in gateway production", () => {
    const root = createRepositoryFixture();
    const configPath = path.join(root, "fly.toml");
    const config = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(
      configPath,
      config.replace(
        "[env]",
        '[env]\nMESSENGER_GATEWAY_DAILY_LEADERBOT_EVENT_FORWARD_CAP = "1"',
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "fly.toml must not set retired MESSENGER_GATEWAY_DAILY_LEADERBOT_EVENT_FORWARD_CAP",
    );
  });

  it("requires artifact-specific schema verification across the bridge transition", () => {
    const root = createRepositoryFixture();
    const configPath = path.join(root, "apps/image-gen/fly.toml");
    const config = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(
      configPath,
      config.replace(
        "env LEADERBOT_PRODUCTION_MIGRATION_MODE=verify-artifact",
        "env LEADERBOT_PRODUCTION_MIGRATION_MODE=verify-expand",
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must bound artifact-specific schema verification below the Fly release timeout",
    );
  });

  it("bounds the in-Machine verifier below Fly's outer release timeout", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      "apps/image-gen/fly.toml",
      "timeout -k 30s 8m env LEADERBOT_PRODUCTION_MIGRATION_MODE=verify-artifact",
      "env LEADERBOT_PRODUCTION_MIGRATION_MODE=verify-artifact",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must bound artifact-specific schema verification below the Fly release timeout",
    );
  });

  it("requires green CI for the exact deployment workflow source", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/deploy-production.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        '--verify-source-ci "$GITHUB_SHA"',
        '--verify-source-ci "$REVIEWED_IMAGE"',
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must require green CI for the exact deployment source",
    );
  });

  it("requires green CI for the exact schema-transition workflow source", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/image-gen-schema-transition.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        '--verify-source-ci "$GITHUB_SHA"',
        '--verify-source-ci "$BRIDGE_SOURCE"',
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must require green CI for the exact transition source",
    );
  });

  it("keeps deployment secrets out of whole-job scope", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/deploy-production.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        "          FLY_API_TOKEN: ${{ secrets.FLY_GATEWAY_DEPLOY_TOKEN }}",
        "      FLY_API_TOKEN: ${{ secrets.FLY_GATEWAY_DEPLOY_TOKEN }}",
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must scope production secrets to only the steps that use them",
    );
  });

  it("authenticates Fly config validation with the exact app token", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/deploy-production.yml",
      "      - name: Validate Fly configuration\n        timeout-minutes: 2\n        working-directory: apps/image-gen\n        env:\n          FLY_API_TOKEN: ${{ secrets.FLY_IMAGE_GEN_DEPLOY_TOKEN }}",
      "      - name: Validate Fly configuration\n        timeout-minutes: 2\n        working-directory: apps/image-gen\n        env:\n          FLY_API_TOKEN: ${{ secrets.FLY_GATEWAY_DEPLOY_TOKEN }}",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must authenticate each Fly config validation with its exact app-scoped token",
    );
  });

  it("reserves the enlarged deploy job timeouts", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/deploy-production.yml",
      "    timeout-minutes: 150",
      "    timeout-minutes: 80",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must reserve time for image-gen deploy and verified rollback",
    );
  });

  it("gives image-gen deploy and rollback enough time to drain safely", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/deploy-production.yml",
      "      - name: Deploy reviewed image-gen config\n        id: deploy\n        timeout-minutes: 35",
      "      - name: Deploy reviewed image-gen config\n        id: deploy\n        timeout-minutes: 20",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must leave room for the 10m release command, 5m worker drain, rollout, and verification",
    );
  });

  it("requires immutable bridge and runtime schema markers", () => {
    const root = createRepositoryFixture();
    const dockerfilePath = path.join(root, "apps/image-gen/Dockerfile");
    const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
    fs.writeFileSync(
      dockerfilePath,
      dockerfile.replace(
        "'runtime' > /app/.leaderbot-artifact-kind",
        "'migration-bridge' > /app/.leaderbot-artifact-kind",
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must include the hashed migration contract and exact schema range",
    );
  });

  it("requires the provider-silent WhatsApp provisioning command in the runtime artifact", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      "apps/image-gen/package.json",
      "--outfile=dist/provision-whatsapp-binding.cjs",
      "--outfile=dist/missing-whatsapp-provisioning.cjs",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "image-gen build:docker must bundle the provider-silent WhatsApp provisioning command",
    );
  });

  it("requires CI to inspect the bundled WhatsApp provisioning command", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/image-gen-ci.yml",
      'docker run --rm "$image" test -s /app/dist/provision-whatsapp-binding.cjs',
      'docker run --rm "$image" true',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "image-gen CI must inspect the bundled WhatsApp provisioning command",
    );
  });

  it("keeps runtime artifacts on exact 0016 until writer fencing exists", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/build-production-artifacts.yml",
      'kind="runtime"\n              schema_minimum="0016_expand"\n              schema_maximum="0016_expand"',
      'kind="runtime"\n              schema_minimum="0016_expand"\n              schema_maximum="0017_contract"',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "runtime artifacts must remain exactly 0016_expand",
    );
  });

  it("rejects a Docker runtime that claims unsupported 0017 compatibility", () => {
    const root = createRepositoryFixture();
    const dockerfilePath = path.join(root, "apps/image-gen/Dockerfile");
    const dockerfile = fs.readFileSync(dockerfilePath, "utf8");
    const marker = 'io.leaderbot.schema.maximum="0016_expand"';
    const runtimeMarkerIndex = dockerfile.lastIndexOf(marker);
    expect(runtimeMarkerIndex).toBeGreaterThan(0);
    fs.writeFileSync(
      dockerfilePath,
      `${dockerfile.slice(0, runtimeMarkerIndex)}io.leaderbot.schema.maximum="0017_contract"${dockerfile.slice(runtimeMarkerIndex + marker.length)}`,
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "runtime artifact must stay on the exact 0016_expand schema range",
    );
  });

  it.each([
    ".github/workflows/image-gen-ci.yml",
    ".github/workflows/image-gen-migration-smoke.yml",
  ])("keeps %s runtime label checks on exact 0016", (workflowPath) => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      workflowPath,
      `io.leaderbot.schema.maximum" }}' "$image")" = "0016_expand"`,
      `io.leaderbot.schema.maximum" }}' "$image")" = "0017_contract"`,
    );

    expect(() => validateProductionRepository(root)).toThrow(
      `${workflowPath} must assert the exact 0016_expand runtime image range`,
    );
  });

  it("requires pinned attestations from the trusted artifact builder", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/build-production-artifacts.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replaceAll(
        "actions/attest@1e69f48acb82d1966a394da916b4c1698aa569d6",
        "actions/attest@v4",
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must pin both attestation steps",
    );
  });

  it("keeps the production Fly token out of dependency and build steps", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/build-production-artifacts.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        "    steps:\n",
        "    env:\n      FLY_API_TOKEN: ${{ secrets.FLY_IMAGE_GEN_DEPLOY_TOKEN }}\n    steps:\n",
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must expose Fly tokens only after the exact verified flyctl path is installed",
    );
  });

  it("does not fall back to another app token when a registry secret is missing", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/build-production-artifacts.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        "${{ secrets.FLY_STORAGE_PROXY_DEPLOY_TOKEN }}",
        "${{ inputs.target == 'storage-proxy' && secrets.FLY_STORAGE_PROXY_DEPLOY_TOKEN || secrets.FLY_IMAGE_GEN_DEPLOY_TOKEN }}",
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must scope each Fly token to its exact fail-closed registry-auth step",
    );
  });

  it("removes registry credentials before attestation and upload", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/build-production-artifacts.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        "docker logout registry.fly.io",
        "echo registry credential retained",
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must remove registry credentials before attestation and upload",
    );
  });

  it("removes both deploy-job registry credentials before uploads", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/deploy-production.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        "docker logout registry.fly.io",
        "echo registry credential retained",
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must remove every private registry credential before deploy and upload",
    );
  });

  it("binds the schema transition to the trusted builder workflow", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/image-gen-schema-transition.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replaceAll("--signer-workflow", "--untrusted-workflow"),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must bind the trusted builder workflow",
    );
  });

  it("requires a successful settled bridge identity before schema approval and DDL", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/image-gen-schema-transition.yml",
      '--verify-settled-baseline image-gen "$settled_identity"',
      '--trust-settled-baseline image-gen "$settled_identity"',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must prove the live bridge came from a completed successful canonical deploy",
    );
  });

  it("runs schema live-state inspection outside the production approval environment", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/image-gen-schema-transition.yml",
      "environment: production-inspection",
      "environment: production",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must run one metadata-only settled preflight in production-inspection",
    );
  });

  it("requires a fresh database snapshot before the expand migration", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/image-gen-schema-transition.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace("volumes snapshots create", "volumes snapshots list"),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must create a fresh database snapshot",
    );
  });

  it("uploads durable snapshot evidence before any live expand DDL", () => {
    const root = createRepositoryFixture();
    const relativePath = ".github/workflows/image-gen-schema-transition.yml";
    const workflowPath = path.join(root, relativePath);
    const workflow = fs.readFileSync(workflowPath, "utf8");
    const uploadStart = workflow.indexOf(
      "      - name: Upload immutable pre-expand recovery evidence before DDL",
    );
    const applyStart = workflow.indexOf(
      "      - name: Apply only the reviewed 0016 expand migration",
    );
    const verifyStart = workflow.indexOf(
      "      - name: Verify the exact 0016 expanded schema",
    );
    expect(uploadStart).toBeGreaterThan(-1);
    expect(applyStart).toBeGreaterThan(uploadStart);
    expect(verifyStart).toBeGreaterThan(applyStart);
    const uploadStep = workflow.slice(uploadStart, applyStart);
    fs.writeFileSync(
      workflowPath,
      `${workflow.slice(0, uploadStart)}${workflow.slice(applyStart, verifyStart)}${uploadStep}${workflow.slice(verifyStart)}`,
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must durably upload verified snapshot evidence before any expand DDL",
    );
  });

  it("requires a baseline-aware fresh snapshot selector", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/image-gen-schema-transition.yml",
      'node scripts/select-fresh-fly-snapshot.mjs "$before" "$current" "$snapshot_started_at"',
      'jq -c ".[0]" "$current"',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must select exactly one new snapshot created after this run scheduled it",
    );
  });

  it("does not assume snapshot creation supports JSON output", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/image-gen-schema-transition.yml",
      'flyctl volumes snapshots create "$volume_id" --app "$db_app"',
      'flyctl volumes snapshots create "$volume_id" --app "$db_app" --json',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "instead of assuming create supports JSON",
    );
  });

  it("binds the live database Machine to the exact reviewed volume", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/image-gen-schema-transition.yml",
      'select(.state=="started" and any(.config.mounts[]?; .volume==$volume and .path=="/var/lib/mysql"))',
      'select(.state=="started" and any(.config.mounts[]?; .path=="/var/lib/mysql"))',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must bind the database Machine to the exact reviewed volume and mount path",
    );
  });

  it("binds the migration principal to the local database tunnel", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/image-gen-schema-transition.yml",
      'u.hostname!=="127.0.0.1"||u.port!=="13306"',
      'u.hostname!=="leaderbot-portal-mysql.internal"',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must restrict the migration principal URL to the local protected tunnel",
    );
  });

  it("binds resumed recovery evidence to the exact workflow source", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/image-gen-schema-transition.yml",
      '.id==$runId and .run_attempt==$runAttempt and .status=="completed" and (.head_sha|test("^[a-f0-9]{40}$")) and .head_branch=="main" and .event=="workflow_dispatch" and .path==".github/workflows/image-gen-schema-transition.yml"',
      '.head_branch=="main"',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must bind resume evidence to the exact protected workflow run and source",
    );
  });

  it("requires a bounded disposable restore-probe Machine", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/image-gen-schema-transition.yml",
      "            --rm \\\n",
      "",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must request automatic removal of the isolated probe",
    );
  });

  it("propagates the bounded remote restore-probe exit status", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/image-gen-schema-transition.yml",
      "timeout --signal=TERM 8m flyctl ssh console",
      "flyctl ssh console",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must bound the remote restore verification and propagate its exit status",
    );
  });

  it("keeps the restore-probe outer timeout above all bounded subphases", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/image-gen-schema-transition.yml",
      "        timeout-minutes: 25",
      "        timeout-minutes: 17",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must give the bounded Machine start, start poll, and 8m SSH probe enough outer time",
    );
  });

  it("allows failed in-job probes but rejects unknown cleanup states", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/image-gen-schema-transition.yml",
      '.state|IN("started","stopped","suspended","created","failed")',
      '.state|IN("started","stopped","suspended","created","failed","destroying")',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must allow only exact restore-probe cleanup in known removable states",
    );
  });

  it("requires the exact restore volume before always-cleanup can delete a failed probe", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/image-gen-schema-transition.yml",
      '$volume!="" and ([.config.mounts[]? | select(.volume==$volume and .path=="/var/lib/mysql")] | length)==1 and (.config.mounts|length)==1',
      '([.config.mounts[]? | select(.path=="/var/lib/mysql")] | length)>=1',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must bind failed-probe cleanup to the exact name, metadata, and single restore-volume mount tuple",
    );
  });

  it("passes workflow input through env instead of a run expression", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/image-gen-schema-transition.yml",
      '          test -z "$RECOVERY_RUN_ID"',
      '          test -z "${{ inputs.recovery_run_id }}"',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must pass GitHub expressions through step env",
    );
  });

  it("requires the independent schema-probe cleanup workflow", () => {
    const root = createRepositoryFixture();
    fs.unlinkSync(
      path.join(root, ".github/workflows/cleanup-image-gen-schema-probes.yml"),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "Missing .github/workflows/cleanup-image-gen-schema-probes.yml",
    );
  });

  it("allows cleanup to select only exact reserved restore-probe names", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/cleanup-image-gen-schema-probes.yml",
      'test("^leaderbot-restore-probe-[0-9]+-[0-9]+$")',
      'test(".+")',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must identify probe Machines only by the reserved exact run-attempt name",
    );
  });

  it("allows failed restore probes but rejects every unknown cleanup state", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/cleanup-image-gen-schema-probes.yml",
      '.state|IN("started","stopped","suspended","created","failed")',
      '.state|IN("started","stopped","suspended","created","failed","destroying")',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must allow cleanup of only exact restore probes in known removable states",
    );
  });

  it("keeps failed-probe cleanup bound to one exact metadata and mount tuple", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/cleanup-image-gen-schema-probes.yml",
      'and (.config.mounts|length)==1\' <<<"$machine"',
      'and (.config.mounts|length)>=1\' <<<"$machine"',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must bind cleanup to the exact name, metadata, and single restore-volume mount tuple",
    );
  });

  it("obtains manual cleanup approval before entering the shared lock", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/cleanup-image-gen-schema-probes.yml",
      "    needs: approve\n",
      "",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must obtain protected production approval before its reviewerless protected-main mutation job enters the shared image-gen lock",
    );
  });

  it("never lets the approval job hold the shared image-gen lock", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/cleanup-image-gen-schema-probes.yml",
      "    timeout-minutes: 5\n    environment: production",
      "    timeout-minutes: 5\n    concurrency:\n      group: production-deploy-image-gen\n      cancel-in-progress: false\n      queue: max\n    environment: production",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must obtain protected production approval before its reviewerless protected-main mutation job enters the shared image-gen lock",
    );
  });

  it("keeps cleanup mutation out of a second reviewer-gated environment wait", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/cleanup-image-gen-schema-probes.yml",
      "    environment: production-schema-cleanup\n",
      "    environment: production\n",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must isolate the approved mutation in its protected-main reviewerless environment",
    );
  });

  it("rejects automatic workflow-run orphan cleanup", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/cleanup-image-gen-schema-probes.yml",
      "on:\n  workflow_dispatch:\n",
      'on:\n  workflow_run:\n    workflows: ["Apply reviewed image-gen schema expand"]\n    types: [completed]\n  workflow_dispatch:\n',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must run only as a reviewer-approved protected-main manual dispatch",
    );
  });

  it("runs manual schema cleanup only from protected main", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/cleanup-image-gen-schema-probes.yml",
      "if: github.ref == 'refs/heads/main'",
      "if: always()",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must reject manual cleanup from every non-main ref before requesting production approval",
    );
  });

  it("does not expose the reviewer-gated database token to an hourly schedule", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/cleanup-image-gen-schema-probes.yml",
      "  workflow_dispatch:\n",
      '  schedule:\n    - cron: "17 * * * *"\n  workflow_dispatch:\n',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must run only as a reviewer-approved protected-main manual dispatch",
    );
  });

  it("requires production approval before orphan probe deletion", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/cleanup-image-gen-schema-probes.yml",
      "    environment: production\n",
      "    environment: production-recovery\n",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must require reviewer-gated production approval before orphan cleanup",
    );
  });

  it("never gives the reviewerless recovery environment a database-app token", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/cleanup-image-gen-schema-probes.yml",
      "FLY_DATABASE_MIGRATION_TOKEN",
      "FLY_DATABASE_RECOVERY_TOKEN",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must use the reviewer-gated database migration token",
    );
  });

  it("requires independent reconciliation after interrupted deploys", () => {
    const root = createRepositoryFixture();
    fs.unlinkSync(
      path.join(root, ".github/workflows/reconcile-production-deployment.yml"),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "Missing .github/workflows/reconcile-production-deployment.yml",
    );
  });

  it("requires completion recovery when the inline runner disappears", () => {
    const root = createRepositoryFixture();
    fs.unlinkSync(
      path.join(
        root,
        ".github/workflows/recover-completed-production-deployment.yml",
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "Missing .github/workflows/recover-completed-production-deployment.yml",
    );
  });

  it("captures recovery protocol v1 in every durable rollback plan", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/deploy-production.yml",
      'printf \'%s\\n\' "v1" > "$RUNNER_TEMP/leaderbot-release/recovery-protocol.txt"',
      'printf \'%s\\n\' "v2" > "$RUNNER_TEMP/leaderbot-release/recovery-protocol.txt"',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must bind the durable image-gen rollback schema evidence to the reviewed manifest and rollback image before strict capture succeeds",
    );
  });

  it("rejects missing recovery protocol before a production recovery credential", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      'node "$RECOVERY_CONTROLLER" --validate-recovery-protocol "$RUNNER_TEMP/leaderbot-recovery/recovery-protocol.txt" --root-dir "$GITHUB_WORKSPACE"',
      'test -s "$RUNNER_TEMP/leaderbot-recovery/recovery-protocol.txt"',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must verify controller hash and recovery protocol before exposing any production credential for recover-gateway",
    );
  });

  it("binds current protected controller code before checking out interrupted data", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      "ref: ${{ github.sha }}",
      "ref: ${{ needs.inspect.outputs.source_sha }}",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must bind current protected controller code before treating the interrupted checkout only as data",
    );
  });

  it("never executes the interrupted commit's validator", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      'node "$RECOVERY_CONTROLLER" --validate-target-enabled image-gen --root-dir "$GITHUB_WORKSPACE"',
      "node scripts/validate-production-deployment.mjs --validate-target-enabled image-gen",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must keep all three recovery jobs independent, exact-source, and least-privileged",
    );
  });

  it("keeps every trusted-controller call explicitly bound to its data root", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      '--validate-target-enabled image-gen --root-dir "$GITHUB_WORKSPACE"',
      "--validate-target-enabled image-gen",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must keep all three recovery jobs independent, exact-source, and least-privileged",
    );
  });

  it("treats an incompatible interrupted validator only as inert data", () => {
    const root = createRepositoryFixture();
    fs.writeFileSync(
      path.join(root, "scripts/validate-production-deployment.mjs"),
      'throw new Error("interrupted validator must never execute");\n',
    );

    expect(() => validateProductionRepository(root)).not.toThrow();
    const output = execFileSync(
      process.execPath,
      [
        path.join(repoRoot, "scripts/validate-production-deployment.mjs"),
        "--reviewed-scale-plan",
        "storage-proxy",
        "--root-dir",
        root,
      ],
      { encoding: "utf8" },
    );
    expect(JSON.parse(output)).toEqual([{ process: "app", count: 1 }]);
  });

  it("derives every recovery scale count from the validated interrupted manifest", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      'flyctl scale count "$count" --process-group "$process" --app leaderbot-fb-image-gen --yes',
      "flyctl scale count 2 --process-group app --app leaderbot-fb-image-gen --yes",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must fail closed on image-gen manifest, config, identity, and live-state drift before restoring",
    );
  });

  it("binds completion recovery to exactly one failed run attempt", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/recover-completed-production-deployment.yml",
      'if length==0 then null elif length==1 then .[0] else error("multiple production rollback plans") end',
      "if length>=1 then .[0] else null end",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must select at most one exact unexpired rollback plan",
    );
  });

  it("treats zero completed-run rollback plans as a clean no-op", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/recover-completed-production-deployment.yml",
      'selected="$(jq -cr --argjson names',
      'selected="$(jq -cer --argjson names',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must allow zero matching artifacts to produce the explicit no-op null",
    );
  });

  it.each([
    [
      ".github/workflows/deploy-production.yml",
      "      target: gateway\n",
      "      target: gateway\n    secrets: inherit\n",
    ],
    [
      ".github/workflows/recover-completed-production-deployment.yml",
      "      target: ${{ needs.inspect.outputs.target }}\n",
      "      target: ${{ needs.inspect.outputs.target }}\n    secrets: inherit\n",
    ],
  ])(
    "does not let the production caller %s inherit secrets",
    (workflowPath, before, after) => {
      const root = createRepositoryFixture();
      replaceFixtureText(root, workflowPath, before, after);

      expect(() => validateProductionRepository(root)).toThrow(
        "production reusable recovery callers must never inherit caller secrets",
      );
    },
  );

  it("binds reconciliation to the canonical deploy workflow", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      '.path==".github/workflows/deploy-production.yml"',
      '.path==".github/workflows/build-production-artifacts.yml"',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must bind recovery to the exact canonical deploy attempt and its allowed lifecycle state",
    );
  });

  it("allows manual recovery only after an explicit failed lifecycle state", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      '(.conclusion|IN("failure","cancelled","timed_out","action_required","stale","startup_failure"))',
      '.conclusion!="success"',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must bind recovery to the exact canonical deploy attempt and its allowed lifecycle state",
    );
  });

  it("gives manual recovery the target lock without deadlocking an inline child", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      "group: ${{ inputs.invocation_mode == 'inline' && format('recovery-child-{0}', github.run_id) || format('production-deploy-{0}', inputs.target) }}",
      "group: production-recovery-${{ inputs.target }}",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must avoid a child deadlock while giving manual recovery the exact target lock",
    );
  });

  it("retains every deployment, schema, cleanup, and recovery lock waiter", () => {
    for (const [workflowPath, expectedError, queueLine] of [
      [
        ".github/workflows/deploy-production.yml",
        "must serialize and retain every target deployment with its exact production lock",
      ],
      [
        ".github/workflows/image-gen-schema-transition.yml",
        "must retain every protected schema transition in the lock queue",
      ],
      [
        ".github/workflows/cleanup-image-gen-schema-probes.yml",
        "must retain independent cleanup in the shared lock queue",
        "      queue: max\n",
      ],
      [
        ".github/workflows/reconcile-production-deployment.yml",
        "must retain every manual or post-completion recovery in the target lock queue",
      ],
    ]) {
      const root = createRepositoryFixture();
      replaceFixtureText(root, workflowPath, queueLine ?? "  queue: max\n", "");

      expect(() => validateProductionRepository(root)).toThrow(expectedError);
    }
  });

  it("marks every failed deploy caller as inline exact-attempt recovery", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/deploy-production.yml",
      "      invocation_mode: inline\n      recovery_run_id: ${{ github.run_id }}\n      recovery_run_attempt: ${{ github.run_attempt }}\n      target: image-gen",
      "      invocation_mode: manual\n      recovery_run_id: ${{ github.run_id }}\n      recovery_run_attempt: ${{ github.run_attempt }}\n      target: image-gen",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must invoke exact-attempt image-gen recovery only when its validated deploy job fails",
    );
  });

  it("names every durable rollback plan with the exact run attempt", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/deploy-production.yml",
      "name: image-gen-rollback-${{ github.run_id }}-${{ github.run_attempt }}",
      "name: image-gen-rollback-${{ github.run_id }}",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must name the image-gen rollback plan with the exact run attempt",
    );
  });

  it("keeps dependency installation outside secret-bearing recovery steps", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      '          test -n "$FLY_API_TOKEN"',
      '          npm ci\n          test -n "$FLY_API_TOKEN"',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must install dependencies before exposing a recovery credential",
    );
  });

  it("rejects recovery workflow code from every non-main ref", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      '          test "$GITHUB_REF" = "refs/heads/main"',
      "          true # unsafe non-main recovery",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must reject recovery workflow code from every non-main ref",
    );
  });

  it("binds every recovery successor to an exact approved source root", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      "--prepare-successor-root storage-proxy",
      "--verify-settled-baseline storage-proxy",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must validate storage-proxy successors from their exact approved source",
    );
  });

  it("binds successor drift to its exact source SHA and current reviewed image", () => {
    for (const [needle, replacement] of [
      ['--expected-source-sha "$successor_sha"', "--output-json"],
      ["--require-current-reviewed-image", "--allow-reviewed-machine-images"],
    ]) {
      const root = createRepositoryFixture();
      replaceFixtureText(
        root,
        ".github/workflows/reconcile-production-deployment.yml",
        needle,
        replacement,
      );

      expect(() => validateProductionRepository(root)).toThrow(
        "must validate gateway successors from their exact approved source with only metadata credentials",
      );
    }
  });

  it("rechecks an image-gen successor after schema compatibility proof and before mutation", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      "      - name: Recheck image-gen successor before recovery mutation",
      "      - name: Recheck image-gen successor after recovery mutation",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must validate image-gen successors from their exact approved source",
    );
  });

  it("removes only exact release-command Machines after the second successor check", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      "      - name: Remove exact image-gen recovery release-command Machines",
      "      - name: Remove unclassified image-gen Machines",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must remove only exact interrupted or captured-rollback release-command Machines",
    );
  });

  it("never destroys image-gen Machines without the exact two recovery tuples", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      '--recovery-release-command-machines image-gen --interrupted-deployment-identity "$interrupted_identity" --captured-prior-identity "$prior_identity" --captured-prior-image "$rollback_image"',
      '--recovery-release-command-machines image-gen --interrupted-deployment-identity "$interrupted_identity" --captured-prior-identity "$prior_identity" --captured-prior-image "$unreviewed_image"',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must revalidate and remove at most one exact release-command Machine per recovery tuple",
    );
  });

  it("polls validator-selected release Machines to absence after force-destroy", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      'flyctl machine destroy --force --app leaderbot-fb-image-gen "$machine_id"',
      'echo "unsafe release Machine $machine_id"',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must force-destroy only validator-selected image-gen release-command Machines",
    );
  });

  it("reselects safely when an auto-destroy wins the selector-to-destroy race", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      'if ! flyctl machine destroy --force --app leaderbot-fb-image-gen "$machine_id"; then',
      'flyctl machine destroy --force --app leaderbot-fb-image-gen "$machine_id"',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must revalidate and remove at most one exact release-command Machine per recovery tuple",
    );
  });

  it("never classifies a successor with a mutating recovery credential", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      "FLY_API_TOKEN: ${{ secrets.FLY_RECOVERY_READONLY_TOKEN }}",
      "FLY_API_TOKEN: ${{ secrets.FLY_STORAGE_PROXY_RECOVERY_TOKEN }}",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must validate gateway successors from their exact approved source with only metadata credentials",
    );
  });

  it.each([
    ["gateway", "FLY_GATEWAY_RECOVERY_TOKEN"],
    ["image-gen", "FLY_IMAGE_GEN_RECOVERY_TOKEN"],
    ["storage-proxy", "FLY_STORAGE_PROXY_RECOVERY_TOKEN"],
  ])(
    "does not expose a GitHub credential to the %s mutation step",
    (target, token) => {
      const root = createRepositoryFixture();
      replaceFixtureText(
        root,
        ".github/workflows/reconcile-production-deployment.yml",
        `          FLY_API_TOKEN: \${{ secrets.${token} }}\n`,
        `          FLY_API_TOKEN: \${{ secrets.${token} }}\n          GITHUB_TOKEN: \${{ github.token }}\n`,
      );

      expect(() => validateProductionRepository(root)).toThrow(
        target === "image-gen"
          ? "must revalidate and remove at most one exact release-command Machine per recovery tuple"
          : `must not expose GitHub credentials to the ${target} app-mutation step`,
      );
    },
  );

  it("never executes code fetched from a successor commit", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      '          health="$(mktemp)"',
      '          node "$successor_root/untrusted.mjs"\n          health="$(mktemp)"',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must validate image-gen successors from their exact approved source with only metadata credentials",
    );
  });

  it("rejects stale live state before reconciliation overwrites it", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      "--live image-gen --predeploy",
      "--live image-gen",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must fail closed on image-gen manifest, config, identity, and live-state drift before restoring",
    );
  });

  it("checks the captured manifest schema phase against rollback-image compatibility", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      ".reviewedRollbackImageSchemaPhases[$image] | index($phase) != null",
      "true",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must prove the rollback image supports the exact captured manifest phase",
    );
  });

  it("binds recovery schema evidence to the exact interrupted manifest", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      'test "$phase" = "$(jq -er \'.apps["image-gen"].databaseSchemaPhase\' deploy/production/apps.json)"',
      'test -n "$phase"',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must bind rollback schema evidence to the interrupted deployment manifest",
    );
  });

  it("requires the image-gen rollback schema artifact before automatic recovery", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      '          test -f "$RUNNER_TEMP/leaderbot-recovery/rollback-schema-phase.txt"\n',
      "",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must require the immutable manifest-bound image-gen schema evidence",
    );
  });

  it("records image-gen schema compatibility in the durable rollback plan", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/deploy-production.yml",
      '          printf \'%s\\n\' "$rollback_schema_phase" > "$RUNNER_TEMP/leaderbot-release/rollback-schema-phase.txt"\n',
      "",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must preserve the manifest-bound image-gen rollback schema phase",
    );
  });

  it("selects only the rollback artifact for the exact run attempt", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      'artifact_name="${REQUESTED_TARGET}-rollback-${RUN_ID}-${RUN_ATTEMPT}"',
      'artifact_name="${REQUESTED_TARGET}-rollback-${RUN_ID}"',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must bind the rollback plan to the exact target and run attempt",
    );
  });

  it("allows mixed reviewed Machines only for a same-job partial rollback", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");
    expect(workflow).toContain("--allow-reviewed-machine-images");
    fs.writeFileSync(
      workflowPath,
      workflow.replaceAll(" --allow-reviewed-machine-images", ""),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must allow mixed Machines only for the exact same-attempt rollback state",
    );
  });

  it("allows scale-count drift only in the exact partial-rollback gate", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");
    expect(workflow).toContain("--allow-scale-count-drift");
    fs.writeFileSync(
      workflowPath,
      workflow.replaceAll(" --allow-scale-count-drift", ""),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must bind count-only recovery drift to the captured prior and interrupted identities",
    );
  });

  it.each([
    "IMAGE_GEN_DATABASE_RECOVERY_INSPECTION_URL",
    "DATABASE_URL",
    "FLY_DATABASE_RECOVERY_TOKEN",
    "flyctl proxy 13306:3306 private-ip",
    "mysql --execute SELECT",
    "node scripts/run-production-migrations.mjs",
  ])("denies automatic recovery database capability %s", (capability) => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      '          rollback_image="$(cat "$RUNNER_TEMP/leaderbot-recovery/rollback-image.txt")"',
      `          ${capability}\n          rollback_image="$(cat "$RUNNER_TEMP/leaderbot-recovery/rollback-image.txt")"`,
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "automatic no-review recovery must have no SQL, database URL, tunnel, content-read, or database-volume capability",
    );
  });

  it("rejects every caller-provided recovery capability", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      "      target:\n        required: true\n        type: string\n  workflow_dispatch:\n",
      "      target:\n        required: true\n        type: string\n    secrets:\n      CUSTOM_SUPPORT_TOKEN:\n        required: false\n  workflow_dispatch:\n",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must accept no caller secrets and may reference only the four exact environment-scoped",
    );
  });

  it("rejects dynamic recovery-secret lookups that bypass the exact allowlist", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      "${{ secrets.FLY_GATEWAY_RECOVERY_TOKEN }}",
      "${{ secrets['FLY_GATEWAY_RECOVERY_TOKEN'] }}",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must accept no caller secrets and may reference only the four exact environment-scoped",
    );
  });

  it("does not use wall-clock guesses to decide whether recovery may overwrite", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/reconcile-production-deployment.yml",
      '          source_sha="$(jq -er \'.head_sha\' <<<"$run")"',
      '          source_sha="$(jq -er \'.head_sha\' <<<"$run")"\n          RUN_COMPLETED_AT="$GITHUB_RUN_STARTED_AT"',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must keep all three recovery jobs independent, exact-source, and least-privileged",
    );
  });

  it("uses only the explicit test bootstrap for MySQL integration CI", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(root, ".github/workflows/image-gen-ci.yml");
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        "pnpm run db:migrate:test-bootstrap",
        "pnpm run db:migrate",
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "image-gen CI must enforce the staged schema artifact contract",
    );
  });

  it("requires server lint in image-gen CI", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/image-gen-ci.yml",
      "          pnpm run lint:server\n",
      "",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "image-gen CI must enforce the staged schema artifact contract",
    );
  });

  it("proves the image-gen runtime contains the bounded timeout command", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/image-gen-ci.yml",
      'docker run --rm "$image" timeout -k 1s 1s true',
      'docker run --rm "$image" true',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "image-gen CI must enforce the staged schema artifact contract",
    );
  });

  it("proves bounded timeout availability for both trusted artifact kinds", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/build-production-artifacts.yml",
      'docker run --rm "$ARTIFACT_IMAGE" timeout -k 1s 1s true',
      'docker run --rm "$ARTIFACT_IMAGE" true',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must prove bounded timeout availability for both image-gen artifact kinds",
    );
  });

  it("pins every CI MySQL service to the exact reviewed patch digest", () => {
    for (const [workflowPath, expectedError] of [
      [
        ".github/workflows/image-gen-ci.yml",
        "image-gen CI must use the exact reviewed MySQL service digest",
      ],
      [
        ".github/workflows/image-gen-migration-smoke.yml",
        "image-gen CI must use the exact reviewed MySQL service digest",
      ],
      [
        ".github/workflows/build-production-artifacts.yml",
        "must use the exact reviewed MySQL service digest",
      ],
    ]) {
      const root = createRepositoryFixture();
      replaceFixtureText(
        root,
        workflowPath,
        "image: mysql:8.4.11@sha256:1d6b6a8fcee8ff758ff151d017f5203cd06792a0e698f0a593c9dfcb14609cf0",
        "image: mysql:8.4",
      );

      expect(() => validateProductionRepository(root)).toThrow(expectedError);
    }
  });

  it.each([
    [".github/workflows/main.yml", "redis:7-alpine"],
    [
      ".github/workflows/image-gen-ci.yml",
      `redis:7-alpine@sha256:${"0".repeat(64)}`,
    ],
  ])(
    "pins the Redis service in %s to the shared reviewed digest",
    (workflowPath, replacement) => {
      const root = createRepositoryFixture();
      replaceFixtureText(
        root,
        workflowPath,
        "redis:7-alpine@sha256:ff02b58f971e7d7d156a1267e283fcbbeee91773b6aa36c49dac28ecfe28eadf",
        replacement,
      );

      expect(() => validateProductionRepository(root)).toThrow(
        "must use the same exact reviewed immutable Redis service digest",
      );
    },
  );

  it("forbids direct GitHub expressions inside image CI run blocks", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/image-gen-ci.yml",
      "          pnpm run lint:server\n",
      '          pnpm run lint:server "${{ github.sha }}"\n',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must pass GitHub expressions through step env",
    );
  });

  it("verifies production artifacts with DML-only fixture users", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/build-production-artifacts.yml",
      "DATABASE_URL=mysql://runtime_expand:runtime_expand@127.0.0.1:3306/leaderbot_artifact_expand",
      "DATABASE_URL=mysql://root:root@127.0.0.1:3306/leaderbot_artifact_expand",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must verify the runtime with DML-only fixture credentials",
    );
  });

  it("limits artifact fixture users to runtime DML grants", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/build-production-artifacts.yml",
      "GRANT SELECT, INSERT, UPDATE, DELETE ON leaderbot_artifact_expand.*",
      "GRANT ALL PRIVILEGES ON leaderbot_artifact_expand.*",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must give the expand-schema verification principal only runtime DML grants",
    );
  });

  it("rejects an extra privileged grant beside the DML fixture grants", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/build-production-artifacts.yml",
      "GRANT SELECT, INSERT, UPDATE, DELETE ON leaderbot_artifact_expand.* TO 'runtime_expand'@'%'",
      "GRANT SELECT, INSERT, UPDATE, DELETE ON leaderbot_artifact_expand.* TO 'runtime_expand'@'%'; GRANT CREATE ON leaderbot_artifact_expand.* TO 'runtime_expand'@'%'",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "fixture principals must have only their exact runtime DML grants",
    );
  });

  it("forbids an implicit production migration apply default", () => {
    const root = createRepositoryFixture();
    const runnerPath = path.join(
      root,
      "apps/image-gen/scripts/run-production-migrations.mjs",
    );
    const runner = fs.readFileSync(runnerPath, "utf8");
    fs.writeFileSync(
      runnerPath,
      runner.replace(
        "const migrationMode = configuredMode;",
        'const migrationMode = configuredMode || "apply";',
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must require one explicit staged mode",
    );
  });

  it("records one exact schema range for every reviewed image-gen artifact", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "deploy/production/apps.json"),
        "utf8",
      ),
    );
    const image = manifest.apps["image-gen"].reviewedImage;

    expect(
      getReviewedArtifactSchemaSupport("image-gen", image, repoRoot),
    ).toEqual({
      minimum: "0015_base",
      maximum: "0016_expand",
      phases: ["0015_base", "0016_expand"],
    });
  });

  it("rejects an image-gen artifact that cannot run on the declared database phase", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.apps["image-gen"].reviewedImageSchemaPhases = ["0016_expand"];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => validateProductionRepository(root)).toThrow(
      "image-gen image does not support database phase 0015_base",
    );
  });

  it("rejects a non-contiguous image-gen schema range", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.apps["image-gen"].reviewedImageSchemaPhases = [
      "0015_base",
      "0017_contract",
    ];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => validateProductionRepository(root)).toThrow(
      "image-gen image schema phases must be one ordered contiguous range",
    );
  });

  it("requires every image-gen rollback to have schema compatibility metadata", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.apps["image-gen"].reviewedRollbackImageSchemaPhases = {};
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => validateProductionRepository(root)).toThrow(
      "schema compatibility must cover exactly every reviewed rollback image",
    );
  });

  it("keeps the 0017 contract schema blocked in production", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const imageGen = manifest.apps["image-gen"];
    imageGen.databaseSchemaPhase = "0017_contract";
    imageGen.reviewedImageSchemaPhases = [
      "0015_base",
      "0016_expand",
      "0017_contract",
    ];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => validateProductionRepository(root)).toThrow(
      "image-gen 0017 contract is production-blocked",
    );
  });

  it("pins the recovery database name and isolated probe size", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.apps["image-gen"].databaseRecovery.databaseName = "mysql";
    manifest.apps["image-gen"].databaseRecovery.probeVmMemoryMb = 256;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => validateProductionRepository(root)).toThrow(
      "must pin its encrypted MySQL snapshot/restore contract",
    );
  });

  it("rejects the retired self-attested contract gate", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.apps["image-gen"].contractWriterSourceCommit = "a".repeat(40);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => validateProductionRepository(root)).toThrow(
      "must not expose the retired self-attested contract gate",
    );
  });

  it("forbids direct production schema-apply package scripts", () => {
    const root = createRepositoryFixture();
    const packagePath = path.join(root, "apps/image-gen/package.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    packageJson.scripts["db:migrate:expand"] =
      "LEADERBOT_PRODUCTION_MIGRATION_MODE=apply-expand node scripts/run-production-migrations.mjs";
    fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

    expect(() => validateProductionRepository(root)).toThrow(
      "must not expose direct production schema-apply scripts",
    );
  });

  it("rejects the retired image-price setting in production", () => {
    const root = createRepositoryFixture();
    const configPath = path.join(root, "apps/image-gen/fly.toml");
    const config = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(
      configPath,
      config.replace(
        'OPENAI_IMAGE_MAX_RETRIES = "0"',
        'OPENAI_IMAGE_MAX_RETRIES = "0"\nOPENAI_IMAGE_ESTIMATED_COST_USD = "1"',
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must not configure retired image setting OPENAI_IMAGE_ESTIMATED_COST_USD",
    );
  });

  it("requires a bounded graceful image-worker shutdown window", () => {
    const root = createRepositoryFixture();
    const configPath = path.join(root, "apps/image-gen/fly.toml");
    const config = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(
      configPath,
      config.replace("kill_timeout = 300", "kill_timeout = 5"),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must give image workers a 300s graceful SIGTERM drain",
    );
  });

  it("keeps the bridge release on v1 writes", () => {
    const root = createRepositoryFixture();
    const configPath = path.join(root, "apps/image-gen/fly.toml");
    const config = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(
      configPath,
      config.replace(
        'MESSENGER_GENERATION_QUEUE_WRITE_VERSION = "v1"',
        'MESSENGER_GENERATION_QUEUE_WRITE_VERSION = "v2"',
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must set MESSENGER_GENERATION_QUEUE_WRITE_VERSION=v1",
    );
  });

  it("blocks v2 writes while any reviewed rollback image is v1-only", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const { app: imageGen, bridgeImage } = stageImageGenBridge(manifest);
    imageGen.generationQueueWriteVersion = "v2";
    imageGen.generationQueueV2ReaderImages = [bridgeImage];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const configPath = path.join(root, "apps/image-gen/fly.toml");
    const config = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(
      configPath,
      config.replace(
        'MESSENGER_GENERATION_QUEUE_WRITE_VERSION = "v1"',
        'MESSENGER_GENERATION_QUEUE_WRITE_VERSION = "v2"',
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "cannot write v2 while a reviewed rollback image lacks the v2 queue reader",
    );
  });

  it("allows v2 only when every deploy and rollback image can read it", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const {
      app: imageGen,
      bridgeImage,
      legacyImage,
    } = stageImageGenBridge(manifest);
    imageGen.generationQueueWriteVersion = "v2";
    imageGen.generationQueueV2ReaderImages = [bridgeImage, legacyImage];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const configPath = path.join(root, "apps/image-gen/fly.toml");
    const config = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(
      configPath,
      config.replace(
        'MESSENGER_GENERATION_QUEUE_WRITE_VERSION = "v1"',
        'MESSENGER_GENERATION_QUEUE_WRITE_VERSION = "v2"',
      ),
    );

    expect(validateProductionRepository(root)).toEqual({
      apps: 3,
      callbacks: 2,
    });
  });

  it("rejects duplicate deploy entry points", () => {
    const root = createRepositoryFixture();
    const packagePath = path.join(root, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    packageJson.scripts["gateway:deploy"] = "fly deploy";
    fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

    expect(() => validateProductionRepository(root)).toThrow(
      "Remove duplicate or multi-app deploy script",
    );
  });

  it("requires liveness routing", () => {
    const root = createRepositoryFixture();
    const configPath = path.join(root, "apps/image-gen/fly.toml");
    const config = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(
      configPath,
      config.replace('path = "/healthz"', 'path = "/readyz"'),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must define a /healthz service check",
    );
  });

  it("requires image-gen traffic readiness routing", () => {
    const root = createRepositoryFixture();
    const configPath = path.join(root, "apps/image-gen/fly.toml");
    const config = fs.readFileSync(configPath, "utf8");
    fs.writeFileSync(
      configPath,
      config.replace('path = "/readyz"', 'path = "/healthz"'),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must define exactly the canonical /healthz and /readyz service checks",
    );
  });

  it("rejects an extra image-gen service check", () => {
    const root = createRepositoryFixture();
    const configPath = path.join(root, "apps/image-gen/fly.toml");
    fs.appendFileSync(
      configPath,
      [
        "",
        "[[http_service.checks]]",
        'interval = "15s"',
        'timeout = "5s"',
        'grace_period = "45s"',
        'method = "GET"',
        'path = "/extra"',
        "",
      ].join("\n"),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must define exactly the canonical /healthz and /readyz service checks",
    );
  });

  it("requires separate external readiness monitoring", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/production-uptime.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(workflowPath, workflow.replaceAll("/readyz", "/healthz"));

    expect(() => validateProductionRepository(root)).toThrow(
      "must monitor /readyz",
    );
  });

  it("rejects production workflows that can create detached Machines", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/deploy-production.yml",
    );
    fs.appendFileSync(workflowPath, "\n# fly machine run unsafe-image\n");

    expect(() => validateProductionRepository(root)).toThrow(
      "must not create detached Machines",
    );
  });

  it("requires an immutable reviewed image while source deploys are blocked", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    delete manifest.apps["image-gen"].reviewedImage;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => validateProductionRepository(root)).toThrow(
      "must pin its reviewed immutable production image",
    );
  });

  it("accepts only explicitly reviewed image-gen rollback digests", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "deploy/production/apps.json"),
        "utf8",
      ),
    );

    expect(
      validateReviewedRollbackImage(
        "image-gen",
        manifest.apps["image-gen"].reviewedRollbackImages[0],
        repoRoot,
      ),
    ).toBe(
      manifest.apps["image-gen"].reviewedRollbackImages[0],
    );

    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const reviewedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const { bridgeImage, legacyImage, sourceCommit } =
      stageImageGenBridge(reviewedManifest);
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify(reviewedManifest, null, 2)}\n`,
    );
    expect(validateReviewedRollbackImage("image-gen", legacyImage, root)).toBe(
      legacyImage,
    );
    expect(
      getReviewedArtifactSourceCommit("image-gen", bridgeImage, root),
    ).toBe(sourceCommit);
    expect(() =>
      validateReviewedRollbackImage(
        "image-gen",
        "registry.fly.io/leaderbot-fb-image-gen@sha256:0bdf169a494b57085ac51537aca7db03e9890cbadd46d7604933fde7df946b91",
        repoRoot,
      ),
    ).toThrow("not in the reviewed production allowlist");
  });

  it("resolves only the hash-reviewed rollback config for an allowlisted image", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "deploy/production/apps.json"),
        "utf8",
      ),
    );
    const app = manifest.apps["image-gen"];
    const image = app.reviewedRollbackImages[0];

    expect(getReviewedRollbackConfig("image-gen", image, repoRoot)).toBe(
      app.reviewedRollbackConfigs[image].path,
    );
  });

  it("rejects a rollback config whose bytes no longer match review", () => {
    const root = createRepositoryFixture();
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "deploy/production/apps.json"), "utf8"),
    );
    const app = manifest.apps["storage-proxy"];
    const image = app.reviewedRollbackImages[0];
    const configPath = path.join(root, app.reviewedRollbackConfigs[image].path);
    fs.appendFileSync(configPath, "\n# unreviewed drift\n");

    expect(() =>
      getReviewedRollbackConfig("storage-proxy", image, root),
    ).toThrow("reviewed rollback config hash does not match the manifest");
  });

  it("rejects rollback config paths outside the reviewed config directory", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const app = manifest.apps["image-gen"];
    const image = app.reviewedRollbackImages[0];
    app.reviewedRollbackConfigs[image].path = "../unreviewed.toml";
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => getReviewedRollbackConfig("image-gen", image, root)).toThrow(
      "has an unsafe reviewed rollback config record",
    );
  });

  it("requires rollback configs to cover exactly the image allowlist", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const app = manifest.apps["image-gen"];
    delete app.reviewedRollbackConfigs[app.reviewedRollbackImages[0]];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => validateProductionRepository(root)).toThrow(
      "reviewed rollback configs must cover exactly every allowlisted rollback image",
    );
  });

  it("requires every exact-source main CI workflow to be green", async () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const reviewedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const sourceCommit = "c".repeat(40);
    const { bridgeImage: reviewedImage } = stageImageGenBridge(
      reviewedManifest,
      sourceCommit,
    );
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify(reviewedManifest, null, 2)}\n`,
    );

    const requestedWorkflows = [];
    const fetchImpl = async (url) => {
      const parsed = new URL(url);
      const workflow = decodeURIComponent(
        parsed.pathname.split("/workflows/")[1].split("/runs")[0],
      );
      requestedWorkflows.push(workflow);
      expect(parsed.searchParams.get("head_sha")).toBe(sourceCommit);
      expect(parsed.searchParams.get("event")).toBe("push");
      expect(parsed.searchParams.get("status")).toBe("success");
      return {
        ok: true,
        async json() {
          return {
            workflow_runs: [
              {
                head_sha: sourceCommit,
                head_branch: "main",
                event: "push",
                status: "completed",
                conclusion: "success",
                path: `.github/workflows/${workflow}`,
              },
            ],
          };
        },
      };
    };

    await expect(
      verifyReviewedArtifactCi("image-gen", reviewedImage, {
        fetchImpl,
        repository: "owner/repo",
        token: "test-token",
        rootDir: root,
      }),
    ).resolves.toEqual({
      sourceCommit,
      workflows: [
        "main.yml",
        "image-gen-ci.yml",
        "image-gen-migration-smoke.yml",
      ],
    });
    expect(requestedWorkflows.sort()).toEqual([
      "image-gen-ci.yml",
      "image-gen-migration-smoke.yml",
      "main.yml",
    ]);
  });

  it("fails closed when an exact-source CI workflow is missing", async () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const reviewedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const sourceCommit = "d".repeat(40);
    const { bridgeImage: reviewedImage } = stageImageGenBridge(
      reviewedManifest,
      sourceCommit,
    );
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify(reviewedManifest, null, 2)}\n`,
    );

    await expect(
      verifyReviewedArtifactCi("image-gen", reviewedImage, {
        fetchImpl: async () => ({
          ok: true,
          async json() {
            return { workflow_runs: [] };
          },
        }),
        repository: "owner/repo",
        token: "test-token",
        rootDir: root,
      }),
    ).rejects.toThrow("has no successful main push run");
  });

  it("accepts only the exact GitHub workflow path for source CI", async () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const reviewedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const sourceCommit = "e".repeat(40);
    const { bridgeImage } = stageImageGenBridge(reviewedManifest, sourceCommit);
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify(reviewedManifest, null, 2)}\n`,
    );

    await expect(
      verifyReviewedArtifactCi("image-gen", bridgeImage, {
        fetchImpl: async (url) => {
          const workflow = decodeURIComponent(
            new URL(url).pathname.split("/workflows/")[1].split("/runs")[0],
          );
          return {
            ok: true,
            async json() {
              return {
                workflow_runs: [
                  {
                    head_sha: sourceCommit,
                    head_branch: "main",
                    event: "push",
                    status: "completed",
                    conclusion: "success",
                    path: `.github/workflows/${workflow}@main`,
                  },
                ],
              };
            },
          };
        },
        repository: "owner/repo",
        token: "test-token",
        rootDir: root,
      }),
    ).rejects.toThrow("has no successful main push run");
  });

  it("accepts only the exact reviewed storage-proxy deploy image", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "deploy/production/apps.json"),
        "utf8",
      ),
    );
    const reviewedImage = manifest.apps["storage-proxy"].reviewedImage;

    expect(() =>
      validateReviewedImage("storage-proxy", reviewedImage, repoRoot),
    ).toThrow("legacy bootstrap image has no trusted build attestation");

    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const reviewedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const { runtimeImage } = stageStorageProxyRuntime(reviewedManifest);
    fs.writeFileSync(
      manifestPath,
      `${JSON.stringify(reviewedManifest, null, 2)}\n`,
    );
    expect(validateReviewedImage("storage-proxy", runtimeImage, root)).toBe(
      runtimeImage,
    );
    expect(() =>
      validateReviewedImage(
        "storage-proxy",
        "registry.fly.io/leaderbot-storage-proxy@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        repoRoot,
      ),
    ).toThrow("must exactly match the reviewed manifest digest");
  });

  it("requires storage-proxy to retain a reviewed rollback digest", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.apps["storage-proxy"].reviewedRollbackImages = [];
    manifest.apps["storage-proxy"].reviewedRollbackArtifactKinds = {};
    manifest.apps["storage-proxy"].reviewedRollbackConfigs = {};
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => validateProductionRepository(root)).toThrow(
      "storage-proxy must retain an independently reviewed rollback image",
    );
  });

  it("rejects an arbitrary gateway rollback digest", () => {
    expect(() =>
      validateReviewedRollbackImage(
        "gateway",
        "registry.fly.io/leaderbot-openclaw-gateway@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        repoRoot,
      ),
    ).toThrow("not in the reviewed production allowlist");
  });

  it("requires explicit rollback allowlists for every production app", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    delete manifest.apps.gateway.reviewedRollbackImages;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => validateProductionRepository(root)).toThrow(
      "gateway must define reviewedRollbackImages",
    );
  });

  it("blocks unreviewed targets and freezes image-gen during expand", () => {
    expect(() => validateDeploymentEnabled("gateway", repoRoot)).toThrow(
      "gateway production deployment is blocked",
    );
    expect(() => validateDeploymentEnabled("image-gen", repoRoot)).toThrow(
      "image-gen production deployment is blocked",
    );
    expect(() => validateDeploymentEnabled("storage-proxy", repoRoot)).toThrow(
      "storage-proxy production deployment is blocked",
    );
  });

  it("refuses to enable the stateful gateway even without a rollback digest", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.apps.gateway.deploymentEnabled = true;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => validateProductionRepository(root)).toThrow(
      "gateway must remain deployment-disabled",
    );
  });

  it("keeps the gateway blocked even when a rollback digest is present", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.apps.gateway.deploymentEnabled = true;
    manifest.apps.gateway.reviewedRollbackImages = [
      "registry.fly.io/leaderbot-openclaw-gateway@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => validateProductionRepository(root)).toThrow(
      "gateway must remain deployment-disabled",
    );
    expect(() => validateDeploymentEnabled("gateway", root)).toThrow(
      "gateway production deployment is blocked",
    );
  });

  it("requires an explicit allowed Meta field set", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    delete manifest.meta.page.allowedFields;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => validateProductionRepository(root)).toThrow(
      "page must define explicit allowed Meta fields",
    );
  });

  it("rejects mutable deployment tags even when they are allowlisted", () => {
    const root = createRepositoryFixture();
    const rollbackImage =
      "registry.fly.io/leaderbot-openclaw-gateway:deployment-01KZ4R0MFP41Y7AZNWK3V63991";
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.apps.gateway.reviewedRollbackImages = [rollbackImage];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => validateProductionRepository(root)).toThrow(
      "gateway has an invalid reviewed rollback image",
    );
  });

  it("resolves a Fly deployment tag to one immutable app digest", () => {
    expect(
      resolveImmutableReleaseImage(
        "gateway",
        "registry.fly.io/leaderbot-openclaw-gateway:deployment-reviewed",
        [
          {
            Registry: "registry.fly.io",
            Repository: "leaderbot-openclaw-gateway",
            Tag: "deployment-reviewed",
            Digest:
              "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          },
        ],
        repoRoot,
      ),
    ).toBe(
      "registry.fly.io/leaderbot-openclaw-gateway@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    );
  });

  it("fails closed when a release tag cannot be resolved uniquely", () => {
    expect(() =>
      resolveImmutableReleaseImage(
        "gateway",
        "registry.fly.io/leaderbot-openclaw-gateway:deployment-missing",
        [],
        repoRoot,
      ),
    ).toThrow("did not resolve to one immutable image");
  });

  it("requires an immutable image input for every production target", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/deploy-production.yml",
      "      rollback_image:\n        description: Exact reviewed immutable digest required for every production target\n        required: true\n        type: string",
      "      rollback_image:\n        description: Optional image\n        required: false\n        type: string",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must require one exact immutable image input for every production target",
    );
  });

  it("never skips gateway image validation for an empty input", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/deploy-production.yml",
      "        if: inputs.target == 'gateway'\n        env:\n          REVIEWED_IMAGE: ${{ inputs.rollback_image }}",
      "        if: inputs.target == 'gateway' && inputs.rollback_image != ''\n        env:\n          REVIEWED_IMAGE: ${{ inputs.rollback_image }}",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must reject an empty, mutable, or non-allowlisted gateway image before deploy",
    );
  });

  it("never lets the gateway deploy step fall back to a source build", () => {
    const root = createRepositoryFixture();
    const packagePath = path.join(root, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    packageJson.scripts["deploy:gateway"] = packageJson.scripts[
      "deploy:gateway"
    ].replace(' --image "$FLY_GATEWAY_REVIEWED_IMAGE"', "");
    fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

    expect(() => validateProductionRepository(root)).toThrow(
      "gateway deploy script must require the reviewed manifest image",
    );
  });

  it("requires the workflow to enforce the manifest image-gen digest", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/deploy-production.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        '--validate-reviewed-image image-gen "$REVIEWED_IMAGE"',
        '--accept-reviewed-image image-gen "$REVIEWED_IMAGE"',
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must enforce the reviewed image-gen digest",
    );
  });

  it("requires the workflow to enforce the manifest storage-proxy digest", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/deploy-production.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        '--validate-reviewed-image storage-proxy "$REVIEWED_IMAGE"',
        '--accept-reviewed-image storage-proxy "$REVIEWED_IMAGE"',
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must enforce the reviewed storage-proxy digest",
    );
  });

  it("requires a dedicated storage-proxy deployment credential", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/deploy-production.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replaceAll(
        "FLY_STORAGE_PROXY_DEPLOY_TOKEN",
        "FLY_IMAGE_GEN_DEPLOY_TOKEN",
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must use an app-scoped storage-proxy deploy token",
    );
  });

  it("requires storage-proxy rollback verification", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/deploy-production.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        '--verify-restored-release storage-proxy "$rollback_image" "$rollback_config"',
        '--record-restored-release storage-proxy "$rollback_image" "$rollback_config"',
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must verify the restored storage-proxy image and configuration",
    );
  });

  it("requires manual gateway rollback input to be allowlisted", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/deploy-production.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        "--validate-rollback-image gateway",
        "--accept-rollback-image gateway",
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must reject an empty, mutable, or non-allowlisted gateway image before deploy",
    );
  });

  it("requires the captured gateway rollback digest to be allowlisted", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/deploy-production.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        '--validate-rollback-image gateway "$rollback_image"',
        '--accept-rollback-image gateway "$rollback_image"',
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must validate gateway input, capture, and restore",
    );
  });

  it("requires bounded automatic rollback steps", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/deploy-production.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        "Restore captured gateway release",
        "Record failed gateway deployment",
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must include gateway rollback",
    );
  });

  it("reserves job time for every rollback step", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/deploy-production.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace("timeout-minutes: 15", "timeout-minutes: 30"),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must reserve bounded gateway and storage-proxy rollback steps",
    );
  });

  it("requires every rollback capture to fail closed on a missing release image", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/deploy-production.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace('release_image="$(jq -er', 'release_image="$(jq -r'),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must fail closed when any rollback release is missing",
    );
  });

  it("requires rollback to restore every captured Fly configuration", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(
      root,
      ".github/workflows/deploy-production.yml",
    );
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace('--config "$rollback_config"', "--config fly.toml"),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must validate and restore every captured configuration",
    );
  });

  it("never trusts a live Fly config as rollback input", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/deploy-production.yml",
      'rollback_config_path="$(node scripts/validate-production-deployment.mjs \\\n            --reviewed-rollback-config storage-proxy "$rollback_image")"',
      'fly config save --app leaderbot-storage-proxy --yes\n          rollback_config_path="fly.toml"',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must never trust a live Fly config as rollback input",
    );
  });

  it("never passes the unsupported config-show JSON flag to pinned flyctl", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/deploy-production.yml",
      "fly config show --app leaderbot-storage-proxy)",
      "fly config show --app leaderbot-storage-proxy --json)",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must use pinned flyctl config-show JSON output without unsupported --json",
    );
  });

  it("proves every settled predecessor after strict capture and before upload", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/deploy-production.yml",
      "--verify-settled-baseline storage-proxy",
      "--trust-settled-baseline storage-proxy",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must verify the captured storage-proxy predecessor before mutation",
    );
  });

  it("never replaces the captured predecessor with a synthetic rollback identity", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/deploy-production.yml",
      '--env "LEADERBOT_DEPLOYMENT_IDENTITY=$prior_identity"',
      '--env "LEADERBOT_DEPLOYMENT_IDENTITY=rollback-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must restore the captured identity for every target",
    );
  });

  it("runs readonly live preflight before Node setup and production approval", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/deploy-production.yml",
      "environment: production-inspection",
      "environment: production",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must run one metadata-only settled preflight in production-inspection",
    );
  });

  it("runs root contract CI on every pull request", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/main.yml",
      "  pull_request:\n",
      '  pull_request:\n    paths:\n      - "README.md"\n',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must run validate on every pull request and every main push without path filters",
    );
  });

  it("runs image-gen CI on every main push", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/image-gen-ci.yml",
      "  push:\n    branches: [main]\n",
      '  push:\n    branches: [main]\n    paths:\n      - "apps/image-gen/**"\n',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must run checks on every pull request and every main push without path filters",
    );
  });

  it("runs migration smoke on every pull request", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/image-gen-migration-smoke.yml",
      "  pull_request:\n",
      '  pull_request:\n    paths-ignore:\n      - "docs/**"\n',
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must run migrate on every pull request and every main push without path filters",
    );
  });

  it("pins third-party actions in exact-source root CI", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(root, ".github/workflows/main.yml");
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803 # v6",
        "actions/checkout@v6",
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must pin required source-CI actions",
    );
  });

  it("pins third-party actions in exact-source image CI", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(root, ".github/workflows/image-gen-ci.yml");
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4",
        "pnpm/action-setup@v4",
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "image-gen source CI must pin every third-party action",
    );
  });

  it("requires the canonical image-gen script to carry the reviewed digest", () => {
    const root = createRepositoryFixture();
    const packagePath = path.join(root, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    packageJson.scripts["deploy:image-gen"] = packageJson.scripts[
      "deploy:image-gen"
    ].replace('--image "$FLY_IMAGE_GEN_REVIEWED_IMAGE"', "");
    fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

    expect(() => validateProductionRepository(root)).toThrow(
      "image-gen deploy script must require the reviewed manifest image",
    );
  });

  it("requires the protected deploy to constrain first-bootstrap drift", () => {
    const root = createRepositoryFixture();
    replaceFixtureText(
      root,
      ".github/workflows/deploy-production.yml",
      "--allow-first-trusted-bootstrap-drift",
      "--allow-unreviewed-bootstrap-drift",
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must narrowly reconcile the exact legacy image-gen predecessor",
    );
  });

  it("requires the canonical storage-proxy script to carry an allowlisted digest", () => {
    const root = createRepositoryFixture();
    const packagePath = path.join(root, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    packageJson.scripts["deploy:storage-proxy"] = packageJson.scripts[
      "deploy:storage-proxy"
    ].replace(
      '--validate-rollback-image storage-proxy "$FLY_STORAGE_PROXY_REVIEWED_IMAGE"',
      "true",
    );
    fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

    expect(() => validateProductionRepository(root)).toThrow(
      "storage-proxy deploy script must require the reviewed manifest image",
    );
  });

  it("requires direct deploy scripts to enforce the manifest gate", () => {
    const root = createRepositoryFixture();
    const packagePath = path.join(root, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    packageJson.scripts["deploy:gateway"] = packageJson.scripts[
      "deploy:gateway"
    ].replace(
      "node scripts/validate-production-deployment.mjs --validate-target-enabled gateway && ",
      "",
    );
    fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

    expect(() => validateProductionRepository(root)).toThrow(
      "gateway deploy script must enforce the manifest deployment gate",
    );
  });

  it("binds operator drift scripts to the settled live identity", () => {
    const root = createRepositoryFixture();
    const packagePath = path.join(root, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    packageJson.scripts["production:drift:image-gen"] =
      "node scripts/validate-production-deployment.mjs --live image-gen";
    fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

    expect(() => validateProductionRepository(root)).toThrow(
      "production:drift:image-gen must verify drift against the settled live identity",
    );
  });

  it("blocks detached Machines before deployment", () => {
    const result = checkLiveFlyDrift("gateway", {
      rootDir: repoRoot,
      runFly(args) {
        const command = args.slice(0, 2).join(" ");
        if (command === "config show") {
          return JSON.stringify({
            app: "leaderbot-openclaw-gateway",
            env: {},
            processes: {},
            http_service: {
              processes: ["app"],
              checks: [{ path: "/healthz" }],
            },
          });
        }
        if (command === "machine list") {
          return JSON.stringify([
            {
              id: "detached-test-machine",
              state: "started",
              config: { metadata: { fly_process_group: "app" } },
            },
          ]);
        }
        if (command === "scale show") {
          return JSON.stringify([
            {
              Process: "app",
              Count: 1,
              CPUKind: "shared",
              CPUs: 4,
              Memory: 4096,
            },
          ]);
        }
        throw new Error(`Unexpected fly command: ${args.join(" ")}`);
      },
    });

    expect(result.blockingErrors).toContain(
      "detached Machine detected: detached-test-machine",
    );
  });

  it("fails closed when the live gateway volume mount drifts", () => {
    const result = checkLiveFlyDrift("gateway", {
      rootDir: repoRoot,
      runFly(args) {
        const command = args.slice(0, 2).join(" ");
        if (command === "config show") {
          return JSON.stringify({
            app: "leaderbot-openclaw-gateway",
            env: {},
            processes: {},
            mounts: [{ source: "wrong_volume", destination: "/data" }],
            http_service: {
              processes: ["app"],
              checks: [{ path: "/healthz" }],
            },
          });
        }
        if (command === "machine list") {
          return JSON.stringify([
            {
              id: "managed-gateway-machine",
              state: "started",
              config: {
                guest: { cpu_kind: "shared", cpus: 4, memory_mb: 4096 },
                metadata: {
                  fly_platform_version: "v2",
                  fly_process_group: "app",
                },
              },
            },
          ]);
        }
        if (command === "scale show") {
          return JSON.stringify([
            {
              Process: "app",
              Count: 1,
              CPUKind: "shared",
              CPUs: 4,
              Memory: 4096,
            },
          ]);
        }
        throw new Error(`Unexpected fly command: ${args.join(" ")}`);
      },
    });

    expect(result.blockingErrors).toContain(
      "live volume mounts differ from the production fly.toml",
    );
  });

  it("fails strict drift when a desired Machine is stopped", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "deploy/production/apps.json"),
        "utf8",
      ),
    );
    const reviewedImage = manifest.apps["storage-proxy"].reviewedImage;
    const canonical = storageProxyFlyState(reviewedImage);
    const result = checkLiveFlyDrift("storage-proxy", {
      rootDir: repoRoot,
      runFly(args) {
        if (args.slice(0, 2).join(" ") !== "machine list")
          return canonical(args);
        const machines = JSON.parse(canonical(args));
        machines[0].state = "stopped";
        return JSON.stringify(machines);
      },
    });

    expect(result.blockingErrors).toEqual(
      expect.arrayContaining([
        "Machine storage-proxy-machine in app is not started",
        "started Machines for app: expected 1, got 0",
      ]),
    );
  });

  it.each([
    [
      "auto-destroy",
      (machine) => {
        machine.config.auto_destroy = true;
      },
    ],
    [
      "restart",
      (machine) => {
        machine.config.restart = { policy: "always" };
      },
    ],
    [
      "schedule",
      (machine) => {
        machine.config.schedule = "hourly";
      },
    ],
    [
      "statics",
      (machine) => {
        machine.config.statics = [{ guest_path: "/tmp" }];
      },
    ],
    [
      "secrets",
      (machine) => {
        machine.config.secrets = { NODE_OPTIONS: "malicious" };
      },
    ],
    [
      "dns",
      (machine) => {
        machine.config.dns = { skip_registration: true };
      },
    ],
    [
      "checks",
      (machine) => {
        machine.config.checks = { hidden: {} };
      },
    ],
    [
      "standbys",
      (machine) => {
        machine.config.standbys = ["other-machine"];
      },
    ],
    [
      "rootfs",
      (machine) => {
        machine.config.rootfs = { size_gb: 100 };
      },
    ],
    [
      "unknown",
      (machine) => {
        machine.config.unreviewed = true;
      },
    ],
    [
      "guest override",
      (machine) => {
        machine.config.guest.gpu_kind = "a100";
      },
    ],
    [
      "region",
      (machine) => {
        machine.region = "iad";
      },
    ],
  ])("blocks %s Machine configuration drift", (_label, mutate) => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "deploy/production/apps.json"),
        "utf8",
      ),
    );
    const reviewedImage = manifest.apps["storage-proxy"].reviewedImage;
    const canonical = storageProxyFlyState(reviewedImage);
    const result = checkLiveFlyDrift("storage-proxy", {
      rootDir: repoRoot,
      runFly(args) {
        if (args.slice(0, 2).join(" ") !== "machine list")
          return canonical(args);
        const machines = JSON.parse(canonical(args));
        mutate(machines[0]);
        return JSON.stringify(machines);
      },
    });

    expect(result.blockingErrors.length).toBeGreaterThan(0);
  });

  it.each([
    [
      "init",
      (machine) => {
        machine.config.init.cmd = ["node", "unreviewed.cjs"];
      },
      "init command",
    ],
    [
      "environment",
      (machine) => {
        machine.config.env.NODE_OPTIONS = "--require=/tmp/x";
      },
      "environment differs",
    ],
    [
      "mount",
      (machine) => {
        machine.config.mounts = [{ volume: "other", path: "/data" }];
      },
      "mounts differ",
    ],
    [
      "service",
      (machine) => {
        machine.config.services[0].internal_port = 9999;
      },
      "services differ",
    ],
  ])("blocks exact per-Machine %s drift", (_label, mutate, expected) => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "deploy/production/apps.json"),
        "utf8",
      ),
    );
    const reviewedImage = manifest.apps["storage-proxy"].reviewedImage;
    const canonical = storageProxyFlyState(reviewedImage);
    const result = checkLiveFlyDrift("storage-proxy", {
      rootDir: repoRoot,
      runFly(args) {
        if (args.slice(0, 2).join(" ") !== "machine list")
          return canonical(args);
        const machines = JSON.parse(canonical(args));
        mutate(machines[0]);
        return JSON.stringify(machines);
      },
    });

    expect(result.blockingErrors).toEqual(
      expect.arrayContaining([expect.stringContaining(expected)]),
    );
  });

  it("accepts pinned-flyctl Machine defaults, immutable image_ref, API nanoseconds, and reordered services", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "deploy/production/apps.json"),
        "utf8",
      ),
    );
    const reviewedImage = manifest.apps["storage-proxy"].reviewedImage;
    const canonical = storageProxyFlyState(reviewedImage);
    const result = checkLiveFlyDrift("storage-proxy", {
      rootDir: repoRoot,
      runFly(args) {
        if (args.slice(0, 2).join(" ") !== "machine list")
          return canonical(args);
        const machines = JSON.parse(canonical(args));
        const machine = machines[0];
        machine.config.image =
          "registry.fly.io/leaderbot-storage-proxy:deployment-200";
        machine.config.auto_destroy = false;
        machine.config.dns = {};
        machine.config.restart = { policy: "on-failure", max_retries: 10 };
        machine.config.services[0].ports.reverse();
        machine.config.services[0].ports[0].handlers.reverse();
        machine.config.services[0].checks[0].interval = 15_000_000_000;
        machine.config.services[0].checks[0].timeout = 5_000_000_000;
        machine.config.services[0].checks[0].grace_period = 60_000_000_000;
        return JSON.stringify(machines);
      },
    });

    for (const unexpected of ["image", "restart", "DNS", "services differ"]) {
      expect(result.blockingErrors).not.toEqual(
        expect.arrayContaining([expect.stringContaining(unexpected)]),
      );
    }
  });

  it("rejects invalid Machine service-check nanosecond values", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "deploy/production/apps.json"),
        "utf8",
      ),
    );
    const reviewedImage = manifest.apps["storage-proxy"].reviewedImage;
    const canonical = storageProxyFlyState(reviewedImage);
    for (const invalid of [15.5, Number.MAX_SAFE_INTEGER]) {
      const result = checkLiveFlyDrift("storage-proxy", {
        rootDir: repoRoot,
        runFly(args) {
          if (args.slice(0, 2).join(" ") !== "machine list")
            return canonical(args);
          const machines = JSON.parse(canonical(args));
          machines[0].config.services[0].checks[0].interval = invalid;
          return JSON.stringify(machines);
        },
      });
      expect(result.blockingErrors).toEqual(
        expect.arrayContaining([expect.stringContaining("services differ")]),
      );
    }
  });

  it("treats Machine stop timeout numbers as API nanoseconds", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "deploy/production/apps.json"),
        "utf8",
      ),
    );
    const reviewedImage = manifest.apps["image-gen"].reviewedImage;
    const canonical = imageGenFlyState(reviewedImage);
    const inspect = (timeout) =>
      checkLiveFlyDrift("image-gen", {
        rootDir: repoRoot,
        runFly(args) {
          if (args.slice(0, 2).join(" ") !== "machine list")
            return canonical(args);
          const machines = JSON.parse(canonical(args));
          for (const machine of machines) {
            machine.config.stop_config = { signal: "SIGTERM", timeout };
          }
          return JSON.stringify(machines);
        },
      });

    expect(inspect(300_000_000_000).blockingErrors).not.toEqual(
      expect.arrayContaining([expect.stringContaining("stop configuration")]),
    );
    for (const invalid of [300.5, Number.MAX_SAFE_INTEGER]) {
      expect(inspect(invalid).blockingErrors).toEqual(
        expect.arrayContaining([expect.stringContaining("stop configuration")]),
      );
    }
  });

  it("rejects an immutable config.image that conflicts with image_ref", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "deploy/production/apps.json"),
        "utf8",
      ),
    );
    const reviewedImage = manifest.apps["storage-proxy"].reviewedImage;
    const canonical = storageProxyFlyState(reviewedImage);
    const result = checkLiveFlyDrift("storage-proxy", {
      rootDir: repoRoot,
      runFly(args) {
        if (args.slice(0, 2).join(" ") !== "machine list")
          return canonical(args);
        const machines = JSON.parse(canonical(args));
        machines[0].config.image = `registry.fly.io/leaderbot-storage-proxy@sha256:${"e".repeat(64)}`;
        return JSON.stringify(machines);
      },
    });

    expect(result.blockingErrors).toContain(
      "Machine storage-proxy-machine image_ref conflicts with config.image",
    );
  });

  it("fails strict drift when a Machine has a different deployment identity", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "deploy/production/apps.json"),
        "utf8",
      ),
    );
    const reviewedImage = manifest.apps["storage-proxy"].reviewedImage;
    const canonical = storageProxyFlyState(reviewedImage);
    const result = checkLiveFlyDrift("storage-proxy", {
      rootDir: repoRoot,
      expectedDeploymentIdentity: "deploy-123-2",
      runFly(args) {
        const command = args.slice(0, 2).join(" ");
        const value = JSON.parse(canonical(args));
        if (command === "config show") {
          value.env.LEADERBOT_DEPLOYMENT_IDENTITY = "deploy-123-2";
        } else if (command === "machine list") {
          value[0].config.env = {
            LEADERBOT_DEPLOYMENT_IDENTITY: "deploy-122-1",
          };
        }
        return JSON.stringify(value);
      },
    });

    expect(result.blockingErrors).toContain(
      "Machine storage-proxy-machine deployment identity is outside the exact recovery set",
    );
  });

  it("blocks an image-gen Machine that is not on the reviewed digest", () => {
    const unreviewedImage =
      "registry.fly.io/leaderbot-fb-image-gen@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const runFly = imageGenFlyState(unreviewedImage);

    const result = checkLiveFlyDrift("image-gen", {
      rootDir: repoRoot,
      runFly,
    });

    expect(result.blockingErrors).toContain(
      "Machine image-gen-machine image differs from the reviewed production digest",
    );

    const predeploy = checkLiveFlyDrift("image-gen", {
      rootDir: repoRoot,
      runFly,
      allowReviewedRollbackImage: true,
    });
    expect(predeploy.blockingErrors).toContain(
      "Machine image-gen-machine image is not an approved rollback image",
    );
  });

  it("accepts Fly-normalized image-gen duration values", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "deploy/production/apps.json"),
        "utf8",
      ),
    );
    const reviewedImage = manifest.apps["image-gen"].reviewedImage;
    const canonical = imageGenFlyState(reviewedImage);
    const result = checkLiveFlyDrift("image-gen", {
      rootDir: repoRoot,
      runFly(args) {
        if (args.slice(0, 2).join(" ") !== "config show") {
          return canonical(args);
        }
        const live = JSON.parse(canonical(args));
        live.primary_region = "ams";
        live.kill_signal = "SIGTERM";
        live.kill_timeout = "5m0s";
        live.build = { dockerfile: "Dockerfile" };
        live.deploy = {
          release_command:
            "timeout -k 30s 8m env LEADERBOT_PRODUCTION_MIGRATION_MODE=verify-artifact node dist/migrate-production.cjs",
          release_command_timeout: "10m0s",
        };
        return JSON.stringify(live);
      },
    });

    expect(result.reconcilableDrift).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("kill_timeout"),
        expect.stringContaining("release_command_timeout"),
      ]),
    );
  });

  it("accepts only canonical Fly-managed builder metadata", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "deploy/production/apps.json"),
        "utf8",
      ),
    );
    const reviewedImage = manifest.apps["image-gen"].reviewedImage;
    const canonical = imageGenFlyState(reviewedImage);
    const inspect = (builderId) =>
      checkLiveFlyDrift("image-gen", {
        rootDir: repoRoot,
        runFly(args) {
          if (args.slice(0, 2).join(" ") !== "machine list") {
            return canonical(args);
          }
          const machines = JSON.parse(canonical(args));
          for (const machine of machines) {
            machine.config.metadata.fly_builder_id = builderId;
          }
          return JSON.stringify(machines);
        },
      });

    expect(inspect("683e341b47e018").blockingErrors).not.toEqual(
      expect.arrayContaining([expect.stringContaining("builder metadata")]),
    );
    for (const invalid of [
      "not-a-builder",
      null,
      12345678901234,
      ["683e341b47e018"],
    ]) {
      expect(inspect(invalid).blockingErrors).toEqual(
        expect.arrayContaining([
          expect.stringContaining("invalid builder metadata"),
        ]),
      );
    }
  });

  it("allows only an approved previous image during predeploy drift", () => {
    const root = createRepositoryFixture();
    const previousImage =
      "registry.fly.io/leaderbot-fb-image-gen@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.apps["image-gen"].reviewedRollbackImages = [previousImage];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const predeploy = checkLiveFlyDrift("image-gen", {
      rootDir: root,
      runFly: imageGenFlyState(previousImage),
      allowReviewedRollbackImage: true,
    });
    expect(predeploy.blockingErrors).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("Machine image-gen-machine image"),
      ]),
    );
    expect(predeploy.reconcilableDrift).toContain(
      "Machine image-gen-machine uses an approved rollback image before deployment",
    );

    const postdeploy = checkLiveFlyDrift("image-gen", {
      rootDir: root,
      runFly: imageGenFlyState(previousImage),
    });
    expect(postdeploy.blockingErrors).toContain(
      "Machine image-gen-machine image differs from the reviewed production digest",
    );
  });

  it("blocks every non-image config drift during predeploy recovery", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const { legacyImage } = stageStorageProxyRuntime(manifest);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const canonical = storageProxyFlyState(legacyImage);

    const result = checkLiveFlyDrift("storage-proxy", {
      rootDir: root,
      allowReviewedRollbackImage: true,
      runFly(args) {
        if (args.slice(0, 2).join(" ") !== "config show") {
          return canonical(args);
        }
        const live = JSON.parse(canonical(args));
        live.primary_region = "iad";
        return JSON.stringify(live);
      },
    });

    expect(result.reconcilableDrift).toContain(
      "Machine storage-proxy-machine uses an approved rollback image before deployment",
    );
    expect(result.blockingErrors).toContain(
      'primary_region: expected "ams", got "iad"',
    );
  });

  it("verifies the exact captured storage-proxy rollback image and config", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "deploy/production/apps.json"),
        "utf8",
      ),
    );
    const reviewedImage = manifest.apps["storage-proxy"].reviewedImage;
    const configPath = "apps/image-gen/storage-proxy/fly.toml";

    const restored = checkLiveFlyDrift("storage-proxy", {
      rootDir: repoRoot,
      runFly: storageProxyFlyState(reviewedImage),
      expectedImage: reviewedImage,
      configPath,
    });
    expect(restored.blockingErrors).toEqual([]);
    expect(restored.reconcilableDrift).toEqual([]);

    const wrongImage =
      "registry.fly.io/leaderbot-storage-proxy@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const drifted = checkLiveFlyDrift("storage-proxy", {
      rootDir: repoRoot,
      runFly: storageProxyFlyState(wrongImage),
      expectedImage: reviewedImage,
      configPath,
    });
    expect(drifted.blockingErrors).toContain(
      "Machine storage-proxy-machine image differs from the captured rollback digest",
    );
  });

  it("blocks executable and security drift while reporting safe config drift", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "deploy/production/apps.json"),
        "utf8",
      ),
    );
    const reviewedImage = manifest.apps["storage-proxy"].reviewedImage;
    const canonical = storageProxyFlyState(reviewedImage);
    const result = checkLiveFlyDrift("storage-proxy", {
      rootDir: repoRoot,
      runFly(args) {
        if (args.slice(0, 2).join(" ") !== "config show") {
          return canonical(args);
        }
        const live = JSON.parse(canonical(args));
        live.primary_region = "iad";
        live.deploy.strategy = "immediate";
        live.deploy.release_command = "node unreviewed-release-command.cjs";
        live.http_service.internal_port = 9999;
        live.http_service.checks[0].timeout = "30s";
        return JSON.stringify(live);
      },
    });

    expect(result.reconcilableDrift).toEqual(
      expect.arrayContaining([
        expect.stringContaining("primary_region"),
        expect.stringContaining("http_service.checks[0].timeout"),
      ]),
    );
    expect(result.blockingErrors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("deploy.strategy"),
        expect.stringContaining("deploy.release_command"),
        expect.stringContaining("http_service.internal_port"),
      ]),
    );
  });

  it("blocks live process and environment drift even during predeploy", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "deploy/production/apps.json"),
        "utf8",
      ),
    );
    const reviewedImage = manifest.apps["storage-proxy"].reviewedImage;
    const canonical = storageProxyFlyState(reviewedImage);
    const result = checkLiveFlyDrift("storage-proxy", {
      rootDir: repoRoot,
      allowReviewedRollbackImage: true,
      runFly(args) {
        if (args.slice(0, 2).join(" ") !== "config show") {
          return canonical(args);
        }
        const live = JSON.parse(canonical(args));
        live.processes.app = "node unreviewed.cjs";
        live.env.UNREVIEWED_SECURITY_BYPASS = "true";
        return JSON.stringify(live);
      },
    });

    expect(result.blockingErrors).toEqual(
      expect.arrayContaining([
        "live process commands differ from the production fly.toml",
        "env.UNREVIEWED_SECURITY_BYPASS: live-only value",
      ]),
    );
  });

  it("binds live recovery to the exact interrupted deployment identity", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "deploy/production/apps.json"),
        "utf8",
      ),
    );
    const reviewedImage = manifest.apps["storage-proxy"].reviewedImage;
    const canonical = storageProxyFlyState(reviewedImage);
    const runFly = (args) => {
      const command = args.slice(0, 2).join(" ");
      if (command === "machine list") {
        const machines = JSON.parse(canonical(args));
        for (const machine of machines) {
          machine.config.env = {
            ...machine.config.env,
            LEADERBOT_DEPLOYMENT_IDENTITY: "deploy-123-2",
          };
        }
        return JSON.stringify(machines);
      }
      if (command !== "config show") {
        return canonical(args);
      }
      const live = JSON.parse(canonical(args));
      live.env.LEADERBOT_DEPLOYMENT_IDENTITY = "deploy-123-2";
      return JSON.stringify(live);
    };

    expect(
      checkLiveFlyDrift("storage-proxy", {
        rootDir: repoRoot,
        runFly,
        expectedDeploymentIdentity: "deploy-123-2",
      }).blockingErrors,
    ).toEqual([]);
    expect(
      checkLiveFlyDrift("storage-proxy", {
        rootDir: repoRoot,
        runFly,
        expectedDeploymentIdentity: "deploy-999-2",
      }).blockingErrors,
    ).toContain("deployment identity: expected deploy-999-2, got deploy-123-2");
  });

  it("rejects scale-count tolerance outside restored-release context", () => {
    expect(() =>
      checkLiveFlyDrift("storage-proxy", {
        rootDir: repoRoot,
        allowScaleCountDrift: true,
      }),
    ).toThrow(
      "scale count drift allowance requires restored-release verification context",
    );
  });

  it("rejects scale-count tolerance for a deploy identity", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, "deploy/production/apps.json"),
        "utf8",
      ),
    );
    const reviewedImage = manifest.apps["storage-proxy"].reviewedImage;
    expect(() =>
      checkLiveFlyDrift("storage-proxy", {
        rootDir: repoRoot,
        expectedImage: reviewedImage,
        configPath: "apps/image-gen/storage-proxy/fly.toml",
        expectedDeploymentIdentity: "deploy-123-2",
        capturedPriorImage: reviewedImage,
        allowReviewedMachineImages: true,
        allowScaleCountDrift: true,
      }),
    ).toThrow(
      "scale count drift allowance requires the exact captured prior identity",
    );
  });

  it("rejects scale-count tolerance with a non-reviewed config copy", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const { legacyImage } = stageStorageProxyRuntime(manifest);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() =>
      checkLiveFlyDrift("storage-proxy", {
        rootDir: root,
        expectedImage: legacyImage,
        configPath: "apps/image-gen/storage-proxy/fly.toml",
        expectedDeploymentIdentity: "deploy-123-2",
        capturedPriorIdentity: "deploy-123-2",
        capturedPriorImage: legacyImage,
        interruptedDeploymentIdentity: "deploy-124-1",
        allowReviewedMachineImages: true,
        allowScaleCountDrift: true,
      }),
    ).toThrow(
      "scale count drift allowance requires the reviewed rollback config",
    );
  });

  it("allows only process counts during exact partial-rollback recovery", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const { legacyImage } = stageStorageProxyRuntime(manifest);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const reviewedConfigPath =
      manifest.apps["storage-proxy"].reviewedRollbackConfigs[legacyImage].path;
    const result = checkLiveFlyDrift("storage-proxy", {
      rootDir: root,
      expectedImage: legacyImage,
      configPath: reviewedConfigPath,
      expectedDeploymentIdentity: "deploy-123-2",
      capturedPriorIdentity: "deploy-123-2",
      capturedPriorImage: legacyImage,
      interruptedDeploymentIdentity: "deploy-124-1",
      allowReviewedMachineImages: true,
      allowScaleCountDrift: true,
      runFly(args) {
        const command = args.slice(0, 2).join(" ");
        if (command === "config show") {
          return JSON.stringify({
            app: "leaderbot-storage-proxy",
            primary_region: "ams",
            deploy: { strategy: "rolling" },
            env: {
              LEADERBOT_DEPLOYMENT_IDENTITY: "deploy-123-2",
            },
            processes: {},
            http_service: {
              internal_port: 8787,
              force_https: true,
              auto_stop_machines: "stop",
              auto_start_machines: true,
              min_machines_running: 1,
              processes: ["app"],
              checks: [],
            },
          });
        }
        if (command === "machine list") {
          return JSON.stringify([
            {
              id: "storage-proxy-machine",
              state: "started",
              region: "ams",
              image_ref: immutableImageRef(legacyImage),
              config: {
                image: legacyImage,
                init: {},
                env: {
                  FLY_PROCESS_GROUP: "app",
                  PRIMARY_REGION: "ams",
                  LEADERBOT_DEPLOYMENT_IDENTITY: "deploy-123-2",
                },
                guest: { cpu_kind: "shared", cpus: 1, memory_mb: 256 },
                metadata: {
                  fly_platform_version: "v2",
                  fly_process_group: "app",
                },
                mounts: [],
                services: [
                  {
                    protocol: "tcp",
                    internal_port: 8787,
                    autostop: "stop",
                    autostart: true,
                    min_machines_running: 1,
                    ports: [
                      { port: 80, handlers: ["http"], force_https: true },
                      { port: 443, handlers: ["http", "tls"] },
                    ],
                    checks: [],
                  },
                ],
              },
            },
          ]);
        }
        if (command === "scale show") {
          return JSON.stringify([
            {
              Process: "app",
              Count: 2,
              CPUKind: "performance",
              CPUs: 1,
              Memory: 256,
            },
          ]);
        }
        throw new Error(`Unexpected fly command: ${args.join(" ")}`);
      },
    });

    expect(result.reconcilableDrift).toContain(
      "scale.app.count: expected 1, got 2",
    );
    expect(result.blockingErrors).toContain(
      'scale.app.cpuKind: expected "shared", got "performance"',
    );
  });

  it("allows a fully empty Machine and scale state only for exact interrupted recovery", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const { legacyImage, runtimeImage } = stageStorageProxyRuntime(manifest);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const canonical = storageProxyFlyState(runtimeImage);
    const result = checkLiveFlyDrift("storage-proxy", {
      rootDir: root,
      expectedDeploymentIdentity: "deploy-124-1",
      capturedPriorIdentity: "deploy-123-2",
      capturedPriorImage: legacyImage,
      allowReviewedRollbackImage: true,
      allowInterruptedScaleCountDrift: true,
      runFly(args) {
        const command = args.slice(0, 2).join(" ");
        if (command === "machine list" || command === "scale show") {
          return "[]";
        }
        const live = JSON.parse(canonical(args));
        live.env.LEADERBOT_DEPLOYMENT_IDENTITY = "deploy-124-1";
        return JSON.stringify(live);
      },
    });

    expect(result.blockingErrors).toEqual([]);
    expect(result.reconcilableDrift).toEqual(
      expect.arrayContaining([
        "started Machines for app: expected 1, got 0",
        "missing live scale for process group app",
      ]),
    );
  });

  it("rejects zero-resource recovery as soon as any unexpected Machine remains", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const { legacyImage, runtimeImage } = stageStorageProxyRuntime(manifest);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const canonical = storageProxyFlyState(runtimeImage);
    const result = checkLiveFlyDrift("storage-proxy", {
      rootDir: root,
      expectedDeploymentIdentity: "deploy-124-1",
      capturedPriorIdentity: "deploy-123-2",
      capturedPriorImage: legacyImage,
      allowReviewedRollbackImage: true,
      allowInterruptedScaleCountDrift: true,
      runFly(args) {
        const command = args.slice(0, 2).join(" ");
        if (command === "scale show") return "[]";
        if (command === "machine list") {
          const machines = JSON.parse(canonical(args));
          machines[0].config.metadata.fly_process_group = "malicious";
          return JSON.stringify(machines);
        }
        const live = JSON.parse(canonical(args));
        live.env.LEADERBOT_DEPLOYMENT_IDENTITY = "deploy-124-1";
        return JSON.stringify(live);
      },
    });

    expect(result.blockingErrors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("unexpected process group"),
        "missing live scale for process group app",
      ]),
    );
  });

  it("classifies image-gen rolling Machines by their complete prior or current release tuple", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const { bridgeImage, legacyImage } = stageImageGenBridge(manifest);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const runFly = (args) => {
      const command = args.slice(0, 2).join(" ");
      if (command === "config show") {
        return JSON.stringify(imageGenLiveConfig("deploy-124-1"));
      }
      if (command === "machine list") {
        const machines = [];
        for (const processGroup of ["app", "worker"]) {
          const priorConfig = imageGenRollbackMachineConfig(
            legacyImage,
            processGroup,
          );
          priorConfig.env.LEADERBOT_DEPLOYMENT_IDENTITY = "deploy-123-2";
          machines.push({
            id: `${processGroup}-prior`,
            state: processGroup === "app" ? "stopped" : "started",
            region: "ams",
            image_ref: immutableImageRef(legacyImage),
            config: priorConfig,
          });
          const currentConfig = imageGenMachineConfig(
            bridgeImage,
            processGroup,
          );
          currentConfig.env.LEADERBOT_DEPLOYMENT_IDENTITY = "deploy-124-1";
          machines.push({
            id: `${processGroup}-current`,
            state: "started",
            region: "ams",
            image_ref: immutableImageRef(bridgeImage),
            config: currentConfig,
          });
        }
        return JSON.stringify(machines);
      }
      if (command === "scale show") {
        return JSON.stringify([
          { Process: "app", Count: 2, CPUKind: "shared", CPUs: 1, Memory: 256 },
          {
            Process: "worker",
            Count: 2,
            CPUKind: "shared",
            CPUs: 1,
            Memory: 256,
          },
        ]);
      }
      throw new Error(`Unexpected fly command: ${args.join(" ")}`);
    };
    const partial = checkLiveFlyDrift("image-gen", {
      rootDir: root,
      runFly,
      expectedDeploymentIdentity: "deploy-124-1",
      capturedPriorIdentity: "deploy-123-2",
      capturedPriorImage: legacyImage,
      allowReviewedRollbackImage: true,
      allowInterruptedScaleCountDrift: true,
    });

    expect(partial.blockingErrors).toEqual([]);
    expect(partial.reconcilableDrift).toContain(
      "started Machines for app: expected 2, got 1",
    );
    const strict = checkLiveFlyDrift("image-gen", {
      rootDir: root,
      runFly,
      expectedDeploymentIdentity: "deploy-124-1",
    });
    expect(strict.blockingErrors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("deployment identity is outside"),
        expect.stringContaining("is not started"),
        expect.stringContaining("image differs"),
      ]),
    );
  });

  it("accepts complete prior and current image-gen tuples during a partial rollback", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const { bridgeImage, legacyImage } = stageImageGenBridge(manifest);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const rollbackConfig =
      manifest.apps["image-gen"].reviewedRollbackConfigs[legacyImage].path;
    const result = checkLiveFlyDrift("image-gen", {
      rootDir: root,
      expectedImage: legacyImage,
      configPath: rollbackConfig,
      expectedDeploymentIdentity: "deploy-123-2",
      capturedPriorIdentity: "deploy-123-2",
      capturedPriorImage: legacyImage,
      interruptedDeploymentIdentity: "deploy-124-1",
      allowReviewedMachineImages: true,
      allowScaleCountDrift: true,
      runFly(args) {
        const command = args.slice(0, 2).join(" ");
        if (command === "config show") {
          return JSON.stringify(
            imageGenLiveConfig("deploy-123-2", { rollback: true }),
          );
        }
        if (command === "machine list") {
          const machines = [];
          for (const processGroup of ["app", "worker"]) {
            const priorConfig = imageGenRollbackMachineConfig(
              legacyImage,
              processGroup,
            );
            priorConfig.env.LEADERBOT_DEPLOYMENT_IDENTITY = "deploy-123-2";
            machines.push({
              id: `${processGroup}-prior`,
              state: "started",
              region: "ams",
              image_ref: immutableImageRef(legacyImage),
              config: priorConfig,
            });
            const currentConfig = imageGenMachineConfig(
              bridgeImage,
              processGroup,
            );
            currentConfig.env.LEADERBOT_DEPLOYMENT_IDENTITY = "deploy-124-1";
            machines.push({
              id: `${processGroup}-current`,
              state: processGroup === "worker" ? "stopped" : "started",
              region: "ams",
              image_ref: immutableImageRef(bridgeImage),
              config: currentConfig,
            });
          }
          return JSON.stringify(machines);
        }
        if (command === "scale show") {
          return JSON.stringify([
            {
              Process: "app",
              Count: 2,
              CPUKind: "shared",
              CPUs: 1,
              Memory: 256,
            },
            {
              Process: "worker",
              Count: 2,
              CPUKind: "shared",
              CPUs: 1,
              Memory: 256,
            },
          ]);
        }
        throw new Error(`Unexpected fly command: ${args.join(" ")}`);
      },
    });

    expect(result.blockingErrors).toEqual([]);
    expect(result.reconcilableDrift).toContain(
      "started Machines for worker: expected 2, got 1",
    );
  });

  it("classifies storage rolling Machines by their complete prior or current release tuple", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const { legacyImage, runtimeImage } = stageStorageProxyRuntime(manifest);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const canonical = storageProxyFlyState(runtimeImage);
    const result = checkLiveFlyDrift("storage-proxy", {
      rootDir: root,
      expectedDeploymentIdentity: "deploy-124-1",
      capturedPriorIdentity: "deploy-123-2",
      capturedPriorImage: legacyImage,
      allowReviewedRollbackImage: true,
      allowInterruptedScaleCountDrift: true,
      runFly(args) {
        const command = args.slice(0, 2).join(" ");
        if (command === "config show") {
          const live = JSON.parse(canonical(args));
          live.env.LEADERBOT_DEPLOYMENT_IDENTITY = "deploy-124-1";
          return JSON.stringify(live);
        }
        if (command === "machine list") {
          const current = JSON.parse(canonical(args))[0];
          current.config.env.LEADERBOT_DEPLOYMENT_IDENTITY = "deploy-124-1";
          const prior = structuredClone(current);
          prior.id = "storage-proxy-prior";
          prior.image_ref = immutableImageRef(legacyImage);
          prior.config = storageProxyRollbackMachineConfig(legacyImage);
          prior.config.env.LEADERBOT_DEPLOYMENT_IDENTITY = "deploy-123-2";
          return JSON.stringify([current, prior]);
        }
        if (command === "scale show") {
          return JSON.stringify([
            {
              Process: "app",
              Count: 2,
              CPUKind: "shared",
              CPUs: 1,
              Memory: 256,
            },
          ]);
        }
        return canonical(args);
      },
    });

    expect(result.blockingErrors).toEqual([]);
    expect(result.reconcilableDrift).toEqual(
      expect.arrayContaining([
        "Machine storage-proxy-prior uses an approved rollback image before deployment",
        "scale.app.count: expected 1, got 2",
      ]),
    );
  });

  it("accepts the same two complete tuples during a partial rollback", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const { legacyImage, runtimeImage } = stageStorageProxyRuntime(manifest);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const rollbackConfig =
      manifest.apps["storage-proxy"].reviewedRollbackConfigs[legacyImage].path;
    const result = checkLiveFlyDrift("storage-proxy", {
      rootDir: root,
      expectedImage: legacyImage,
      configPath: rollbackConfig,
      expectedDeploymentIdentity: "deploy-123-2",
      capturedPriorIdentity: "deploy-123-2",
      capturedPriorImage: legacyImage,
      interruptedDeploymentIdentity: "deploy-124-1",
      allowReviewedMachineImages: true,
      allowScaleCountDrift: true,
      runFly(args) {
        const command = args.slice(0, 2).join(" ");
        if (command === "config show") {
          return JSON.stringify({
            app: "leaderbot-storage-proxy",
            primary_region: "ams",
            deploy: { strategy: "rolling" },
            env: {
              LEADERBOT_DEPLOYMENT_IDENTITY: "deploy-123-2",
            },
            processes: {},
            http_service: {
              internal_port: 8787,
              force_https: true,
              auto_stop_machines: "stop",
              auto_start_machines: true,
              min_machines_running: 1,
              processes: ["app"],
              checks: [],
            },
          });
        }
        if (command === "machine list") {
          const prior = {
            id: "storage-proxy-prior",
            state: "started",
            region: "ams",
            image_ref: immutableImageRef(legacyImage),
            config: storageProxyRollbackMachineConfig(legacyImage),
          };
          prior.config.env.LEADERBOT_DEPLOYMENT_IDENTITY = "deploy-123-2";
          const current = {
            id: "storage-proxy-current",
            state: "stopped",
            region: "ams",
            image_ref: immutableImageRef(runtimeImage),
            config: storageProxyMachineConfig(runtimeImage),
          };
          current.config.env.LEADERBOT_DEPLOYMENT_IDENTITY = "deploy-124-1";
          return JSON.stringify([prior, current]);
        }
        if (command === "scale show") {
          return JSON.stringify([
            {
              Process: "app",
              Count: 2,
              CPUKind: "shared",
              CPUs: 1,
              Memory: 256,
            },
          ]);
        }
        throw new Error(`Unexpected fly command: ${args.join(" ")}`);
      },
    });

    expect(result.blockingErrors).toEqual([]);
    expect(result.reconcilableDrift).toContain(
      "scale.app.count: expected 1, got 2",
    );
  });

  it.each([
    [
      "crossed identity",
      (machine) => {
        machine.config.env.LEADERBOT_DEPLOYMENT_IDENTITY = "deploy-124-1";
      },
    ],
    [
      "current environment",
      (machine) => {
        machine.config.env = {
          ...storageProxyMachineConfig(machine.config.image).env,
          LEADERBOT_DEPLOYMENT_IDENTITY: "deploy-123-2",
        };
      },
    ],
    [
      "current service",
      (machine) => {
        machine.config.services[0].checks = [
          {
            type: "http",
            interval: "15s",
            timeout: "5s",
            grace_period: "60s",
            method: "GET",
            path: "/healthz",
          },
        ];
      },
    ],
  ])("blocks a prior-image Machine with a %s", (_label, mutate) => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const { legacyImage, runtimeImage } = stageStorageProxyRuntime(manifest);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const canonical = storageProxyFlyState(runtimeImage);
    const result = checkLiveFlyDrift("storage-proxy", {
      rootDir: root,
      expectedDeploymentIdentity: "deploy-124-1",
      capturedPriorIdentity: "deploy-123-2",
      capturedPriorImage: legacyImage,
      allowReviewedRollbackImage: true,
      allowInterruptedScaleCountDrift: true,
      runFly(args) {
        const command = args.slice(0, 2).join(" ");
        if (command === "config show") {
          const live = JSON.parse(canonical(args));
          live.env.LEADERBOT_DEPLOYMENT_IDENTITY = "deploy-124-1";
          return JSON.stringify(live);
        }
        if (command === "machine list") {
          const prior = JSON.parse(canonical(args))[0];
          prior.image_ref = immutableImageRef(legacyImage);
          prior.config = storageProxyRollbackMachineConfig(legacyImage);
          prior.config.env.LEADERBOT_DEPLOYMENT_IDENTITY = "deploy-123-2";
          mutate(prior);
          return JSON.stringify([prior]);
        }
        return canonical(args);
      },
    });

    expect(result.blockingErrors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /exact prior\/current recovery tuple|environment differs|services differ/,
        ),
      ]),
    );
  });

  it("blocks a third historical digest during exact rolling recovery", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const { legacyImage } = stageImageGenBridge(manifest);
    const thirdImage = `registry.fly.io/leaderbot-fb-image-gen@sha256:${"e".repeat(64)}`;
    const app = manifest.apps["image-gen"];
    app.reviewedRollbackImages.push(thirdImage);
    app.reviewedRollbackConfigs[thirdImage] = structuredClone(
      app.reviewedRollbackConfigs[legacyImage],
    );
    app.reviewedRollbackArtifactKinds[thirdImage] = "migration-bridge";
    app.reviewedRollbackSourceCommits[thirdImage] = "f".repeat(40);
    app.reviewedRollbackImageSchemaPhases[thirdImage] = [
      "0015_base",
      "0016_expand",
    ];
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const canonical = imageGenFlyState(thirdImage);
    const result = checkLiveFlyDrift("image-gen", {
      rootDir: root,
      expectedDeploymentIdentity: "deploy-124-1",
      capturedPriorIdentity: "deploy-123-2",
      capturedPriorImage: legacyImage,
      allowReviewedRollbackImage: true,
      allowInterruptedScaleCountDrift: true,
      runFly(args) {
        const command = args.slice(0, 2).join(" ");
        const value = JSON.parse(canonical(args));
        if (command === "config show") {
          value.env.LEADERBOT_DEPLOYMENT_IDENTITY = "deploy-124-1";
        } else if (command === "machine list") {
          for (const machine of value) {
            machine.config.env.LEADERBOT_DEPLOYMENT_IDENTITY = "deploy-124-1";
          }
        }
        return JSON.stringify(value);
      },
    });

    expect(result.blockingErrors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("image is not an approved rollback image"),
      ]),
    );
  });

  it("allows only reviewed mixed Machine images during same-job rollback recovery", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const { bridgeImage, legacyImage } = stageImageGenBridge(manifest);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const result = checkLiveFlyDrift("image-gen", {
      rootDir: root,
      runFly: imageGenFlyState(bridgeImage),
      expectedImage: legacyImage,
      allowReviewedMachineImages: true,
    });
    expect(result.blockingErrors).not.toEqual(
      expect.arrayContaining([
        expect.stringContaining("Machine image-gen-machine image"),
      ]),
    );
  });
});

describe("release-command recovery selector", () => {
  function stagedReleaseRecovery() {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const { bridgeImage, legacyImage } = stageImageGenBridge(manifest);
    const rollbackConfig = addReleaseCommandToCapturedImageConfig(
      root,
      manifest,
      legacyImage,
    );
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const options = {
      rootDir: root,
      interruptedDeploymentIdentity: "deploy-124-1",
      capturedPriorIdentity: "deploy-123-2",
      capturedPriorImage: legacyImage,
    };
    return { root, bridgeImage, legacyImage, rollbackConfig, options };
  }

  it("selects at most one exact candidate and one exact rollback release Machine", () => {
    const { root, bridgeImage, legacyImage, rollbackConfig, options } =
      stagedReleaseRecovery();
    const candidate = imageGenReleaseCommandMachine(
      bridgeImage,
      "deploy-124-1",
      {
        root,
        configuredImage:
          "registry.fly.io/leaderbot-fb-image-gen:deployment-01k-test",
      },
    );
    const rollback = imageGenReleaseCommandMachine(
      legacyImage,
      "deploy-123-2",
      {
        root,
        configPath: rollbackConfig,
        id: "b1b2c3d4e5f607",
        state: "destroying",
      },
    );
    rollback.config.guest = { cpu_kind: "shared", cpus: 2, memory_mb: 512 };

    expect(
      classifyRecoveryReleaseCommandMachines(
        "image-gen",
        [
          {
            id: "normal-machine",
            config: { metadata: { fly_process_group: "app" }, env: {} },
          },
          candidate,
          rollback,
        ],
        options,
      ),
    ).toEqual([
      { id: candidate.id, needsDestroy: true },
      { id: rollback.id, needsDestroy: false },
    ]);
  });

  it("returns no destructive target when no release-command Machine exists", () => {
    const { options } = stagedReleaseRecovery();
    expect(
      classifyRecoveryReleaseCommandMachines(
        "image-gen",
        [{ id: "normal", config: { metadata: { fly_process_group: "app" } } }],
        options,
      ),
    ).toEqual([]);
  });

  it("rejects duplicate release Machines for the same exact tuple", () => {
    const { root, bridgeImage, options } = stagedReleaseRecovery();
    const first = imageGenReleaseCommandMachine(bridgeImage, "deploy-124-1", {
      root,
    });
    const second = structuredClone(first);
    second.id = "c1b2c3d4e5f607";

    expect(() =>
      classifyRecoveryReleaseCommandMachines(
        "image-gen",
        [first, second],
        options,
      ),
    ).toThrow("at most one Machine per exact recovery tuple");
  });

  it.each([
    [
      "crossed prior identity",
      (machine) => {
        machine.config.env.LEADERBOT_DEPLOYMENT_IDENTITY = "deploy-123-2";
      },
    ],
    [
      "unknown immutable image",
      (machine) => {
        machine.image_ref.digest = `sha256:${"f".repeat(64)}`;
      },
    ],
    [
      "wrong release marker",
      (machine) => {
        machine.config.env.RELEASE_COMMAND = "0";
      },
    ],
    [
      "unreviewed init entrypoint",
      (machine) => {
        machine.config.init.entrypoint = ["/bin/sh"];
      },
    ],
    [
      "mount",
      (machine) => {
        machine.config.mounts = [{ source: "prod", path: "/data" }];
      },
    ],
    [
      "service",
      (machine) => {
        machine.config.services = [{ internal_port: 8080 }];
      },
    ],
    [
      "non-auto-destroy",
      (machine) => {
        machine.config.auto_destroy = false;
      },
    ],
    [
      "mutable restart policy",
      (machine) => {
        machine.config.restart.policy = "always";
      },
    ],
    [
      "registered DNS",
      (machine) => {
        machine.config.dns.skip_registration = false;
      },
    ],
    [
      "wrong pinned flyctl",
      (machine) => {
        machine.config.metadata.fly_flyctl_version = "0.4.86";
      },
    ],
    [
      "unknown MachineConfig field",
      (machine) => {
        machine.config.metrics = { port: 9091 };
      },
    ],
    [
      "wrong region",
      (machine) => {
        machine.region = "iad";
      },
    ],
    [
      "wrong guest",
      (machine) => {
        machine.config.guest.host_dedication_id = "unreviewed-host";
      },
    ],
    [
      "wrong stop timeout",
      (machine) => {
        machine.config.stop_config.timeout = 299_000_000_000;
      },
    ],
    [
      "unrecognized lifecycle",
      (machine) => {
        machine.state = "replacing";
      },
    ],
  ])("rejects an exact-looking release Machine with %s", (_label, mutate) => {
    const { root, bridgeImage, options } = stagedReleaseRecovery();
    const machine = imageGenReleaseCommandMachine(bridgeImage, "deploy-124-1", {
      root,
    });
    mutate(machine);

    expect(() =>
      classifyRecoveryReleaseCommandMachines("image-gen", [machine], options),
    ).toThrow("release-command Machine is not safe to destroy");
  });

  it("rejects a rollback tuple when its captured reviewed config has no release command", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const { legacyImage } = stageImageGenBridge(manifest);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const machine = imageGenReleaseCommandMachine(legacyImage, "deploy-123-2", {
      root,
    });

    expect(() =>
      classifyRecoveryReleaseCommandMachines("image-gen", [machine], {
        rootDir: root,
        interruptedDeploymentIdentity: "deploy-124-1",
        capturedPriorIdentity: "deploy-123-2",
        capturedPriorImage: legacyImage,
      }),
    ).toThrow("outside the exact recovery tuples");
  });
});

describe("versioned recovery data contract", () => {
  it("supports exact recovery protocol v1 and rejects unknown encodings", () => {
    expect(validateRecoveryProtocol("v1\n")).toBe("v1");
    for (const invalid of ["", "v1", "v1\nextra\n", "v2\n"]) {
      expect(() => validateRecoveryProtocol(invalid)).toThrow(
        "Unsupported production recovery protocol",
      );
    }
  });

  it("derives exact bounded scale counts from reviewed interrupted data", () => {
    expect(getReviewedScalePlan("image-gen", repoRoot)).toEqual([
      { process: "app", count: 2 },
      { process: "worker", count: 2 },
    ]);
    expect(getReviewedScalePlan("storage-proxy", repoRoot)).toEqual([
      { process: "app", count: 1 },
    ]);
  });

  it.each([
    [
      "non-integer count",
      (desired) => {
        desired.app.count = "1";
      },
    ],
    [
      "unbounded count",
      (desired) => {
        desired.app.count = 21;
      },
    ],
    [
      "unknown policy field",
      (desired) => {
        desired.app.region = "ams";
      },
    ],
  ])("rejects a recovery scale plan with %s", (_label, mutate) => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    mutate(manifest.apps["storage-proxy"].desiredScale);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    expect(() => getReviewedScalePlan("storage-proxy", root)).toThrow(
      "is not an exact bounded policy",
    );
  });
});

describe("settled production identity", () => {
  const verificationOptions = {
    rootDir: repoRoot,
    repository: "leaderbot/repository",
    token: "test-token",
    sleepImpl: async () => {},
  };

  it("accepts only the exact completed successful same-target deploy attempt", async () => {
    const calls = [];
    const result = await verifySettledBaseline("image-gen", "deploy-123-2", {
      ...verificationOptions,
      async fetchImpl(url) {
        calls.push(String(url));
        return jsonResponse(canonicalDeploymentRun("image-gen"));
      },
    });

    expect(result).toMatchObject({
      identity: "deploy-123-2",
      runId: "123",
      runAttempt: "2",
      runNumber: 40,
    });
    expect(calls).toEqual([
      "https://api.github.com/repos/leaderbot/repository/actions/runs/123/attempts/2",
    ]);
  });

  it("accepts only a canonical in-progress candidate newer than the settled live run", async () => {
    const runs = new Map([
      [
        "200/attempts/1",
        canonicalDeploymentRun("storage-proxy", "200", "1", {
          run_number: 51,
          status: "in_progress",
          conclusion: null,
          head_sha: "b".repeat(40),
        }),
      ],
      [
        "100/attempts/2",
        canonicalDeploymentRun("storage-proxy", "100", "2", {
          run_number: 50,
        }),
      ],
    ]);
    const fetchImpl = async (url) => {
      const key = String(url)
        .match(/runs\/(\d+)\/attempts\/(\d+)/)
        .slice(1)
        .join("/attempts/");
      return jsonResponse(runs.get(key));
    };

    await expect(
      verifyDeploymentCandidate(
        "storage-proxy",
        "deploy-100-2",
        "deploy-200-1",
        {
          ...verificationOptions,
          expectedSourceSha: "b".repeat(40),
          fetchImpl,
        },
      ),
    ).resolves.toMatchObject({ runNumber: 51 });
  });

  it("rejects an older queued candidate after a newer live release", async () => {
    const fetchImpl = async (url) => {
      const candidate = String(url).includes("/runs/100/");
      return jsonResponse(
        canonicalDeploymentRun(
          "image-gen",
          candidate ? "100" : "200",
          "1",
          candidate
            ? {
                run_number: 49,
                status: "in_progress",
                conclusion: null,
                head_sha: "b".repeat(40),
              }
            : { run_number: 50 },
        ),
      );
    };
    await expect(
      verifyDeploymentCandidate("image-gen", "deploy-200-1", "deploy-100-1", {
        ...verificationOptions,
        expectedSourceSha: "b".repeat(40),
        fetchImpl,
      }),
    ).rejects.toThrow("is not newer than live");
  });

  it("accepts only a higher attempt of the same run number", async () => {
    const fetchImpl = async (url) => {
      const candidate = String(url).includes("attempts/3");
      return jsonResponse(
        canonicalDeploymentRun("gateway", "100", candidate ? "3" : "2", {
          run_number: 50,
          ...(candidate
            ? {
                status: "in_progress",
                conclusion: null,
                head_sha: "b".repeat(40),
              }
            : {}),
        }),
      );
    };
    await expect(
      verifyDeploymentCandidate("gateway", "deploy-100-2", "deploy-100-3", {
        ...verificationOptions,
        expectedSourceSha: "b".repeat(40),
        fetchImpl,
      }),
    ).resolves.toMatchObject({ runNumber: 50 });
    await expect(
      verifyDeploymentCandidate("gateway", "deploy-100-2", "deploy-101-1", {
        ...verificationOptions,
        expectedSourceSha: "b".repeat(40),
        fetchImpl: async (url) => {
          if (String(url).includes("/runs/100/")) {
            return jsonResponse(
              canonicalDeploymentRun("gateway", "100", "2", { run_number: 50 }),
            );
          }
          return jsonResponse(
            canonicalDeploymentRun("gateway", "101", "1", {
              run_number: 50,
              status: "in_progress",
              conclusion: null,
              head_sha: "b".repeat(40),
            }),
          );
        },
      }),
    ).rejects.toThrow("is not newer than live");
  });

  it("rejects a candidate whose canonical run does not match the exact source SHA", async () => {
    const fetchImpl = async (url) =>
      jsonResponse(
        String(url).includes("/runs/200/")
          ? canonicalDeploymentRun("storage-proxy", "200", "1", {
              run_number: 51,
              status: "in_progress",
              conclusion: null,
              head_sha: "c".repeat(40),
            })
          : canonicalDeploymentRun("storage-proxy", "100", "2", {
              run_number: 50,
            }),
      );
    await expect(
      verifyDeploymentCandidate(
        "storage-proxy",
        "deploy-100-2",
        "deploy-200-1",
        {
          ...verificationOptions,
          expectedSourceSha: "b".repeat(40),
          fetchImpl,
        },
      ),
    ).rejects.toThrow("not the exact in-progress deployment candidate");
  });

  it.each([
    ["failed", { conclusion: "failure" }],
    ["in progress", { status: "in_progress", conclusion: null }],
    ["wrong workflow", { path: ".github/workflows/main.yml" }],
    ["wrong branch", { head_branch: "feature" }],
    ["wrong event", { event: "push" }],
    ["wrong target title", { display_title: "Deploy gateway to production" }],
    ["wrong attempt", { run_attempt: 3 }],
  ])("rejects a %s predecessor", async (_label, override) => {
    await expect(
      verifySettledBaseline("image-gen", "deploy-123-2", {
        ...verificationOptions,
        maxAttempts: 1,
        fetchImpl: async () =>
          jsonResponse(
            canonicalDeploymentRun("image-gen", "123", "2", override),
          ),
      }),
    ).rejects.toThrow();
  });

  it("rejects legacy rollback and unknown identities without a network call", async () => {
    let calls = 0;
    for (const identity of ["rollback-123-2", "deploy-123", "unknown"]) {
      await expect(
        verifySettledBaseline("image-gen", identity, {
          ...verificationOptions,
          fetchImpl: async () => {
            calls += 1;
            return jsonResponse({});
          },
        }),
      ).rejects.toThrow("none or an exact deploy run identity");
    }
    expect(calls).toBe(0);
  });

  it("retries a transient null conclusion but remains fail closed", async () => {
    let calls = 0;
    await expect(
      verifySettledBaseline("image-gen", "deploy-123-2", {
        ...verificationOptions,
        maxAttempts: 2,
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse(
            calls === 1
              ? canonicalDeploymentRun("image-gen", "123", "2", {
                  status: "in_progress",
                  conclusion: null,
                })
              : canonicalDeploymentRun("image-gen"),
          );
        },
      }),
    ).resolves.toMatchObject({ identity: "deploy-123-2" });
    expect(calls).toBe(2);
  });

  it("accepts supersession only by higher run number or a higher retry attempt", async () => {
    const runs = new Map([
      [
        "200/attempts/1",
        canonicalDeploymentRun("storage-proxy", "200", "1", { run_number: 51 }),
      ],
      [
        "100/attempts/2",
        canonicalDeploymentRun("storage-proxy", "100", "2", {
          run_number: 50,
          conclusion: "failure",
        }),
      ],
      [
        "100/attempts/3",
        canonicalDeploymentRun("storage-proxy", "100", "3", { run_number: 50 }),
      ],
    ]);
    const fetchImpl = async (url) => {
      const key = String(url)
        .match(/runs\/(\d+)\/attempts\/(\d+)/)
        .slice(1)
        .join("/attempts/");
      return jsonResponse(runs.get(key));
    };

    await expect(
      verifySettledBaseline("storage-proxy", "deploy-200-1", {
        ...verificationOptions,
        fetchImpl,
        supersedesIdentity: "deploy-100-2",
      }),
    ).resolves.toMatchObject({ runNumber: 51 });
    await expect(
      verifySettledBaseline("storage-proxy", "deploy-100-3", {
        ...verificationOptions,
        fetchImpl,
        supersedesIdentity: "deploy-100-2",
      }),
    ).resolves.toMatchObject({ runAttempt: "3" });
  });

  it("rejects a larger run id when its canonical run number is not newer", async () => {
    const fetchImpl = async (url) => {
      const isCurrent = String(url).includes("/runs/200/");
      return jsonResponse(
        canonicalDeploymentRun(
          "gateway",
          isCurrent ? "200" : "100",
          isCurrent ? "1" : "2",
          {
            run_number: isCurrent ? 49 : 50,
            conclusion: isCurrent ? "success" : "failure",
          },
        ),
      );
    };
    await expect(
      verifySettledBaseline("gateway", "deploy-200-1", {
        ...verificationOptions,
        fetchImpl,
        supersedesIdentity: "deploy-100-2",
      }),
    ).rejects.toThrow("is not newer than");
  });

  it("allows none only for the exact manifest-approved first trusted image", async () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const { legacyImage } = stageImageGenBridge(manifest);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(
      verifySettledBaseline("image-gen", "none", {
        rootDir: root,
        expectedImage: legacyImage,
      }),
    ).resolves.toMatchObject({ bootstrap: true });
    await expect(
      verifySettledBaseline("image-gen", "none", {
        rootDir: root,
        expectedImage: manifest.apps["image-gen"].reviewedImage,
      }),
    ).rejects.toThrow("no manifest-approved first trusted bootstrap");
  });

  it("validates a newer approval commit with an independently attested build commit", async () => {
    const fixture = storageSuccessorFixture();
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), "leaderbot-successor-source-"),
    );
    tempDirs.push(parent);
    const destination = path.join(parent, "approved");

    await expect(
      materializeSuccessorSourceRoot(
        "storage-proxy",
        "deploy-200-1",
        "deploy-100-2",
        destination,
        {
          repository: "leaderbot/repository",
          token: "test-token",
          sleepImpl: async () => {},
          fetchImpl: fixture.fetchImpl,
        },
      ),
    ).resolves.toMatchObject({
      identity: "deploy-200-1",
      sourceSha: fixture.approvalCommit,
      rootDir: destination,
    });

    const writtenManifest = JSON.parse(
      fs.readFileSync(
        path.join(destination, "deploy/production/apps.json"),
        "utf8",
      ),
    );
    expect(writtenManifest.apps["storage-proxy"].reviewedSourceCommit).toBe(
      fixture.sourceCommit,
    );
    expect(fixture.sourceCommit).not.toBe(fixture.approvalCommit);
    expect(
      fixture.calls
        .filter((url) => url.pathname.includes("/contents/"))
        .every((url) => url.searchParams.get("ref") === fixture.approvalCommit),
    ).toBe(true);
    expect(
      new Set(
        fixture.calls
          .filter((url) => url.pathname.includes("/actions/workflows/"))
          .map((url) => url.searchParams.get("head_sha")),
      ),
    ).toEqual(new Set([fixture.sourceCommit, fixture.approvalCommit]));
  });

  it("rejects successor manifests without exact reviewed artifact provenance", async () => {
    const fixture = storageSuccessorFixture(({ app }) => {
      app.reviewedSourceCommit = null;
    });
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), "leaderbot-successor-provenance-"),
    );
    tempDirs.push(parent);

    await expect(
      materializeSuccessorSourceRoot(
        "storage-proxy",
        "deploy-200-1",
        "deploy-100-2",
        path.join(parent, "rejected"),
        {
          repository: "leaderbot/repository",
          token: "test-token",
          sleepImpl: async () => {},
          fetchImpl: fixture.fetchImpl,
        },
      ),
    ).rejects.toThrow("lacks an exact reviewed source commit");
  });

  it("rejects a successor whose artifact source has not passed current required CI", async () => {
    const fixture = storageSuccessorFixture();
    const baseFetch = fixture.fetchImpl;
    fixture.fetchImpl = async (input) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/actions/workflows/")) {
        return jsonResponse({ workflow_runs: [] });
      }
      return baseFetch(input);
    };
    const parent = fs.mkdtempSync(
      path.join(os.tmpdir(), "leaderbot-successor-ci-"),
    );
    tempDirs.push(parent);

    await expect(
      materializeSuccessorSourceRoot(
        "storage-proxy",
        "deploy-200-1",
        "deploy-100-2",
        path.join(parent, "rejected"),
        {
          repository: "leaderbot/repository",
          token: "test-token",
          sleepImpl: async () => {},
          fetchImpl: fixture.fetchImpl,
        },
      ),
    ).rejects.toThrow("has no successful main push run");
  });

  it("requires a successor to run its exact current reviewed image and config", async () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const { legacyImage } = stageStorageProxyRuntime(manifest);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const canonical = storageProxyFlyState(legacyImage);

    await expect(
      checkSettledLiveFlyDrift("storage-proxy", {
        rootDir: root,
        requireCurrentReviewedImage: true,
        expectedSourceSha: "d".repeat(40),
        repository: "leaderbot/repository",
        token: "test-token",
        runFly(args) {
          const value = JSON.parse(canonical(args));
          if (args.slice(0, 2).join(" ") === "config show") {
            value.env.LEADERBOT_DEPLOYMENT_IDENTITY = "deploy-200-1";
          } else if (args.slice(0, 2).join(" ") === "machine list") {
            value[0].config.env.LEADERBOT_DEPLOYMENT_IDENTITY = "deploy-200-1";
          }
          return JSON.stringify(value);
        },
        fetchImpl: async () =>
          jsonResponse(
            canonicalDeploymentRun("storage-proxy", "200", "1", {
              head_sha: "d".repeat(40),
            }),
          ),
      }),
    ).rejects.toThrow(
      "successor live image is not the exact reviewed image from its source",
    );
  });

  it("rejects a successor identity and image paired with a rollback configuration", async () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const { runtimeImage } = stageStorageProxyRuntime(manifest);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const canonical = storageProxyFlyState(runtimeImage);

    const result = await checkSettledLiveFlyDrift("storage-proxy", {
      rootDir: root,
      requireCurrentReviewedImage: true,
      expectedSourceSha: "d".repeat(40),
      repository: "leaderbot/repository",
      token: "test-token",
      runFly(args) {
        const command = args.slice(0, 2).join(" ");
        const value = JSON.parse(canonical(args));
        if (command === "config show") {
          value.env = { LEADERBOT_DEPLOYMENT_IDENTITY: "deploy-200-1" };
          value.processes = {};
          value.http_service.checks = [];
        } else if (command === "machine list") {
          value[0].config.init = {};
          value[0].config.env = {
            FLY_PROCESS_GROUP: "app",
            PRIMARY_REGION: "ams",
            LEADERBOT_DEPLOYMENT_IDENTITY: "deploy-200-1",
          };
          value[0].config.services[0].checks = [];
        }
        return JSON.stringify(value);
      },
      fetchImpl: async () => {
        throw new Error("drift must block before identity trust is consulted");
      },
    });

    expect(result.blockingErrors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("env.STORAGE_OPERATION_TIMEOUT_MS"),
        expect.stringContaining("live process commands"),
        expect.stringContaining("init command"),
      ]),
    );
  });

  it("accepts only the exact known image-gen legacy predecessor for the first trusted bootstrap", async () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const { legacyImage } = stageImageGenBridge(manifest);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(
      checkSettledLiveFlyDrift("image-gen", {
        rootDir: root,
        runFly: imageGenLegacyBootstrapFlyState(legacyImage),
      }),
    ).resolves.toMatchObject({
      identity: "none",
      expectedImage: legacyImage,
      blockingErrors: [],
      reconcilableDrift: [],
      acceptedBootstrapDrift: expect.arrayContaining([
        expect.stringContaining("legacy cost limits will be tightened"),
        expect.stringContaining("legacy worker standby will be reconciled"),
      ]),
    });
  });

  it("accepts a byte-exact copied rollback config during the first trusted bootstrap", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const { legacyImage } = stageImageGenBridge(manifest);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const reviewedConfig = getReviewedRollbackConfig(
      "image-gen",
      legacyImage,
      root,
    );
    const copiedConfig = path.join(root, "before.fly.toml");
    fs.copyFileSync(path.join(root, reviewedConfig), copiedConfig);

    const result = checkLiveFlyDrift("image-gen", {
      rootDir: root,
      runFly: imageGenLegacyBootstrapFlyState(legacyImage),
      expectedImage: legacyImage,
      configPath: copiedConfig,
      expectedDeploymentIdentity: "none",
      allowFirstTrustedBootstrapDrift: true,
    });

    expect(result.blockingErrors).toEqual([]);
  });

  it("rejects a modified copied rollback config during the first trusted bootstrap", () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const { legacyImage } = stageImageGenBridge(manifest);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const reviewedConfig = getReviewedRollbackConfig(
      "image-gen",
      legacyImage,
      root,
    );
    const copiedConfig = path.join(root, "before.fly.toml");
    fs.copyFileSync(path.join(root, reviewedConfig), copiedConfig);
    fs.appendFileSync(copiedConfig, "\n");

    expect(() =>
      checkLiveFlyDrift("image-gen", {
        rootDir: root,
        runFly: imageGenLegacyBootstrapFlyState(legacyImage),
        expectedImage: legacyImage,
        configPath: copiedConfig,
        expectedDeploymentIdentity: "none",
        allowFirstTrustedBootstrapDrift: true,
      }),
    ).toThrow(
      "first trusted bootstrap drift requires the exact reviewed image-gen legacy predecessor",
    );
  });

  it.each([
    [
      "an extra environment change",
      ({ machines }) => {
        machines[0].config.env.MOLLIE_BILLING_ENABLED = "true";
      },
      "environment differs",
    ],
    [
      "a mounted volume",
      ({ machines }) => {
        machines[0].config.mounts = [{ volume: "unknown", path: "/data" }];
      },
      "mounts differ",
    ],
    [
      "a malformed standby",
      ({ machines }) => {
        machines[3].config.standbys = ["missing-worker"];
      },
      "invalid legacy standby binding",
    ],
  ])(
    "rejects first-bootstrap drift with %s",
    async (_label, mutate, message) => {
      const root = createRepositoryFixture();
      const manifestPath = path.join(root, "deploy/production/apps.json");
      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      const { legacyImage } = stageImageGenBridge(manifest);
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

      const result = await checkSettledLiveFlyDrift("image-gen", {
        rootDir: root,
        runFly: imageGenLegacyBootstrapFlyState(legacyImage, mutate),
      });
      expect(result.blockingErrors).toEqual(
        expect.arrayContaining([expect.stringContaining(message)]),
      );
    },
  );

  it("validates the exact reviewed live rollback image and config during upgrade preflight", async () => {
    const root = createRepositoryFixture();
    const manifestPath = path.join(root, "deploy/production/apps.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const { legacyImage } = stageStorageProxyRuntime(manifest);
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await expect(
      checkSettledLiveFlyDrift("storage-proxy", {
        rootDir: root,
        runFly(args) {
          const canonical = storageProxyFlyState(legacyImage);
          const command = args.slice(0, 2).join(" ");
          if (command === "machine list") {
            const machines = JSON.parse(canonical(args));
            machines[0].config.init = {};
            machines[0].config.env = {
              FLY_PROCESS_GROUP: "app",
              PRIMARY_REGION: "ams",
            };
            machines[0].config.services[0].checks = [];
            return JSON.stringify(machines);
          }
          if (command !== "config show") {
            return canonical(args);
          }
          const live = JSON.parse(canonical(args));
          live.env = {};
          live.processes = {};
          live.http_service.checks = [];
          return JSON.stringify(live);
        },
      }),
    ).resolves.toMatchObject({
      identity: "none",
      expectedImage: legacyImage,
      blockingErrors: [],
      reconcilableDrift: [],
    });
  });
});

describe("Meta callback contract", () => {
  it("reports the reviewed temporary Page callback without failing", async () => {
    const result = await checkMetaCallbacks({
      rootDir: repoRoot,
      appId: "test-app",
      appSecret: "test-secret",
      fetchImpl: async () =>
        metaResponse("https://leaderbot-fb-image-gen.fly.dev/facebook/webhook"),
    });

    expect(result.errors).toEqual([]);
    expect(result.warnings).toHaveLength(1);
  });

  it("rejects an unreviewed callback host", async () => {
    const result = await checkMetaCallbacks({
      rootDir: repoRoot,
      appId: "test-app",
      appSecret: "test-secret",
      fetchImpl: async () => metaResponse("https://unexpected.example/webhook"),
    });

    expect(result.errors).toContain("page uses an unreviewed callback");
  });

  it("rejects an unreviewed subscription object", async () => {
    const result = await checkMetaCallbacks({
      rootDir: repoRoot,
      appId: "test-app",
      appSecret: "test-secret",
      fetchImpl: async () =>
        metaResponse(
          "https://leaderbot-fb-image-gen.fly.dev/facebook/webhook",
          (data) => [
            ...data,
            {
              object: "instagram",
              active: true,
              callback_url: "https://unexpected.example/instagram",
              fields: ["messages"],
            },
          ],
        ),
    });

    expect(result.errors).toContain(
      "Unreviewed Meta subscription object instagram",
    );
  });

  it("rejects an unreviewed subscription field", async () => {
    const result = await checkMetaCallbacks({
      rootDir: repoRoot,
      appId: "test-app",
      appSecret: "test-secret",
      fetchImpl: async () =>
        metaResponse(
          "https://leaderbot-fb-image-gen.fly.dev/facebook/webhook",
          (data) =>
            data.map((subscription) =>
              subscription.object === "page"
                ? { ...subscription, fields: [...subscription.fields, "feed"] }
                : subscription,
            ),
        ),
    });

    expect(result.errors).toContain("page uses unreviewed field feed");
  });

  it("adds a timeout signal to the Meta request", async () => {
    let requestInit;
    await checkMetaCallbacks({
      rootDir: repoRoot,
      appId: "test-app",
      appSecret: "test-secret",
      fetchImpl: async (_url, init) => {
        requestInit = init;
        return metaResponse(
          "https://leaderbot-fb-image-gen.fly.dev/facebook/webhook",
        );
      },
    });

    expect(requestInit.signal).toBeInstanceOf(AbortSignal);
  });

  it("reports an HTTP error before attempting to parse a non-JSON body", async () => {
    await expect(
      checkMetaCallbacks({
        rootDir: repoRoot,
        appId: "test-app",
        appSecret: "test-secret",
        fetchImpl: async () => ({
          ok: false,
          status: 503,
          async json() {
            throw new SyntaxError("not JSON");
          },
        }),
      }),
    ).rejects.toThrow("Meta callback query failed (503)");
  });
});
