import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const pruneScript = join(repoRoot, 'deploy/fly-gateway/bin/prune-image-deps.mjs');
const verifyScriptSource = join(repoRoot, 'deploy/fly-gateway/bin/verify-codex-native-deps.cjs');

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
    writeFileSync(verifyScript, readFileSync(verifyScriptSource));
    writeFixtureFile(appRoot, 'node_modules/@openclaw/codex/package.json', '{"name":"@openclaw/codex"}');
    writeFixtureFile(appRoot, 'node_modules/@openclaw/codex/node_modules/@openai/codex/package.json', '{"name":"@openai/codex"}');
    writeFixtureFile(appRoot, 'node_modules/@openclaw/codex/node_modules/@openai/codex-linux-x64/package.json', '{"name":"@openai/codex-linux-x64"}');

    const result = spawnSync(process.execPath, [verifyScript], {
      cwd: appRoot,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('verified @openai/codex-linux-x64/package.json');
  });
});
