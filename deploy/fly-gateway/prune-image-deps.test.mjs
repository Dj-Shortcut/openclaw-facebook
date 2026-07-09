import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { pruneImageDependencies } from './bin/prune-image-deps-core.mjs';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const dockerfile = join(repoRoot, 'deploy/fly-gateway/Dockerfile');
const pruneScript = join(repoRoot, 'deploy/fly-gateway/bin/prune-image-deps.mjs');
const codexTargetsSource = join(repoRoot, 'deploy/fly-gateway/bin/codex-targets.cjs');
const validateOpenClawRuntimeScript = join(repoRoot, 'scripts/validate-openclaw-runtime.mjs');
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

function writeOpenClawTemplateFixture(appRoot) {
  writeFixtureFile(appRoot, 'node_modules/openclaw/src/agents/templates/HEARTBEAT.md', '# Heartbeat\n');
  for (const fileName of ['AGENTS.md', 'SOUL.md', 'TOOLS.md', 'IDENTITY.md', 'USER.md', 'BOOTSTRAP.md']) {
    writeFixtureFile(
      appRoot,
      `node_modules/openclaw/docs/reference/templates/${fileName}`,
      `# ${fileName}\n`,
    );
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('Fly gateway image dependency pruning', () => {
  it('copies the prune core before invoking the prune CLI in the gateway image build', () => {
    const source = readFileSync(dockerfile, 'utf8');
    const coreCopyIndex = source.indexOf(
      'COPY deploy/fly-gateway/bin/prune-image-deps-core.mjs ./deploy/fly-gateway/bin/prune-image-deps-core.mjs',
    );
    const pruneRunIndex = source.indexOf(
      'node ./deploy/fly-gateway/bin/prune-image-deps.mjs /app',
    );

    expect(coreCopyIndex).toBeGreaterThanOrEqual(0);
    expect(pruneRunIndex).toBeGreaterThan(coreCopyIndex);
  });

  it('prunes removable files through the importable API', () => {
    const appRoot = makeTempApp();
    writeFixtureFile(appRoot, 'node_modules/plain-package/index.js');
    writeFixtureFile(appRoot, 'node_modules/plain-package/.DS_Store');
    writeFixtureFile(appRoot, 'node_modules/plain-package/dist/bundle.js.map');
    writeFixtureFile(appRoot, 'node_modules/plain-package/tsconfig.tsbuildinfo');

    const result = pruneImageDependencies(appRoot);

    expect(result.removedBytes).toBeGreaterThan(0);
    expect(readFileSync(join(appRoot, 'node_modules/plain-package/index.js'), 'utf8')).toBe(
      'fixture',
    );
    expect(() => readFileSync(join(appRoot, 'node_modules/plain-package/.DS_Store'))).toThrow();
    expect(() =>
      readFileSync(join(appRoot, 'node_modules/plain-package/dist/bundle.js.map')),
    ).toThrow();
    expect(() =>
      readFileSync(join(appRoot, 'node_modules/plain-package/tsconfig.tsbuildinfo')),
    ).toThrow();
  });

  it('prunes dependency artifacts through the importable API', () => {
    const appRoot = makeTempApp();
    const nodeModules = join(appRoot, 'node_modules');
    writeFixtureFile(appRoot, 'node_modules/plain-package/docs/readme.md');
    writeFixtureFile(appRoot, 'node_modules/tree-sitter-bash/prebuilds/darwin-arm64/parser.node');
    writeFixtureFile(appRoot, 'node_modules/tree-sitter-bash/prebuilds/linux-x64/parser.node');

    const result = pruneImageDependencies(appRoot);

    expect(result.nodeModules).toBe(nodeModules);
    expect(result.removedBytes).toBeGreaterThan(0);
    expect(() => readFileSync(join(appRoot, 'node_modules/plain-package/docs/readme.md'))).toThrow();
    expect(() =>
      readFileSync(join(appRoot, 'node_modules/tree-sitter-bash/prebuilds/darwin-arm64/parser.node')),
    ).toThrow();
    expect(
      readFileSync(
        join(appRoot, 'node_modules/tree-sitter-bash/prebuilds/linux-x64/parser.node'),
        'utf8',
      ),
    ).toBe('fixture');
  });

  it('keeps protected runtime paths through the importable API', () => {
    const appRoot = makeTempApp();
    writeFixtureFile(appRoot, 'node_modules/plain-package/docs/readme.md');
    writeFixtureFile(appRoot, 'node_modules/@openclaw/codex/node_modules/@openai/codex/docs/loader-notes.md');
    writeFixtureFile(appRoot, 'node_modules/@openclaw/codex/node_modules/@openai/codex-linux-x64/docs/native-notes.md');
    writeFixtureFile(appRoot, 'node_modules/openclaw/node_modules/yaml/dist/doc/directives.js');
    writeOpenClawTemplateFixture(appRoot);

    const result = pruneImageDependencies(appRoot);

    expect(result.removedBytes).toBeGreaterThan(0);
    expect(() => readFileSync(join(appRoot, 'node_modules/plain-package/docs/readme.md'))).toThrow();
    expect(readFileSync(join(appRoot, 'node_modules/@openclaw/codex/node_modules/@openai/codex/docs/loader-notes.md'), 'utf8')).toBe('fixture');
    expect(readFileSync(join(appRoot, 'node_modules/@openclaw/codex/node_modules/@openai/codex-linux-x64/docs/native-notes.md'), 'utf8')).toBe('fixture');
    expect(readFileSync(join(appRoot, 'node_modules/openclaw/node_modules/yaml/dist/doc/directives.js'), 'utf8')).toBe('fixture');
    expect(
      readFileSync(
        join(appRoot, 'node_modules/openclaw/src/agents/templates/HEARTBEAT.md'),
        'utf8',
      ),
    ).toBe('# Heartbeat\n');
  });

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

  it('keeps yaml dist doc runtime modules while pruning ordinary doc directories', () => {
    const appRoot = makeTempApp();
    writeFixtureFile(appRoot, 'node_modules/plain-package/doc/readme.md');
    writeFixtureFile(
      appRoot,
      'node_modules/openclaw/node_modules/yaml/dist/compose/composer.js',
      "require('../doc/directives.js');\n",
    );
    writeFixtureFile(
      appRoot,
      'node_modules/openclaw/node_modules/yaml/dist/doc/directives.js',
      'module.exports = {};\n',
    );
    writeFixtureFile(
      appRoot,
      'node_modules/openclaw/node_modules/yaml/dist/doc/Document.js',
      'module.exports = {};\n',
    );

    const result = spawnSync(process.execPath, [pruneScript, appRoot], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(() => readFileSync(join(appRoot, 'node_modules/plain-package/doc/readme.md'))).toThrow();
    expect(
      readFileSync(
        join(appRoot, 'node_modules/openclaw/node_modules/yaml/dist/doc/directives.js'),
        'utf8',
      ),
    ).toBe('module.exports = {};\n');
    expect(
      readFileSync(
        join(appRoot, 'node_modules/openclaw/node_modules/yaml/dist/compose/composer.js'),
        'utf8',
      ),
    ).toContain("../doc/directives.js");
  });

  it('keeps OpenClaw runtime workspace templates while pruning ordinary docs', () => {
    const appRoot = makeTempApp();
    writeFixtureFile(appRoot, 'node_modules/plain-package/docs/readme.md');
    writeOpenClawTemplateFixture(appRoot);
    const pruneResult = spawnSync(process.execPath, [pruneScript, appRoot], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });

    expect(pruneResult.stderr).toBe('');
    expect(pruneResult.status).toBe(0);
    expect(() => readFileSync(join(appRoot, 'node_modules/plain-package/docs/readme.md'))).toThrow();
    expect(
      readFileSync(
        join(appRoot, 'node_modules/openclaw/src/agents/templates/HEARTBEAT.md'),
        'utf8',
      ),
    ).toBe('# Heartbeat\n');
    expect(
      readFileSync(
        join(appRoot, 'node_modules/openclaw/docs/reference/templates/SOUL.md'),
        'utf8',
      ),
    ).toBe('# SOUL.md\n');
    expect(
      readFileSync(
        join(appRoot, 'node_modules/openclaw/docs/reference/templates/IDENTITY.md'),
        'utf8',
      ),
    ).toBe('# IDENTITY.md\n');
  });

  it('validates the gateway runtime contract without patching installed packages', () => {
    const appRoot = makeTempApp();
    writeFixtureFile(appRoot, 'package.json', '{"name":"runtime-fixture"}');
    writeFixtureFile(appRoot, 'node_modules/openclaw/package.json', '{"name":"openclaw","version":"2026.6.6"}');
    writeFixtureFile(appRoot, 'node_modules/openclaw/openclaw.mjs', '#!/usr/bin/env node\n');
    writeOpenClawTemplateFixture(appRoot);
    writeFixtureFile(appRoot, 'node_modules/@openclaw/codex/package.json', '{"name":"@openclaw/codex","version":"2026.6.6"}');
    writeFixtureFile(appRoot, 'node_modules/@dj-shortcut/facebook/package.json', '{"name":"@dj-shortcut/facebook","version":"2026.6.6"}');
    writeFixtureFile(appRoot, 'node_modules/@dj-shortcut/facebook/dist/index.js');
    writeFixtureFile(appRoot, 'node_modules/@dj-shortcut/facebook/dist/setup-entry.js');
    writeFixtureFile(appRoot, 'node_modules/@dj-shortcut/facebook/openclaw.plugin.json', '{}');

    const result = spawnSync(
      process.execPath,
      [validateOpenClawRuntimeScript, appRoot, '--gateway'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          EXPECTED_OPENCLAW_VERSION: '2026.6.6',
          NODE_OPTIONS: '',
        },
      },
    );

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      mode: 'gateway',
      openclawVersion: '2026.6.6',
    });
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

});
