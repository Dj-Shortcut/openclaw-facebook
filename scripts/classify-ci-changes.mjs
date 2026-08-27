#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SHA_PATTERN = /^[a-f0-9]{40}$/;

function normalizedPath(value) {
  return String(value).replaceAll("\\", "/").replace(/^\.\//, "");
}

export function classifyCiChanges(changedPaths) {
  const paths = changedPaths.map(normalizedPath).filter(Boolean);
  const classifierChanged = paths.includes("scripts/classify-ci-changes.mjs");
  const imageGen =
    classifierChanged ||
    paths.some(
      (file) =>
        file.startsWith("apps/image-gen/") ||
        file === ".github/workflows/image-gen-ci.yml",
    );
  const migration =
    classifierChanged ||
    paths.some(
      (file) =>
        (file.startsWith("apps/image-gen/") &&
          !file.startsWith("apps/image-gen/storage-proxy/")) ||
        file === ".github/workflows/image-gen-migration-smoke.yml" ||
        file === "scripts/image-gen-migration-smoke-workflow.test.mjs",
    );
  return { imageGen, migration };
}

export function changedPathsFromGit({
  head = process.env.GITHUB_SHA?.trim() ?? "",
  base = process.env.CI_BASE_SHA?.trim() ?? "",
  run = spawnSync,
} = {}) {
  if (!SHA_PATTERN.test(head) || !SHA_PATTERN.test(base) || base === "0".repeat(40)) {
    return undefined;
  }
  const result = run(
    "git",
    ["diff", "--no-renames", "--name-only", "-z", base, head],
    {
      encoding: "buffer",
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `Could not classify CI changes between ${base} and ${head}: ${result.stderr.toString("utf8").trim()}`,
    );
  }
  return result.stdout
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function writeGithubOutput(classification) {
  const outputPath = process.env.GITHUB_OUTPUT?.trim();
  if (!outputPath) {
    throw new Error("GITHUB_OUTPUT is required when classifying CI changes");
  }
  fs.appendFileSync(
    outputPath,
    `image_gen=${classification.imageGen}\nmigration=${classification.migration}\n`,
    "utf8",
  );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const changedPaths = changedPathsFromGit();
  // Missing or unusable event ancestry fails safe by running both expensive suites.
  writeGithubOutput(
    changedPaths === undefined
      ? { imageGen: true, migration: true }
      : classifyCiChanges(changedPaths),
  );
}
