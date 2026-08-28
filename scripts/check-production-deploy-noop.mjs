import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import {
  checkLiveFlyDrift,
  loadProductionManifest,
} from "./validate-production-deployment.mjs";

export const DEPLOY_REQUIRED_EXIT_CODE = 10;

/**
 * Check whether a deploy would be an exact no-op.  A non-exact but readable
 * live state is deliberately not an error: the guarded deploy path must still
 * be allowed to reconcile it.  Fly/API failures remain errors and must stop
 * the workflow instead of being mistaken for drift.
 */
export function checkProductionDeployNoop(
  target,
  reviewedImage,
  { rootDir = process.cwd(), runFly } = {},
) {
  if (typeof reviewedImage !== "string" || reviewedImage.length === 0) {
    throw new Error("reviewed image is required for duplicate-deploy check");
  }
  const app = loadProductionManifest(rootDir).apps[target];
  if (!app) throw new Error(`Unknown production target: ${target}`);
  const underlyingRun =
    runFly ??
    ((args) => {
      throw new Error(`Fly runner is required: ${args.join(" ")}`);
    });
  const cached = new Map();
  const run = (args) => {
    const key = args.join("\0");
    if (!cached.has(key)) cached.set(key, underlyingRun(args));
    return cached.get(key);
  };
  const live = JSON.parse(run(["config", "show", "--app", app.app]));
  const identity = live?.env?.LEADERBOT_DEPLOYMENT_IDENTITY ?? "none";
  if (
    !/^(?:none|deploy-[0-9]+-[0-9]+|rollback-[0-9]+-[0-9]+)$/.test(identity)
  ) {
    throw new Error("live deployment identity is not trusted");
  }
  const result = checkLiveFlyDrift(target, {
    rootDir,
    expectedImage: reviewedImage,
    expectedDeploymentIdentity: identity,
    runFly: run,
  });
  const drift = [...result.blockingErrors, ...result.reconcilableDrift];
  return {
    exact: drift.length === 0,
    identity,
    image: reviewedImage,
    drift,
  };
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const targetIndex = process.argv.indexOf("--check-production-deploy-noop");
  const target = process.argv[targetIndex + 1];
  const image = process.argv[targetIndex + 2];
  try {
    const result = checkProductionDeployNoop(target, image, {
      rootDir: process.argv.includes("--root-dir")
        ? process.argv[process.argv.indexOf("--root-dir") + 1]
        : process.cwd(),
      runFly: (args) => execFileSync("flyctl", args, { encoding: "utf8" }),
    });
    if (result.exact) {
      process.stdout.write(
        `Exact reviewed ${target} image and configuration already live; deployment is a no-op.\n`,
      );
      process.exit(0);
    }
    process.stdout.write(
      `${target} requires deployment to reconcile live drift:\n- ${result.drift.join("\n- ")}\n`,
    );
    process.exit(DEPLOY_REQUIRED_EXIT_CODE);
  } catch (error) {
    process.stderr.write(
      `Duplicate-deploy preflight failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(1);
  }
}
