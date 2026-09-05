import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  assertRetirementRun,
  assertRetirementWorkflow,
  assertProtectedCleanupWorkflow,
  operatorEnvironment,
  parseFlyTokenInventory,
  parseRetirementArguments,
  retireRepairExecToken,
  retireAfterProtectedCleanup,
  readCompleteFlyTokenInventory,
} from "./retire-image-gen-repair-exec-token.mjs";
import { createMigrationSuperCleanupEvidence } from "./image-gen-migration-super-cleanup-evidence.mjs";

const reviewedWorkflow = readFileSync(
  new URL(
    "../.github/workflows/image-gen-schema-transition.yml",
    import.meta.url,
  ),
  "utf8",
);
const reviewedCleanupWorkflow = readFileSync(
  new URL(
    "../.github/workflows/cleanup-image-gen-migration-super.yml",
    import.meta.url,
  ),
  "utf8",
);
const expected = {
  runId: "123456789",
  runAttempt: "2",
  tokenId: "syntheticRepairToken123",
  secretUpdatedAt: "2026-09-04T12:00:00Z",
};
const now = Date.parse("2026-09-04T14:00:00Z");
const name = `leaderbot-pr486-repair-${expected.runId}`;
const header =
  'Tokens for app "leaderbot-portal-mysql":\n ID │ NAME │ CREATED BY │ EXPIRES AT │ REVOKED AT\n';
const row = (overrides = {}) => {
  const value = {
    id: expected.tokenId,
    name,
    creator: "operator@example.invalid",
    expires: "2026-09-04 16:00:00 +0000 UTC",
    revoked: "",
    ...overrides,
  };
  return ` ${value.id} │ ${value.name} │ ${value.creator} │ ${value.expires} │ ${value.revoked} \n`;
};
const args = () => [
  "--run-id",
  expected.runId,
  "--run-attempt",
  expected.runAttempt,
  "--token-id",
  expected.tokenId,
  "--secret-updated-at",
  expected.secretUpdatedAt,
];

function fixture() {
  const run = {
    id: Number(expected.runId),
    run_attempt: Number(expected.runAttempt),
    status: "completed",
    conclusion: "success",
    event: "workflow_dispatch",
    head_branch: "main",
    path: ".github/workflows/image-gen-schema-transition.yml",
    repository: { full_name: "Dj-Shortcut/openclaw-facebook" },
    head_repository: { full_name: "Dj-Shortcut/openclaw-facebook" },
    head_sha: "a".repeat(40),
  };
  const jobs = {
    total_count: 1,
    jobs: [
      {
        name: "Snapshot, restore-test, and apply 0017 through 0018",
        run_id: run.id,
        run_attempt: run.run_attempt,
        head_sha: run.head_sha,
        status: "completed",
        conclusion: "success",
        steps: [
          {
            name: "Revoke temporary migration SUPER privilege",
            number: 37,
            status: "completed",
            conclusion: "success",
            completed_at: "2026-09-04T13:30:00Z",
          },
        ],
      },
    ],
  };
  const latest = {
    workflow_runs: [{ id: run.id, run_attempt: run.run_attempt }],
  };
  return { run, jobs, latest };
}

