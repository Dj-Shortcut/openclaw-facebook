const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { TARGETS } = require('./codex-targets.cjs');

const target = TARGETS[`${process.platform}:${process.arch}`];
if (!target) {
  throw new Error(`Unsupported Codex runtime platform for Fly gateway: ${process.platform}/${process.arch}`);
}

const openclawCodexPackage = require.resolve('@openclaw/codex/package.json');
const openclawCodexRequire = createRequire(openclawCodexPackage);
const codexPackage = openclawCodexRequire.resolve('@openai/codex/package.json');
const codexRequire = createRequire(codexPackage);
const nativePackage = `${target.packageName}/package.json`;
let nativePackageJson;

try {
  nativePackageJson = codexRequire.resolve(nativePackage);
} catch (error) {
  throw new Error(
    `Missing runtime dependency ${nativePackage} required by ${path.dirname(codexPackage)}. `
    + 'Ensure npm installs optional dependencies and pruning keeps native Codex packages.',
    { cause: error },
  );
}

const nativeBinary = path.join(
  path.dirname(nativePackageJson),
  'vendor',
  target.triple,
  'bin',
  target.executable,
);

if (!fs.existsSync(nativeBinary)) {
  throw new Error(
    `Missing Codex native executable at ${nativeBinary}. `
    + 'Ensure the platform package vendor payload is installed before deploying.',
  );
}

try {
  fs.accessSync(nativeBinary, fs.constants.X_OK);
} catch (error) {
  throw new Error(
    `Codex native executable at ${nativeBinary} exists but is not executable. `
    + 'Ensure the platform package preserves file permissions.',
    { cause: error },
  );
}

console.log(`verified ${nativePackage} and ${nativeBinary} for ${codexPackage}`);
