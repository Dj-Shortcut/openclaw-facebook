#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const appRoot = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const nodeModules = path.join(appRoot, "node_modules");

const removableDirectoryNames = new Set([
  "__tests__",
  "coverage",
  "doc",
  "docs",
  "example",
  "examples",
  "test",
  "tests",
]);

const removableFileSuffixes = [
  ".map",
  ".tsbuildinfo",
];

const removableFileNames = new Set([
  ".DS_Store",
  "npm-debug.log",
  "yarn-error.log",
]);

function isInsideNodeModules(filePath) {
  const relative = path.relative(nodeModules, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function removePath(targetPath) {
  if (!isInsideNodeModules(targetPath)) {
    throw new Error(`Refusing to remove path outside node_modules: ${targetPath}`);
  }
  const size = pathSize(targetPath);
  fs.rmSync(targetPath, { recursive: true, force: true });
  return size;
}

function pathSize(targetPath) {
  let total = 0;
  let stat;
  try {
    stat = fs.lstatSync(targetPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return 0;
    }
    throw error;
  }
  if (!stat.isDirectory()) {
    return stat.size;
  }
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    total += pathSize(path.join(targetPath, entry.name));
  }
  return total;
}

function shouldRemoveFile(filePath, name) {
  if (removableFileNames.has(name)) {
    return true;
  }
  if (removableFileSuffixes.some((suffix) => name.endsWith(suffix))) {
    return true;
  }
  return false;
}

function pruneDirectory(directory) {
  let removedBytes = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (removableDirectoryNames.has(entry.name)) {
        removedBytes += removePath(entryPath);
        continue;
      }
      removedBytes += pruneDirectory(entryPath);
      continue;
    }
    if (entry.isFile() && shouldRemoveFile(entryPath, entry.name)) {
      removedBytes += removePath(entryPath);
    }
  }
  return removedBytes;
}

function pruneUnsupportedTreeSitterPrebuilds() {
  let removedBytes = 0;
  const packages = [
    path.join(nodeModules, "openclaw", "node_modules", "tree-sitter-bash", "prebuilds"),
    path.join(nodeModules, "tree-sitter-bash", "prebuilds"),
  ];
  for (const prebuildsDir of packages) {
    if (!fs.existsSync(prebuildsDir)) {
      continue;
    }
    for (const entry of fs.readdirSync(prebuildsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name.startsWith("darwin-") || entry.name.startsWith("win32-")) {
        removedBytes += removePath(path.join(prebuildsDir, entry.name));
      }
    }
  }
  return removedBytes;
}

if (!fs.existsSync(nodeModules)) {
  throw new Error(`Cannot prune missing node_modules directory at ${nodeModules}`);
}

const removedBytes = pruneDirectory(nodeModules) + pruneUnsupportedTreeSitterPrebuilds();
const removedMiB = (removedBytes / 1024 / 1024).toFixed(1);
console.log(`pruned non-runtime npm artifacts from ${nodeModules}: ${removedMiB} MiB removed`);