function harness(options = {}) {
  const state = {
    ...fixture(),
    revoked: false,
    secret: expected.secretUpdatedAt,
    calls: [],
    ...options,
  };
  const execute = (command, argv) => {
    state.calls.push([command, [...argv]]);
    options.before?.(command, argv, state);
    if (command === "flyctl") {
      if (argv[0] === "version")
        return (
          state.version ??
          "flyctl v0.4.94 linux/amd64 Commit: test BuildDate: test\n"
        );
      if (argv[1] === "list")
        return (
          state.table ??
          header +
            row({
              ...(state.token ?? {}),
              revoked: state.revoked
                ? "2026-09-04 13:59:59.123456 +0000 UTC"
                : "",
            })
        );
      if (argv[1] === "revoke") {
        if (!state.revokeNoEffect) state.revoked = true;
        if (state.revokeThrows) throw new Error("SENSITIVE_PROVIDER_ERROR");
        return "untrusted revoke output";
      }
    }
    if (command === "gh" && argv[0] === "api") {
      const path = argv.at(-1);
      if (path.endsWith(`/actions/runs/${expected.runId}`))
        return JSON.stringify(state.run);
      if (path.includes("/jobs?")) return JSON.stringify(state.jobs);
      if (path.includes("/actions/workflows/"))
        return JSON.stringify(state.latest);
      if (path.includes("/contents/")) {
        const text = state.workflow ?? reviewedWorkflow;
        return JSON.stringify({
          encoding: "base64",
          type: "file",
          path: ".github/workflows/image-gen-schema-transition.yml",
          size: Buffer.byteLength(text),
          content: Buffer.from(text).toString("base64"),
          ...state.content,
        });
      }
      if (path.endsWith("/environments/production"))
        return JSON.stringify(
          state.environment ?? {
            name: "production",
            can_admins_bypass: false,
            deployment_branch_policy: {
              protected_branches: true,
              custom_branch_policies: false,
            },
            protection_rules: [
              { type: "required_reviewers", reviewers: [{ type: "User" }] },
            ],
          },
        );
    }
    if (command === "gh" && argv[0] === "secret") {
      if (argv[1] === "list")
        return JSON.stringify(
          state.secretList ?? [
            {
              name: "FLY_DATABASE_MIGRATION_TOKEN",
              updatedAt: expected.secretUpdatedAt,
            },
            ...(state.secret === null
              ? []
              : [
                  {
                    name: "FLY_DATABASE_REPAIR_EXEC_TOKEN",
                    updatedAt: state.secret,
                  },
                ]),
          ],
        );
      if (argv[1] === "delete") {
        if (!state.deleteNoEffect) state.secret = null;
        if (state.deleteThrows) throw new Error("SENSITIVE_PROVIDER_ERROR");
        return "";
      }
    }
    throw new Error("unexpected command");
  };
  return {
    state,
    execute,
    run: () =>
      retireRepairExecToken(expected, {
        execute,
        reviewedWorkflow,
        now: () => now,
      }),
  };
}

const mutations = (state) =>
  state.calls.filter(
    ([command, argv]) =>
      (command === "flyctl" && argv[1] === "revoke") ||
      (command === "gh" && argv[1] === "delete"),
  );

