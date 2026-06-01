import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const nodeOptions = process.env.NODE_OPTIONS?.trim();
process.env.NODE_OPTIONS = nodeOptions
  ? `${nodeOptions} --import=./vitest.node-polyfill.mjs`
  : '--import=./vitest.node-polyfill.mjs';

const vitestBin = join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'vitest.cmd' : 'vitest'
);

const result = spawnSync(
  vitestBin,
  [
    'run',
    '--exclude',
    'apps/**',
    '--exclude',
    '.worktrees/**',
    '--exclude',
    '.tmp-npm-pack/**',
  ],
  {
  stdio: 'inherit',
  shell: true,
  env: process.env,
  }
);

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
