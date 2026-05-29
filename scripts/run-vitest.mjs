import { spawnSync } from 'node:child_process';

const nodeOptions = process.env.NODE_OPTIONS?.trim();
process.env.NODE_OPTIONS = nodeOptions
  ? `${nodeOptions} --import=./vitest.node-polyfill.mjs`
  : '--import=./vitest.node-polyfill.mjs';

const result = spawnSync('vitest', ['run', '--exclude', 'apps/**'], {
  stdio: 'inherit',
  shell: true,
  env: process.env,
});

if (result.error) {
  throw result.error;
}

process.exit(result.status ?? 1);