function cleanupHarness() {
  const recovery = {
    ...expected,
    runAttempt: "1",
    cleanupRunId: "123456790",
    cleanupRunAttempt: "1",
    cleanupTokenId: "syntheticCleanupToken456",
    cleanupSecretUpdatedAt: "2026-09-05T05:00:00Z",
    databaseMachineId: "abcdef12345678",
  };
  const fixedNow = Date.parse("2026-09-05T06:00:00Z");
  const sourceRun = { ...fixture().run, run_attempt: 1, conclusion: "failure" };
  const predecessorSteps = [
    ...reviewedWorkflow.matchAll(/^      - name: (.+)$/gm),
  ].map((match, index) => ({
    name: match[1],
    number: index + 1,
    status: "completed",
    conclusion: "skipped",
  }));
  const repairIndex = predecessorSteps.findIndex(
    (step) =>
      step.name ===
      "Repair and verify only the approved migration-principal rights",
  );
  predecessorSteps.forEach((step, index) => {
    if (index < repairIndex) step.conclusion = "success";
  });
  predecessorSteps[repairIndex].conclusion = "failure";
  predecessorSteps.find(
    (step) => step.name === "Revoke temporary migration SUPER privilege",
  ).conclusion = "failure";
  const cleanupRun = {
    ...sourceRun,
    id: Number(recovery.cleanupRunId),
    head_sha: "b".repeat(40),
    path: ".github/workflows/cleanup-image-gen-migration-super.yml",
    conclusion: "success",
  };
  const job = (run, name, steps) => ({
    total_count: 1,
    jobs: [
      {
        run_id: run.id,
        run_attempt: 1,
        head_sha: run.head_sha,
        name,
        status: "completed",
        conclusion: run.conclusion,
        steps,
      },
    ],
  });
  const request = {
    predecessorRunId: recovery.runId,
    predecessorRunAttempt: "1",
    predecessorHeadSha: sourceRun.head_sha,
    databaseMachineId: recovery.databaseMachineId,
    repairTokenId: recovery.tokenId,
    repairSecretUpdatedAt: recovery.secretUpdatedAt,
    cleanupTokenId: recovery.cleanupTokenId,
    cleanupSecretUpdatedAt: recovery.cleanupSecretUpdatedAt,
  };
  const evidence = createMigrationSuperCleanupEvidence({
    request,
    cleanupRun: {
      id: recovery.cleanupRunId,
      attempt: "1",
      headSha: cleanupRun.head_sha,
    },
    databaseMachineId: recovery.databaseMachineId,
    phase: "0016_expand",
    result: "temporary_super_absent",
    completedAt: "2026-09-05T05:30:00Z",
  });
  const state = {
    sourceRun,
    cleanupRun,
    evidence: structuredClone(evidence),
    calls: [],
    sourceJobs: job(
      sourceRun,
      "Snapshot, restore-test, and apply 0017 through 0018",
      predecessorSteps,
    ),
    cleanupJobs: job(
      cleanupRun,
      "Revoke only temporary migration SUPER after a pre-DDL failure",
      [...reviewedCleanupWorkflow.matchAll(/^      - name: (.+)$/gm)].map(
        (match, index) => ({
          name: match[1],
          number: index + 1,
          status: "completed",
          conclusion: "success",
        }),
      ),
    ),
    tokens: [
      {
        id: recovery.cleanupTokenId,
        name: `leaderbot-pr486-cleanup-${recovery.runId}`,
        expiresAt: Date.parse("2026-09-05T09:00:00Z"),
        revokedAt: null,
      },
    ],
    secrets: [
      {
        name: "FLY_DATABASE_REPAIR_EXEC_TOKEN",
        updatedAt: recovery.secretUpdatedAt,
      },
      {
        name: "FLY_DATABASE_CLEANUP_EXEC_TOKEN",
        updatedAt: recovery.cleanupSecretUpdatedAt,
      },
    ],
  };
  const execute = (command, argv) => {
    state.calls.push([command, argv]);
    if (command === "flyctl") {
      if (argv[0] === "version") return "flyctl v0.4.94 linux/amd64\n";
      if (argv[1] === "revoke") {
        if (!state.revokeNoEffect)
          state.tokens.find((token) => token.id === argv[2]).revokedAt =
            fixedNow;
        return "not authoritative";
      }
    }
    if (command === "gh" && argv[0] === "secret") {
      if (argv[1] === "list") return JSON.stringify(state.secrets);
      if (argv[1] === "delete") {
        if (!state.deleteNoEffect)
          state.secrets = state.secrets.filter(
            (secret) => secret.name !== argv[2],
          );
        return "";
      }
    }
    const endpoint = argv.at(-1);
    if (endpoint.endsWith(`/actions/runs/${recovery.runId}`))
      return JSON.stringify(state.sourceRun);
    if (endpoint.endsWith(`/actions/runs/${recovery.cleanupRunId}`))
      return JSON.stringify(state.cleanupRun);
    if (endpoint.includes(`/runs/${recovery.runId}/attempts/`))
      return JSON.stringify(state.sourceJobs);
    if (endpoint.includes(`/runs/${recovery.cleanupRunId}/attempts/`))
      return JSON.stringify(state.cleanupJobs);
    if (endpoint.includes("/actions/workflows/"))
      return JSON.stringify({
        workflow_runs: [
          endpoint.includes("cleanup-image")
            ? state.cleanupRun
            : state.sourceRun,
        ],
      });
    if (endpoint.includes("/contents/")) {
      const cleanup = endpoint.includes("cleanup-image");
      const text = cleanup
        ? (state.cleanupSource ?? reviewedCleanupWorkflow)
        : reviewedWorkflow;
      return JSON.stringify({
        encoding: "base64",
        type: "file",
        path: cleanup ? cleanupRun.path : sourceRun.path,
        content: Buffer.from(text).toString("base64"),
        size: Buffer.byteLength(text),
      });
    }
    if (endpoint.endsWith("/environments/production"))
      return JSON.stringify({
        name: "production",
        can_admins_bypass: false,
        deployment_branch_policy: { protected_branches: true },
        protection_rules: [{ type: "required_reviewers", reviewers: [{}] }],
      });
    if (endpoint.includes("/artifacts?"))
      return JSON.stringify({
        total_count: 1,
        artifacts: [
          {
            id: 42,
            size_in_bytes: 1024,
            name: `image-gen-migration-super-cleanup-${recovery.cleanupRunId}-1`,
            expired: false,
            digest: `sha256:${"a".repeat(64)}`,
            workflow_run: { id: cleanupRun.id, head_sha: cleanupRun.head_sha },
            ...state.artifact,
          },
        ],
      });
    throw Error("unexpected cleanup test command");
  };
  return {
    state,
    recovery,
    run: () =>
      retireAfterProtectedCleanup(recovery, {
        execute,
        reviewedWorkflow,
        reviewedCleanupWorkflow,
        readInventory: async () => structuredClone(state.tokens),
        readArtifact: () => structuredClone(state.evidence),
        now: () => fixedNow,
      }),
  };
}

