const { execFileSync } = require('node:child_process');
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

function resolveCodexPackage() {
  const openclawCodexPackage = require.resolve('@openclaw/codex/package.json');
  const openclawCodexRequire = createRequire(openclawCodexPackage);
  return openclawCodexRequire.resolve('@openai/codex/package.json');
}

function getRuntimeTarget() {
  const target = TARGETS[`${process.platform}:${process.arch}`];
  if (!target) {
    throw new Error(`Unsupported Codex runtime platform for Fly gateway: ${process.platform}/${process.arch}`);
  }
  return target;
}

function resolveNativePackage(codexPackage, packageName) {
  const codexRequire = createRequire(codexPackage);
  try {
    return codexRequire.resolve(`${packageName}/package.json`);
  } catch {
    return null;
  }
}

function nativeBinaryPath(nativePackageJson, target) {
  return path.join(
    path.dirname(nativePackageJson),
    'vendor',
    target.triple,
    'bin',
    target.executable,
  );
}

function hasNativeRuntime(codexPackage, target) {
  const nativePackageJson = resolveNativePackage(codexPackage, target.packageName);
  if (!nativePackageJson) {
    return false;
  }
  return fs.existsSync(nativeBinaryPath(nativePackageJson, target));
}

function nativeInstallSpec(codexPackageJson, target) {
  const codexManifest = JSON.parse(fs.readFileSync(codexPackageJson, 'utf8'));
  const optionalSpec = codexManifest.optionalDependencies?.[target.packageName];
  return optionalSpec ? `${target.packageName}@${optionalSpec}` : target.packageName;
}

const codexPackage = resolveCodexPackage();
const codexRoot = path.dirname(codexPackage);
const target = getRuntimeTarget();

if (hasNativeRuntime(codexPackage, target)) {
  console.log(`Codex native runtime already present: ${target.packageName}`);
  process.exit(0);
}

const installSpec = nativeInstallSpec(codexPackage, target);
console.warn(`Installing missing Codex native runtime ${target.packageName} into ${codexRoot}`);
execFileSync(
  'npm',
  [
    'install',
    '--prefix',
    codexRoot,
    '--omit=dev',
    '--include=optional',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--no-save',
    installSpec,
  ],
  { stdio: 'inherit' },
);

if (!hasNativeRuntime(codexPackage, target)) {
  throw new Error(
    `Failed to install Codex native runtime ${target.packageName}; expected binary under vendor/${target.triple}/bin/${target.executable}`,
  );
}

console.log(`Installed Codex native runtime: ${target.packageName}`);
