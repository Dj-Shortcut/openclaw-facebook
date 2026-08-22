import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const checker = path.join(repositoryRoot, "scripts/check-product-boundaries.mjs");

test("a new root adapter cannot expand the Leaderbot boundary", () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "product-boundary-"));
  try {
    fs.mkdirSync(path.join(fixture, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(fixture, "src/leaderbot-bridge.ts"),
      "export const bridge = 'leaderbot';\n"
    );
    execFileSync(process.execPath, [checker], { cwd: fixture, stdio: "pipe" });

    fs.writeFileSync(
      path.join(fixture, "src/new-answer-adapter.ts"),
      "export const unsafe = 'LEADERBOT_NEW_ADAPTER';\n"
    );
    const rejected = spawnSync(process.execPath, [checker], {
      cwd: fixture,
      encoding: "utf8",
    });
    assert.notEqual(rejected.status, 0);
    assert.match(
      rejected.stderr,
      /root src\/ may mention leaderbot\/LEADERBOT_ only/
    );
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