describe("separate protected cleanup token retirement", () => {
  it("removes the old absent credential only after protected cleanup and explicitly revokes the fresh cleanup token", async () => {
    const h = cleanupHarness();
    await expect(h.run()).resolves.toBe(
      "repair_and_cleanup_exec_tokens_retired",
    );
    expect(h.state.secrets).toEqual([]);
    expect(mutations(h.state)).toEqual([
      [
        "gh",
        [
          "secret",
          "delete",
          "FLY_DATABASE_REPAIR_EXEC_TOKEN",
          "--repo",
          "Dj-Shortcut/openclaw-facebook",
          "--env",
          "production",
        ],
      ],
      ["flyctl", ["tokens", "revoke", h.recovery.cleanupTokenId]],
      [
        "gh",
        [
          "secret",
          "delete",
          "FLY_DATABASE_CLEANUP_EXEC_TOKEN",
          "--repo",
          "Dj-Shortcut/openclaw-facebook",
          "--env",
          "production",
        ],
      ],
    ]);
  });
  it.each([
    (h) => {
      h.state.sourceRun.run_attempt = 2;
    },
    (h) => {
      h.state.cleanupRun.conclusion = "failure";
    },
    (h) => {
      h.state.evidence.database.machineId = "11111111111111";
    },
    (h) => {
      h.state.evidence.cleanupCredential.tokenId = "wrongCleanupToken";
    },
    (h) => {
      h.state.artifact = { expired: true };
    },
    (h) => {
      h.state.cleanupSource = `${reviewedCleanupWorkflow}\n`;
    },
    (h) => {
      h.state.secrets[1].updatedAt = "2026-09-05T05:59:00Z";
    },
    (h) => {
      h.state.tokens = [];
    },
    (h) => {
      h.state.tokens[0].id = "differentCleanupToken";
    },
  ])(
    "rejects mismatched proof or replacement credentials before any mutation",
    async (mutate) => {
      const h = cleanupHarness();
      mutate(h);
      await expect(h.run()).rejects.toThrow();
      expect(mutations(h.state)).toEqual([]);
    },
  );
  it("does not equate a successful-looking revoke exit with revocation", async () => {
    const h = cleanupHarness();
    h.state.revokeNoEffect = true;
    await expect(h.run()).rejects.toThrow();
    expect(h.state.secrets.map((secret) => secret.name)).toEqual([
      "FLY_DATABASE_CLEANUP_EXEC_TOKEN",
    ]);
    h.state.revokeNoEffect = false;
    await expect(h.run()).resolves.toBe(
      "repair_and_cleanup_exec_tokens_retired",
    );
  });
  it("fails closed when secret deletion has no effect", async () => {
    const h = cleanupHarness();
    h.state.deleteNoEffect = true;
    await expect(h.run()).rejects.toThrow();
    expect(h.state.secrets).toHaveLength(2);
  });
  it.each([
    (text) =>
      text.replace("    environment: production", "    environment: preview"),
    (text) => text.replace("--operation revoke-super)", "--operation prepare)"),
    (text) =>
      text.replace("cancel-in-progress: false", "cancel-in-progress: true"),
    (text) =>
      text.replace(
        "FLY_DATABASE_CLEANUP_EXEC_TOKEN",
        "FLY_DATABASE_REPAIR_EXEC_TOKEN",
      ),
  ])(
    "rejects cleanup authority drift even against matching local bytes",
    (mutate) => {
      const text = mutate(reviewedCleanupWorkflow);
      expect(() => assertProtectedCleanupWorkflow(text, text)).toThrow();
    },
  );
});

