import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { checkMetaCallbacks } from "./check-meta-callbacks.mjs";
import {
  checkLiveFlyDrift,
  resolveImmutableReleaseImage,
  validateProductionRepository,
  validateReviewedRollbackImage,
} from "./validate-production-deployment.mjs";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const tempDirs = [];

function createRepositoryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leaderbot-production-contract-"));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, "deploy/production"), { recursive: true });
  fs.mkdirSync(path.join(root, "apps/image-gen"), { recursive: true });
  fs.mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
  for (const relativePath of [
    "deploy/production/apps.json",
    "package.json",
    "fly.toml",
    "apps/image-gen/fly.toml",
    ".github/workflows/deploy-production.yml",
    ".github/workflows/main.yml",
    ".github/workflows/production-uptime.yml",
  ]) {
    fs.copyFileSync(path.join(repoRoot, relativePath), path.join(root, relativePath));
  }
  return root;
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
          config: {
            image,
            metadata: { fly_platform_version: "v2", fly_process_group: "app" },
          },
        },
      ]);
    }
    if (command === "scale show") {
      return JSON.stringify([
        { Process: "app", Count: 2, CPUKind: "shared", CPUs: 1, Memory: 256 },
        { Process: "worker", Count: 2, CPUKind: "shared", CPUs: 1, Memory: 256 },
      ]);
    }
    throw new Error(`Unexpected fly command: ${args.join(" ")}`);
  };
}

describe("production deployment contract", () => {
  it("accepts the checked-in production configs", () => {
    expect(validateProductionRepository(repoRoot)).toEqual({ apps: 2, callbacks: 2 });
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
    fs.writeFileSync(configPath, config.replace('path = "/healthz"', 'path = "/readyz"'));

    expect(() => validateProductionRepository(root)).toThrow(
      "must define a /healthz service check",
    );
  });

  it("requires separate external readiness monitoring", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(root, ".github/workflows/production-uptime.yml");
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(workflowPath, workflow.replaceAll("/readyz", "/healthz"));

    expect(() => validateProductionRepository(root)).toThrow(
      "must monitor /readyz",
    );
  });

  it("rejects production workflows that can create detached Machines", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(root, ".github/workflows/deploy-production.yml");
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
      fs.readFileSync(path.join(repoRoot, "deploy/production/apps.json"), "utf8"),
    );

    expect(
      validateReviewedRollbackImage(
        "image-gen",
        manifest.apps["image-gen"].reviewedImage,
        repoRoot,
      ),
    ).toBe(manifest.apps["image-gen"].reviewedImage);
    expect(() =>
      validateReviewedRollbackImage(
        "image-gen",
        "registry.fly.io/leaderbot-fb-image-gen@sha256:0bdf169a494b57085ac51537aca7db03e9890cbadd46d7604933fde7df946b91",
        repoRoot,
      ),
    ).toThrow("not in the reviewed production allowlist");
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

  it("requires the workflow to enforce the manifest image-gen digest", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(root, ".github/workflows/deploy-production.yml");
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        "image-gen image must exactly match the reviewed manifest digest",
        "image-gen image prefix accepted",
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must enforce the reviewed image-gen digest",
    );
  });

  it("requires manual gateway rollback input to be allowlisted", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(root, ".github/workflows/deploy-production.yml");
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        "--validate-rollback-image gateway",
        "--accept-rollback-image gateway",
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must validate gateway input, capture, and restore",
    );
  });

  it("requires the captured gateway rollback digest to be allowlisted", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(root, ".github/workflows/deploy-production.yml");
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
    const workflowPath = path.join(root, ".github/workflows/deploy-production.yml");
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace("Restore captured gateway release", "Record failed gateway deployment"),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must include gateway rollback",
    );
  });

  it("reserves job time for both rollback steps", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(root, ".github/workflows/deploy-production.yml");
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace("timeout-minutes: 15", "timeout-minutes: 30"),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must reserve bounded rollback steps",
    );
  });

  it("requires both rollback captures to fail closed on a missing release image", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(root, ".github/workflows/deploy-production.yml");
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(workflowPath, workflow.replace('release_image="$(jq -er', 'release_image="$(jq -r'));

    expect(() => validateProductionRepository(root)).toThrow(
      "must fail closed when either rollback release is missing",
    );
  });

  it("requires rollback to restore both captured Fly configurations", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(root, ".github/workflows/deploy-production.yml");
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        '--config "$rollback_config"',
        '--config fly.toml',
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must validate and restore both captured configurations",
    );
  });

  it("runs root contract CI when the image-gen Fly config changes", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(root, ".github/workflows/main.yml");
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace('      - "apps/image-gen/fly.toml"\n', ""),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must run for apps/image-gen/fly.toml",
    );
  });

  it("requires the canonical image-gen script to carry the reviewed digest", () => {
    const root = createRepositoryFixture();
    const packagePath = path.join(root, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    packageJson.scripts["deploy:image-gen"] =
      "cd apps/image-gen && fly deploy --config fly.toml --strategy rolling";
    fs.writeFileSync(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

    expect(() => validateProductionRepository(root)).toThrow(
      "image-gen deploy script must require the reviewed manifest image",
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
            http_service: { processes: ["app"], checks: [{ path: "/healthz" }] },
          });
        }
        if (command === "machine list") {
          return JSON.stringify([
            {
              id: "detached-test-machine",
              config: { metadata: { fly_process_group: "app" } },
            },
          ]);
        }
        if (command === "scale show") {
          return JSON.stringify([
            { Process: "app", Count: 1, CPUKind: "shared", CPUs: 4, Memory: 4096 },
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
            http_service: { processes: ["app"], checks: [{ path: "/healthz" }] },
          });
        }
        if (command === "machine list") {
          return JSON.stringify([
            {
              id: "managed-gateway-machine",
              config: {
                metadata: { fly_platform_version: "v2", fly_process_group: "app" },
              },
            },
          ]);
        }
        if (command === "scale show") {
          return JSON.stringify([
            { Process: "app", Count: 1, CPUKind: "shared", CPUs: 4, Memory: 4096 },
          ]);
        }
        throw new Error(`Unexpected fly command: ${args.join(" ")}`);
      },
    });

    expect(result.blockingErrors).toContain(
      "live volume mounts differ from the production fly.toml",
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
    expect(predeploy.blockingErrors).toEqual([]);
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

    expect(result.errors).toContain("Unreviewed Meta subscription object instagram");
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
        return metaResponse("https://leaderbot-fb-image-gen.fly.dev/facebook/webhook");
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
