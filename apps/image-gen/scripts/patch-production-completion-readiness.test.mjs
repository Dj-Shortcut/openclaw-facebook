import { describe, expect, it } from "vitest";

import { patchCompletionReadinessBundle } from "./patch-production-completion-readiness.mjs";

const vulnerable = `async function findLegacyCompletionKeys(redis, limit) {
  for (const prefix of [GENERATION_COMPLETION_SCOPE, GENERATION_COMPLETION_USER_INDEX_SCOPE]) {
      for (const key of keys) {
        if (!key.startsWith(\`${"${prefix}"}:{mgc:\`)) unsafe.push(key);
        if (unsafe.length >= limit) return unsafe;
      }
  }
}`;

describe("production completion readiness hotfix", () => {
  it("skips the nested canonical user index only during the broad scan", () => {
    const patched = patchCompletionReadinessBundle(vulnerable);

    expect(patched).toContain("prefix === GENERATION_COMPLETION_SCOPE");
    expect(patched).toContain(
      "key.startsWith(`${GENERATION_COMPLETION_USER_INDEX_SCOPE}:`)",
    );
    expect(patched).toContain(
      "if (!key.startsWith(`${prefix}:{mgc:`)) unsafe.push(key)",
    );
  });

  it("fails closed when the production bundle does not match exactly", () => {
    expect(() => patchCompletionReadinessBundle("unexpected bundle")).toThrow(
      "found 0",
    );
  });
});
