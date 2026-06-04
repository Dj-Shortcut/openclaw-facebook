const { createRequire } = require('node:module');
const path = require('node:path');

const openclawCodexPackage = require.resolve('@openclaw/codex/package.json');
const openclawCodexRequire = createRequire(openclawCodexPackage);
const codexPackage = openclawCodexRequire.resolve('@openai/codex/package.json');
const codexRequire = createRequire(codexPackage);
const nativePackage = '@openai/codex-linux-x64/package.json';

try {
  codexRequire.resolve(nativePackage);
} catch (error) {
  throw new Error(
    `Missing runtime dependency ${nativePackage} required by ${path.dirname(codexPackage)}. `
    + 'Ensure npm installs optional dependencies and pruning keeps native Codex packages.',
    { cause: error },
  );
}

console.log(`verified ${nativePackage} for ${codexPackage}`);