describe("complete metadata-only Fly token inventory", () => {
  it("follows every page without requesting token values", async () => {
    const bodies = [];
    const tokens = await readCompleteFlyTokenInventory(
      () => "synthetic-auth",
      async (_url, init) => {
        const body = JSON.parse(init.body);
        bodies.push(body);
        return {
          ok: true,
          json: async () => ({
            data: {
              app: {
                name: "leaderbot-portal-mysql",
                limitedAccessTokens: {
                  nodes: [
                    {
                      id: body.variables.after ? "secondToken" : "firstToken",
                      name: "metadata",
                      expiresAt: "2026-09-05T09:00:00Z",
                      revokedAt: null,
                    },
                  ],
                  pageInfo: {
                    hasNextPage: !body.variables.after,
                    endCursor: "cursor-1",
                  },
                },
              },
            },
          }),
        };
      },
    );
    expect(tokens).toHaveLength(2);
    expect(bodies[1].variables.after).toBe("cursor-1");
    expect(bodies[0].query).not.toMatch(/\btoken\b/);
  });
  it.each([
    { errors: [{ message: "not authorized" }] },
    { data: { app: null } },
    {
      data: {
        app: {
          name: "other-app",
          limitedAccessTokens: { nodes: [], pageInfo: { hasNextPage: false } },
        },
      },
    },
  ])(
    "never turns inaccessible metadata into an empty inventory",
    async (result) => {
      await expect(
        readCompleteFlyTokenInventory(
          () => "synthetic-auth",
          async () => ({ ok: true, json: async () => result }),
        ),
      ).rejects.toThrow();
    },
  );
});

