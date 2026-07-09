import fs from "node:fs";
import path from "node:path";

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

function resolveNodeModulesPath(appRoot) {
  return path.join(appRoot, "node_modules");
}

function relativeNodeModulesParts(nodeModulesRoot, targetPath) {
  const relative = path.relative(nodeModulesRoot, targetPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return relative.split(path.sep);
}

function isInsideNodeModules(nodeModulesRoot, filePath) {
  return relativeNodeModulesParts(nodeModulesRoot, filePath) !== null;
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

function removePath(nodeModulesRoot, targetPath) {
  if (!isInsideNodeModules(nodeModulesRoot, targetPath)) {
    throw new Error(`Refusing to remove path outside node_modules: ${targetPath}`);
  }
  const size = pathSize(targetPath);
  fs.rmSync(targetPath, { recursive: true, force: true });
  return size;
}

function shouldRemoveFile(name) {
  if (removableFileNames.has(name)) {
    return true;
  }
  if (removableFileSuffixes.some((suffix) => name.endsWith(suffix))) {
    return true;
  }
  return false;
}

function isProtectedRuntimePackage(nodeModulesRoot, directory) {
  const parts = relativeNodeModulesParts(nodeModulesRoot, directory);
  if (!parts) {
    return false;
  }
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (parts[index] !== "@openai") {
      continue;
    }
    const packageName = parts[index + 1];
    if (packageName === "codex" || packageName.startsWith("codex-")) {
      return true;
    }
  }
  return false;
}

function isProtectedRuntimeDirectory(nodeModulesRoot, directory) {
  const parts = relativeNodeModulesParts(nodeModulesRoot, directory);
  if (!parts) {
    return false;
  }
  const lastIndex = parts.length - 1;
  if (
    parts[0] === "openclaw" &&
    parts[1] === "docs" &&
    (parts.length === 2 ||
      (parts[2] === "reference" && (parts.length === 3 || parts[3] === "templates")))
  ) {
    return true;
  }

  if (
    parts[lastIndex] === "templates" &&
    parts[lastIndex - 1] === "agents" &&
    parts[lastIndex - 2] === "src" &&
    parts[lastIndex - 3] === "openclaw"
  ) {
    return true;
  }

  return (
    parts[lastIndex] === "doc" &&
    parts[lastIndex - 1] === "dist" &&
    parts[lastIndex - 2] === "yaml"
  );
}

function pruneDirectory(nodeModulesRoot, directory) {
  if (isProtectedRuntimePackage(nodeModulesRoot, directory)) {
    return 0;
  }
  let removedBytes = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (
        removableDirectoryNames.has(entry.name) &&
        !isProtectedRuntimeDirectory(nodeModulesRoot, entryPath)
      ) {
        removedBytes += removePath(nodeModulesRoot, entryPath);
        continue;
      }
      removedBytes += pruneDirectory(nodeModulesRoot, entryPath);
      continue;
    }
    if (entry.isFile() && shouldRemoveFile(entry.name)) {
      removedBytes += removePath(nodeModulesRoot, entryPath);
    }
  }
  return removedBytes;
}

function pruneUnsupportedTreeSitterPrebuilds(nodeModulesRoot) {
  let removedBytes = 0;
  const packages = [
    path.join(nodeModulesRoot, "openclaw", "node_modules", "tree-sitter-bash", "prebuilds"),
    path.join(nodeModulesRoot, "tree-sitter-bash", "prebuilds"),
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
        removedBytes += removePath(nodeModulesRoot, path.join(prebuildsDir, entry.name));
      }
    }
  }
  return removedBytes;
}

export function pruneImageDependencies(appRoot) {
  const nodeModulesRoot = resolveNodeModulesPath(appRoot);
  if (!fs.existsSync(nodeModulesRoot)) {
    throw new Error(`Cannot prune missing node_modules directory at ${nodeModulesRoot}`);
  }
  return {
    nodeModules: nodeModulesRoot,
    removedBytes:
      pruneDirectory(nodeModulesRoot, nodeModulesRoot) +
      pruneUnsupportedTreeSitterPrebuilds(nodeModulesRoot),
  };
}
