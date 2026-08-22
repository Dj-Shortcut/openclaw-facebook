import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { checkMetaCallbacks } from "./check-meta-callbacks.mjs";
import {
  checkLiveFlyDrift,
  validateProductionRepository,
} from "./validate-production-deployment.mjs";

function createRepositoryFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "leaderbot-production-contract-"));
  fs.mkdirSync(path.join(root, "deploy/production"), { recursive: true });
  fs.mkdirSync(path.join(root, "apps/image-gen"), { recursive: true });
  fs.mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
  fs.copyFileSync("deploy/production/apps.json", path.join(root, "deploy/production/apps.json"));
  fs.copyFileSync("package.json", path.join(root, "package.json"));
  fs.copyFileSync("fly.toml", path.join(root, "fly.toml"));
  fs.copyFileSync("apps/image-gen/fly.toml", path.join(root, "apps/image-gen/fly.toml"));
  fs.copyFileSync(
    ".github/workflows/deploy-production.yml",
    path.join(root, ".github/workflows/deploy-production.yml"),
  );
  fs.copyFileSync(
    ".github/workflows/production-uptime.yml",
    path.join(root, ".github/workflows/production-uptime.yml"),
  );
  return root;
}

function metaResponse(pageCallback) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        data: [
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
        ],
      };
    },
  };
}

describe("production deployment contract", () => {
  it("accepts the checked-in production configs", () => {
    expect(validateProductionRepository()).toEqual({ apps: 2, callbacks: 2 });
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

  it("requires automatic rollback steps for both production apps", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(root, ".github/workflows/deploy-production.yml");
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace("Roll back failed gateway deployment", "Record failed gateway deployment"),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must automatically roll back failed gateway releases",
    );
  });

  it("requires rollback to redeploy the captured image", () => {
    const root = createRepositoryFixture();
    const workflowPath = path.join(root, ".github/workflows/deploy-production.yml");
    const workflow = fs.readFileSync(workflowPath, "utf8");
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        'npm run deploy:image-gen -- --remote-only --yes --image "$rollback_image"',
        'echo "manual image-gen rollback required"',
      ),
    );

    expect(() => validateProductionRepository(root)).toThrow(
      "must restore the captured image-gen image on failure",
    );
  });

  it("blocks detached Machines before deployment", () => {
    const result = checkLiveFlyDrift("gateway", {
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
    const result = checkLiveFlyDrift("image-gen", {
      runFly(args) {
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
              id: "unreviewed-image-machine",
              config: {
                image: "registry.fly.io/leaderbot-fb-image-gen@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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
      },
    });

    expect(result.blockingErrors).toContain(
      "Machine unreviewed-image-machine image differs from the reviewed production digest",
    );
  });
});

describe("Meta callback contract", () => {
  it("reports the reviewed temporary Page callback without failing", async () => {
    const result = await checkMetaCallbacks({
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
      appId: "test-app",
      appSecret: "test-secret",
      fetchImpl: async () => metaResponse("https://unexpected.example/webhook"),
    });

    expect(result.errors).toContain("page uses an unreviewed callback");
  });
});
