import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const pruneScript = join(repoRoot, 'deploy/fly-gateway/bin/prune-image-deps.mjs');
const codexTargetsSource = join(repoRoot, 'deploy/fly-gateway/bin/codex-targets.cjs');
const verifyScriptSource = join(repoRoot, 'deploy/fly-gateway/bin/verify-codex-native-deps.cjs');
const ensureScriptSource = join(repoRoot, 'deploy/fly-gateway/bin/ensure-codex-native-deps.cjs');

const tempDirs = [];

function makeTempApp() {
  const appRoot = mkdtempSync(join(tmpdir(), 'openclaw-prune-'));
  tempDirs.push(appRoot);
  return appRoot;
}

function writeFixtureFile(appRoot, relativePath, content = 'fixture') {
  const target = join(appRoot, relativePath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  return target;
}

function codexTargetsFixture() {
  const source = readFileSync(codexTargetsSource, 'utf8');
  const hostTargetKey = `${process.platform}:${process.arch}`;
  if (source.includes(`'${hostTargetKey}'`)) {
    return source;
  }
  return `const TARGETS = {
  '${hostTargetKey}': {
    packageName: '@openai/codex-linux-x64',
    triple: 'x86_64-unknown-linux-musl',
    executable: 'codex',
  },
};

module.exports = { TARGETS };
`;
}

function writeFixtureScript(appRoot, scriptPath, sourcePath) {
  writeFixtureFile(appRoot, 'deploy/fly-gateway/bin/codex-targets.cjs', codexTargetsFixture());
  writeFileSync(scriptPath, readFileSync(sourcePath));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Fly gateway image dependency pruning', () => {
  it('keeps native Codex runtime packages while pruning ordinary docs', () => {
    const appRoot = makeTempApp();
    writeFixtureFile(appRoot, 'node_modules/plain-package/docs/readme.md');
    writeFixtureFile(appRoot, 'node_modules/@openclaw/codex/node_modules/@openai/codex/package.json', '{"name":"@openai/codex"}');
    writeFixtureFile(appRoot, 'node_modules/@openclaw/codex/node_modules/@openai/codex/docs/loader-notes.md');
    writeFixtureFile(appRoot, 'node_modules/@openclaw/codex/node_modules/@openai/codex-linux-x64/package.json', '{"name":"@openai/codex-linux-x64"}');
    writeFixtureFile(appRoot, 'node_modules/@openclaw/codex/node_modules/@openai/codex-linux-x64/docs/native-notes.md');

    const result = spawnSync(process.execPath, [pruneScript, appRoot], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(() => readFileSync(join(appRoot, 'node_modules/plain-package/docs/readme.md'))).toThrow();
    expect(readFileSync(join(appRoot, 'node_modules/@openclaw/codex/node_modules/@openai/codex/docs/loader-notes.md'), 'utf8')).toBe('fixture');
    expect(readFileSync(join(appRoot, 'node_modules/@openclaw/codex/node_modules/@openai/codex-linux-x64/docs/native-notes.md'), 'utf8')).toBe('fixture');
  });

  it('verifies the Codex Linux native package from the runtime app root', () => {
    const appRoot = makeTempApp();
    const verifyScript = join(appRoot, 'deploy/fly-gateway/bin/verify-codex-native-deps.cjs');
    writeFixtureFile(appRoot, 'deploy/fly-gateway/bin/.keep');
    writeFixtureScript(appRoot, verifyScript, verifyScriptSource);
    writeFixtureFile(appRoot, 'node_modules/@openclaw/codex/package.json', '{"name":"@openclaw/codex"}');
    writeFixtureFile(appRoot, 'node_modules/@openclaw/codex/node_modules/@openai/codex/package.json', '{"name":"@openai/codex"}');
    writeFixtureFile(appRoot, 'node_modules/@openclaw/codex/node_modules/@openai/codex-linux-x64/package.json', '{"name":"@openai/codex-linux-x64"}');
    chmodSync(writeFixtureFile(appRoot, 'node_modules/@openclaw/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'), 0o755);

    const result = spawnSync(process.execPath, [verifyScript], {
      cwd: appRoot,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('verified @openai/codex-linux-x64/package.json');
    expect(result.stdout.replaceAll('\\', '/')).toContain('vendor/x86_64-unknown-linux-musl/bin/codex');
  });

  it('rejects a Codex native package without the Linux executable payload', () => {
    const appRoot = makeTempApp();
    const verifyScript = join(appRoot, 'deploy/fly-gateway/bin/verify-codex-native-deps.cjs');
    writeFixtureFile(appRoot, 'deploy/fly-gateway/bin/.keep');
    writeFixtureScript(appRoot, verifyScript, verifyScriptSource);
    writeFixtureFile(appRoot, 'node_modules/@openclaw/codex/package.json', '{"name":"@openclaw/codex"}');
    writeFixtureFile(appRoot, 'node_modules/@openclaw/codex/node_modules/@openai/codex/package.json', '{"name":"@openai/codex"}');
    writeFixtureFile(appRoot, 'node_modules/@openclaw/codex/node_modules/@openai/codex-linux-x64/package.json', '{"name":"@openai/codex-linux-x64"}');

    const result = spawnSync(process.execPath, [verifyScript], {
      cwd: appRoot,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Missing Codex native executable');
  });

  it('accepts an already installed Codex native runtime in the repair script', () => {
    const appRoot = makeTempApp();
    const ensureScript = join(appRoot, 'deploy/fly-gateway/bin/ensure-codex-native-deps.cjs');
    writeFixtureFile(appRoot, 'deploy/fly-gateway/bin/.keep');
    writeFixtureScript(appRoot, ensureScript, ensureScriptSource);
    writeFixtureFile(appRoot, 'node_modules/@openclaw/codex/package.json', '{"name":"@openclaw/codex"}');
    writeFixtureFile(appRoot, 'node_modules/@openclaw/codex/node_modules/@openai/codex/package.json', '{"name":"@openai/codex","optionalDependencies":{"@openai/codex-linux-x64":"npm:@openai/codex@0.0.0-linux-x64"}}');
    writeFixtureFile(appRoot, 'node_modules/@openclaw/codex/node_modules/@openai/codex-linux-x64/package.json', '{"name":"@openai/codex-linux-x64"}');
    chmodSync(writeFixtureFile(appRoot, 'node_modules/@openclaw/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex'), 0o755);

    const result = spawnSync(process.execPath, [ensureScript], {
      cwd: appRoot,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Codex native runtime already present: @openai/codex-linux-x64');
  });
});