describe("repair exec token identity and authoritative inventory", () => {
  it("parses only the exact bounded app table, retaining explicit revocation", () => {
    const parsed = parseFlyTokenInventory(
      header +
        row() +
        row({
          id: "otherMigrationId",
          name: "migration-token",
          revoked: "2026-09-04 13:59:59.123456789 +0000 UTC",
        }),
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual({
      id: expected.tokenId,
      name,
      expiresAt: Date.parse("2026-09-04T16:00:00Z"),
      revokedAt: null,
    });
    expect(parsed[1].revokedAt).toBe(Date.parse("2026-09-04T13:59:59.123Z"));
  });
  it.each([
    header.replace("leaderbot-portal-mysql", "unrelated-app") + row(),
    header.replace("NAME", "Name") + row(),
    header.replaceAll("│", "|") + row(),
    header + row() + row(),
    header + row({ revoked: "false" }),
    header + row({ expires: "2026-02-31 16:00:00 +0000 UTC" }),
    header + row({ expires: "2026-09-04 16:00:00 +0200 CEST" }),
    header + row({ name: "bad │ extra" }),
    header + row({ creator: "" }),
    header + row({ id: "--all" }),
    `\x1b[0m${header}${row()}`,
    header + row() + "Warning: partial results\n",
    header + "x".repeat(1024 * 1024),
  ])("rejects malformed or ambiguous inventory", (table) => {
    expect(() => parseFlyTokenInventory(table)).toThrow(
      "repair exec token retirement rejected",
    );
  });
  it("requires exact explicit arguments including installation metadata", () => {
    expect(parseRetirementArguments(args())).toEqual(expected);
  });
  it.each(
    [
      [],
      args().slice(0, 6),
      [...args(), "--no-grant"],
      args().map((value) => (value === "--token-id" ? "--app" : value)),
      args().map((value) => (value === "--token-id" ? "--run-id" : value)),
      args().map((value) => (value === expected.runId ? "01" : value)),
      args().map((value) =>
        value === expected.runId ? "9999999999999999" : value,
      ),
      args().map((value) => (value === expected.runId ? 123456789 : value)),
      args().map((value) => (value === expected.tokenId ? "--all" : value)),
      args().map((value) =>
        value === expected.secretUpdatedAt ? "yesterday" : value,
      ),
    ].map((argv) => [argv]),
  )("rejects unsafe arguments", (argv) =>
    expect(() => parseRetirementArguments(argv)).toThrow(),
  );
});

describe("terminal protected cleanup evidence", () => {
  it("accepts a terminal failed run only when the exact cleanup succeeded", () => {
    const { run, jobs, latest } = fixture();
    run.conclusion = "failure";
    jobs.jobs[0].conclusion = "failure";
    expect(assertRetirementRun(run, jobs, latest, expected)).toBe(run.head_sha);
    expect(() =>
      assertRetirementWorkflow(reviewedWorkflow, reviewedWorkflow),
    ).not.toThrow();
  });
  it.each([
    (s) => s.run.id++,
    (s) => s.run.run_attempt++,
    (s) => {
      s.run.status = "in_progress";
    },
    (s) => {
      s.run.conclusion = null;
    },
    (s) => {
      s.run.event = "pull_request";
    },
    (s) => {
      s.run.head_branch = "codex/not-main";
    },
    (s) => {
      s.run.path = ".github/workflows/other.yml";
    },
    (s) => {
      s.run.repository.full_name = "attacker/openclaw-facebook";
    },
    (s) => {
      s.run.head_repository.full_name = "attacker/openclaw-facebook";
    },
    (s) => {
      s.run.head_sha = "not-a-sha";
    },
    (s) => s.latest.workflow_runs[0].id++,
    (s) => s.latest.workflow_runs[0].run_attempt++,
    (s) => {
      s.latest.workflow_runs = [];
    },
    (s) => s.jobs.total_count++,
    (s) => {
      s.jobs.jobs[0].name = "lookalike";
    },
    (s) => {
      s.jobs.jobs[0].run_id++;
    },
    (s) => {
      s.jobs.jobs[0].run_attempt++;
    },
    (s) => {
      s.jobs.jobs[0].head_sha = "b".repeat(40);
    },
    (s) => {
      s.jobs.jobs[0].status = "in_progress";
    },
    (s) => {
      s.jobs.jobs[0].steps = [];
    },
    (s) => {
      s.jobs.jobs[0].steps.push({ ...s.jobs.jobs[0].steps[0] });
    },
    (s) => {
      s.jobs.jobs[0].steps[0].conclusion = "skipped";
    },
    (s) => {
      s.jobs.jobs[0].steps[0].conclusion = "failure";
    },
    (s) => {
      s.jobs.jobs[0].steps[0].conclusion = "cancelled";
    },
    (s) => {
      s.jobs.jobs[0].steps[0].completed_at = null;
    },
  ])("rejects unproven run or cleanup without mutations", (mutate) => {
    const h = harness();
    mutate(h.state);
    expect(h.run).toThrow();
    expect(mutations(h.state)).toEqual([]);
  });
  it.each([
    (s) =>
      s.replace("    environment: production\n", "    environment: staging\n"),
    (s) => s.replaceAll('--operation revoke-super)"', '--operation prepare)"'),
    (s) =>
      s.replace(
        'if [[ "$cleanup_status" -eq 0 && "$output" = "credit_migration_principal_super_revoked" ]]; then',
        "if true; then",
      ),
    (s) =>
      s.replace(
        "      - name: Revoke temporary migration SUPER privilege",
        "      - name: Unverified cleanup",
      ),
    (s) =>
      s.replace(
        "      - name: Revoke temporary migration SUPER privilege\n",
        "      - name: Revoke temporary migration SUPER privilege\n        continue-on-error: true\n",
      ),
  ])(
    "rejects cleanup-source drift even against a matching local file",
    (mutate) => {
      const changed = mutate(reviewedWorkflow);
      expect(() => assertRetirementWorkflow(changed, changed)).toThrow();
    },
  );
  it("requires the reviewed checkout to match the executed workflow exactly", () => {
    expect(() =>
      assertRetirementWorkflow(`${reviewedWorkflow}\n`, reviewedWorkflow),
    ).toThrow();
  });
});

describe("verified ordered retirement with retry-safe secret metadata", () => {
  it("revokes only the exact Fly token, verifies it, then deletes only the exact environment secret", () => {
    const h = harness();
    expect(h.run()).toBe("repair_exec_token_retired");
    expect(mutations(h.state)).toEqual([
      ["flyctl", ["tokens", "revoke", expected.tokenId]],
      [
        "gh",
        [
          "secret",
          "delete",
          "FLY_DATABASE_REPAIR_EXEC_TOKEN",
          "--repo",
          "Dj-Shortcut/openclaw-facebook",
          "--env",
          "production",
        ],
      ],
    ]);
    const revoke = h.state.calls.findIndex(([, argv]) => argv[1] === "revoke");
    const deletion = h.state.calls.findIndex(
      ([, argv]) => argv[1] === "delete",
    );
    expect(
      h.state.calls
        .slice(revoke + 1, deletion)
        .some(([command, argv]) => command === "flyctl" && argv[1] === "list"),
    ).toBe(true);
    expect(h.state.calls.at(-1)[1].slice(0, 2)).toEqual(["secret", "list"]);
  });
  it.each([
    { revoked: true },
    { secret: null },
    { revoked: true, secret: null },
    { revokeThrows: true },
    { deleteThrows: true },
  ])("retries partial or uncertain completion using readback", (options) => {
    const h = harness(options);
    expect(h.run()).toBe("repair_exec_token_retired");
    expect(h.state.revoked).toBe(true);
    expect(h.state.secret).toBe(null);
    if (options.revoked)
      expect(mutations(h.state).some(([command]) => command === "flyctl")).toBe(
        false,
      );
    if (options.secret === null)
      expect(mutations(h.state).some(([command]) => command === "gh")).toBe(
        false,
      );
  });
  it.each([
    { version: "flyctl v0.4.95 linux/amd64\n" },
    { token: { name: "production-migration-token" } },
    { token: { name: "production-deploy-token" } },
    { token: { id: "unrelated-token-id" } },
    { token: { expires: "2036-09-04 16:00:00 +0000 UTC" } },
    { table: header },
    { table: header + row() + row({ id: "duplicateNameId" }) },
    { secret: "2026-09-04T13:59:00Z" },
    { workflow: `${reviewedWorkflow}\n` },
    { environment: { name: "production" } },
    { content: { encoding: "utf8" } },
    { content: { path: ".github/workflows/other.yml" } },
    { content: { size: 1024 * 1024 + 1 } },
    {
      secretList: [
        {
          name: "FLY_DATABASE_REPAIR_EXEC_TOKEN",
          updatedAt: expected.secretUpdatedAt,
        },
        {
          name: "FLY_DATABASE_REPAIR_EXEC_TOKEN",
          updatedAt: expected.secretUpdatedAt,
        },
      ],
    },
  ])(
    "preserves access and secrets when identity or evidence is uncertain",
    (options) => {
      const h = harness(options);
      expect(h.run).toThrow();
      expect(mutations(h.state)).toEqual([]);
    },
  );
  it("does not trust a zero-exit revoke command without revokedAt readback", () => {
    const h = harness({ revokeNoEffect: true });
    expect(h.run).toThrow();
    expect(mutations(h.state)).toEqual([
      ["flyctl", ["tokens", "revoke", expected.tokenId]],
    ]);
    expect(h.state.secret).toBe(expected.secretUpdatedAt);
  });
  it("leaves the secret in place after failed revocation and retries successfully", () => {
    const h = harness({ revokeNoEffect: true, revokeThrows: true });
    expect(h.run).toThrow();
    h.state.revokeNoEffect = false;
    h.state.revokeThrows = false;
    expect(h.run()).toBe("repair_exec_token_retired");
  });
  it("retries failed secret deletion without revoking again", () => {
    const h = harness({ deleteNoEffect: true, deleteThrows: true });
    expect(h.run).toThrow();
    expect(h.state.revoked).toBe(true);
    expect(h.state.secret).toBe(expected.secretUpdatedAt);
    h.state.calls = [];
    h.state.deleteNoEffect = false;
    h.state.deleteThrows = false;
    expect(h.run()).toBe("repair_exec_token_retired");
    expect(mutations(h.state).map(([command]) => command)).toEqual(["gh"]);
  });
  it("never deletes a replacement secret after a partial-failure retry", () => {
    const h = harness({ revoked: true, secret: "2026-09-04T14:00:00Z" });
    expect(h.run).toThrow();
    expect(mutations(h.state)).toEqual([]);
  });
  it("rechecks the exact run immediately before revocation", () => {
    let runReads = 0;
    const h = harness({
      before(command, argv, state) {
        if (
          command === "gh" &&
          argv.at(-1).endsWith(`/actions/runs/${expected.runId}`) &&
          ++runReads === 2
        )
          state.run.run_attempt++;
      },
    });
    expect(h.run).toThrow();
    expect(mutations(h.state)).toEqual([]);
  });
  it("preserves a replacement secret observed after revocation", () => {
    const h = harness({
      before(command, argv, state) {
        if (command === "flyctl" && argv[1] === "revoke")
          state.secret = "2026-09-04T14:00:00Z";
      },
    });
    expect(h.run).toThrow();
    expect(mutations(h.state).map(([command]) => command)).toEqual(["flyctl"]);
  });
});

describe("operator-only metadata output", () => {
  it("forwards only local operator runtime paths, never workflow tokens or secrets", () => {
    expect(
      operatorEnvironment({
        PATH: "/bin",
        HOME: "/home/operator",
        GH_TOKEN: "secret",
        GITHUB_TOKEN: "secret",
        FLY_API_TOKEN: "secret",
        DATABASE_URL: "secret",
        GH_HOST: "attacker.example",
        NODE_OPTIONS: "malicious",
      }),
    ).toEqual({
      PATH: "/bin",
      HOME: "/home/operator",
      NO_COLOR: "1",
      GH_PROMPT_DISABLED: "1",
    });
    expect(() => operatorEnvironment({ GITHUB_ACTIONS: "true" })).toThrow();
  });
  it.each([[], [...args(), "--no-grant"], args()].map((argv) => [argv]))(
    "CLI failures expose only a fixed marker and never invoke provider mutations",
    (argv) => {
      const result = spawnSync(
        process.execPath,
        [
          fileURLToPath(
            new URL(
              "./retire-image-gen-repair-exec-token.mjs",
              import.meta.url,
            ),
          ),
          ...argv,
        ],
        {
          encoding: "utf8",
          env: {
            PATH: "/nonexistent",
            GITHUB_ACTIONS: "true",
            FLY_API_TOKEN: "SENSITIVE_SYNTHETIC_TOKEN",
            GH_TOKEN: "SENSITIVE_SYNTHETIC_TOKEN",
          },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("repair_exec_token_retirement_failed\n");
      expect(result.stderr).toBe("");
    },
  );
});
