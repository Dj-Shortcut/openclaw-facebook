#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { pruneImageDependencies } from "./prune-image-deps-core.mjs";

function runCli(argv = process.argv.slice(2)) {
  const appRoot = argv[0] ? path.resolve(argv[0]) : process.cwd();
  const { nodeModules, removedBytes } = pruneImageDependencies(appRoot);
  const removedMiB = (removedBytes / 1024 / 1024).toFixed(1);
  console.log(`pruned non-runtime npm artifacts from ${nodeModules}: ${removedMiB} MiB removed`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runCli();
}
