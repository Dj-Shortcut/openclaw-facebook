const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

const TARGETS = {
  'linux:x64': {
    packageName: '@openai/codex-linux-x64',
    triple: 'x86_64-unknown-linux-musl',
    executable: 'codex',
  },
  'linux:arm64': {
    packageName: '@openai/codex-linux-arm64',
    triple: 'aarch64-unknown-linux-musl',
    executable: 'codex',
  },
};

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

console.log(`verified ${nativePackage} and ${nativeBinary} for ${codexPackage}`);
