import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  MIGRATION_SUPER_CLEANUP_EVIDENCE_TYPE,
  MIGRATION_SUPER_CLEANUP_JOB_NAME,
  MIGRATION_SUPER_CLEANUP_WORKFLOW_PATH,
  SCHEMA_TRANSITION_JOB_NAME,
  SCHEMA_TRANSITION_WORKFLOW_PATH,
  assertCompletedMigrationSuperCleanup,
  assertFailedMigrationSuperPredecessor,
  assertMigrationSuperCleanupEvidence,
  assertRunningMigrationSuperCleanup,
  createMigrationSuperCleanupEvidence,
  parseMigrationSuperCleanupRequest,
} from "./image-gen-migration-super-cleanup-evidence.mjs";

const predecessorId = 33910363498;
const predecessorSha = "00d00b6a7e815b72fec16e728df66ea984e9e3bf";
const cleanupId = 33920000000;
const cleanupSha = "a".repeat(40);
const request = {
  predecessorRunId: String(predecessorId),
  predecessorRunAttempt: "1",
  predecessorHeadSha: predecessorSha,
  databaseMachineId: "abcdef12345678",
  repairTokenId: "syntheticRepairToken123",
  repairSecretUpdatedAt: "2026-09-04T19:22:00Z",
  cleanupTokenId: "syntheticCleanupToken456",
  cleanupSecretUpdatedAt: "2026-09-05T05:22:00Z",
};

// Captured metadata-only from GitHub's attempt-jobs API for run 33910363498/1.
// The production failure happened at step 20; every DDL/grant step was skipped.
const capturedSteps = [
  [1, "Set up job", "success"],
  [2, "Require the reviewed main branch", "success"],
  [3, "Checkout exact source", "success"],
  [4, "Setup Node", "success"],
  [5, "Install root validation dependencies", "success"],
  [6, "Require the frozen reviewed transition", "success"],
  [7, "Require green CI for this exact transition source", "success"],
  [8, "Install exact verified flyctl", "success"],
  [9, "Load exact reviewed bridge", "success"],
  [10, "Require green CI for the bridge source", "success"],
  [11, "Verify trusted bridge attestations", "success"],
  [12, "Remove bridge registry credential", "success"],
  [13, "Prove every app and worker Machine is the bridge", "success"],
  [14, "Prepare metadata-only recovery record", "success"],
  [
    15,
    "Remove abandoned restore probes from earlier protected runs",
    "success",
  ],
  [16, "Bind snapshot and tunnel to the one live database Machine", "success"],
  [17, "Start isolated database migration tunnel", "success"],
  [18, "Snapshot the exact pre-repair credential boundary", "success"],
  [19, "Upload pre-repair credential-boundary recovery reference", "success"],
  [
    20,
    "Repair and verify only the approved migration-principal rights",
    "failure",
  ],
  [21, "Inspect the exact live schema phase without changing it", "skipped"],
  [
    22,
    "Verify temporary SUPER is absent before the recovery snapshot",
    "skipped",
  ],
  [23, "Create fresh snapshot from the exact 0016 base", "skipped"],
  [24, "Load exact prior 0016 recovery point for a resume", "skipped"],
  [
    25,
    "Restore recovery snapshot into an isolated encrypted volume",
    "skipped",
  ],
  [
    26,
    "Prove the restored MySQL copy from the isolated Machine exit status",
    "skipped",
  ],
  [27, "Remove isolated restore Machine and volume", "success"],
  [28, "Record exact pre-credit recovery point", "skipped"],
  [29, "Validate exact 0016 recovery evidence before DDL", "skipped"],
  [30, "Upload immutable pre-credit recovery evidence before DDL", "skipped"],
  [31, "Re-prove the exact settled bridge immediately before DDL", "skipped"],
  [
    32,
    "Restore approved migration rights only after recovery proof",
    "skipped",
  ],
  [33, "Grant the exact credit procedure definer table privileges", "skipped"],
  [34, "Apply only the reviewed 0017 and 0018 credit migrations", "skipped"],
  [35, "Verify the exact 0018 credit schema", "skipped"],
  [36, "Revoke temporary migration SUPER privilege", "failure"],
  [37, "Record metadata-only successful transition", "skipped"],
  [38, "Stop isolated database migration tunnel", "success"],
  [39, "Upload transition result", "success"],
  [77, "Post Setup Node", "skipped"],
  [78, "Post Checkout exact source", "success"],
  [79, "Complete job", "success"],
].map(([number, name, conclusion]) => ({
  number,
  name,
  conclusion,
  status: "completed",
}));

function predecessorFixture() {
  const run = {
    id: predecessorId,
    run_attempt: 1,
    status: "completed",
    conclusion: "failure",
    event: "workflow_dispatch",
    head_branch: "main",
    path: SCHEMA_TRANSITION_WORKFLOW_PATH,
    repository: { full_name: "Dj-Shortcut/openclaw-facebook" },
    head_repository: { full_name: "Dj-Shortcut/openclaw-facebook" },
    head_sha: predecessorSha,
  };
  const jobs = {
    total_count: 2,
    jobs: [
      {
        name: "Refuse unresolved image-gen deployment before approval",
        run_id: predecessorId,
        run_attempt: 1,
        head_sha: predecessorSha,
        status: "completed",
        conclusion: "success",
        steps: [],
      },
      {
        name: SCHEMA_TRANSITION_JOB_NAME,
        run_id: predecessorId,
        run_attempt: 1,
        head_sha: predecessorSha,
        status: "completed",
        conclusion: "failure",
        steps: structuredClone(capturedSteps),
      },
    ],
  };
  const latest = {
    workflow_runs: [
      {
        id: predecessorId,
        run_attempt: 1,
        head_sha: predecessorSha,
        path: SCHEMA_TRANSITION_WORKFLOW_PATH,
      },
    ],
  };
  return { run, jobs, latest };
}

function cleanupFixture() {
  const run = {
    id: cleanupId,
    run_attempt: 1,
    status: "in_progress",
    conclusion: null,
    event: "workflow_dispatch",
    head_branch: "main",
    path: MIGRATION_SUPER_CLEANUP_WORKFLOW_PATH,
    repository: { full_name: "Dj-Shortcut/openclaw-facebook" },
    head_repository: { full_name: "Dj-Shortcut/openclaw-facebook" },
    head_sha: cleanupSha,
  };
  const latest = {
    workflow_runs: [
      {
        id: cleanupId,
        run_attempt: 1,
        head_sha: cleanupSha,
        path: MIGRATION_SUPER_CLEANUP_WORKFLOW_PATH,
      },
    ],
  };
  return { run, latest };
}

function completedCleanupFixture() {
  const value = cleanupFixture();
  value.run.status = "completed";
  value.run.conclusion = "success";
  value.jobs = {
    total_count: 1,
    jobs: [
      {
        name: MIGRATION_SUPER_CLEANUP_JOB_NAME,
        run_id: cleanupId,
        run_attempt: 1,
        head_sha: cleanupSha,
        status: "completed",
        conclusion: "success",
        steps: [
          "Require protected main and exact source",
          "Check out exact source",
          "Set up Node",
          "Install exact verification dependencies",
          "Verify reviewed source and failed predecessor before approval mutation",
          "Install exact verified flyctl",
          "Bind the exact live database Machine without changing it",
          "Start isolated database migration tunnel",
          "Reprove the failed predecessor immediately before cleanup",
          "Revoke only temporary migration SUPER",
          "Inspect immutable migration history after cleanup",
          "Reprove the complete chain and record metadata-only cleanup evidence",
          "Upload immutable migration SUPER cleanup evidence",
          "Stop isolated database migration tunnel",
        ].map((name, index) => ({
          number: index + 2,
          name,
          status: "completed",
          conclusion: "success",
        })),
      },
    ],
  };
  return value;
}

const expectedCleanup = {
  id: String(cleanupId),
  attempt: "1",
  headSha: cleanupSha,
};

function evidenceFixture() {
  return createMigrationSuperCleanupEvidence({
    request,
    cleanupRun: expectedCleanup,
    databaseMachineId: "abcdef12345678",
    phase: "0016_expand",
    result: "temporary_super_absent",
    completedAt: "2026-09-05T05:30:00Z",
  });
}

describe("migration SUPER cleanup request", () => {
  it("accepts only the exact predecessor and credential metadata", () => {
    expect(parseMigrationSuperCleanupRequest(request)).toEqual(request);
  });

  it.each([
    {},
    { ...request, extra: true },
    { ...request, predecessorRunId: "0" },
    { ...request, predecessorRunAttempt: "01" },
    { ...request, predecessorHeadSha: "A".repeat(40) },
    { ...request, databaseMachineId: "other-database" },
    { ...request, repairTokenId: "--all" },
    { ...request, repairSecretUpdatedAt: "2026-09-04T20:00:00.000Z" },
    { ...request, cleanupTokenId: request.repairTokenId },
    { ...request, cleanupTokenId: "--all" },
    { ...request, cleanupSecretUpdatedAt: request.repairSecretUpdatedAt },
    { ...request, cleanupSecretUpdatedAt: "2026-09-04T19:21:59Z" },
  ])("rejects malformed or expanded requests", (value) => {
    expect(() => parseMigrationSuperCleanupRequest(value)).toThrow(
      "migration SUPER cleanup evidence rejected",
    );
  });
});

describe("captured pre-DDL predecessor proof", () => {
  it("accepts the exact failed production attempt captured from GitHub", () => {
    expect(
      assertFailedMigrationSuperPredecessor(predecessorFixture(), request),
    ).toEqual({
      id: String(predecessorId),
      attempt: "1",
      headSha: predecessorSha,
      workflowPath: SCHEMA_TRANSITION_WORKFLOW_PATH,
    });
  });

  it.each([
    (value) => {
      value.run.conclusion = "success";
    },
    (value) => {
      value.latest.workflow_runs[0].id += 1;
    },
    (value) => {
      value.jobs.jobs[1].conclusion = "cancelled";
    },
    (value) => {
      value.jobs.jobs[1].steps.find((step) => step.number === 20).conclusion =
        "success";
    },
    (value) => {
      value.jobs.jobs[1].steps.find((step) => step.number === 32).conclusion =
        "success";
    },
    (value) => {
      value.jobs.jobs[1].steps.find((step) => step.number === 34).conclusion =
        "success";
    },
    (value) => {
      value.jobs.jobs[1].steps.find((step) => step.number === 36).conclusion =
        "success";
    },
    (value) => {
      value.jobs.jobs[1].steps.find((step) => step.number === 37).number = 35;
    },
    (value) => {
      value.jobs.jobs[1].steps.push({
        ...value.jobs.jobs[1].steps.find((step) => step.number === 34),
        number: 80,
      });
    },
  ])("rejects changed or ambiguous predecessor evidence", (mutate) => {
    const value = predecessorFixture();
    mutate(value);
    expect(() => assertFailedMigrationSuperPredecessor(value, request)).toThrow(
      "migration SUPER cleanup evidence rejected",
    );
  });
});

describe("protected cleanup run identity", () => {
  it("requires the current latest protected-main workflow run", () => {
    expect(
      assertRunningMigrationSuperCleanup(cleanupFixture(), expectedCleanup),
    ).toEqual({
      ...expectedCleanup,
      workflowPath: MIGRATION_SUPER_CLEANUP_WORKFLOW_PATH,
    });
  });

  it.each([
    (value) => {
      value.run.status = "queued";
    },
    (value) => {
      value.run.event = "pull_request";
    },
    (value) => {
      value.run.repository.full_name = "fork/openclaw-facebook";
    },
    (value) => {
      value.latest.workflow_runs = [];
    },
  ])("rejects unreviewed or superseded cleanup runs", (mutate) => {
    const value = cleanupFixture();
    mutate(value);
    expect(() =>
      assertRunningMigrationSuperCleanup(value, expectedCleanup),
    ).toThrow("migration SUPER cleanup evidence rejected");
  });

  it("accepts only a completed successful job with ordered cleanup proof", () => {
    expect(
      assertCompletedMigrationSuperCleanup(
        completedCleanupFixture(),
        expectedCleanup,
      ),
    ).toEqual({
      ...expectedCleanup,
      workflowPath: MIGRATION_SUPER_CLEANUP_WORKFLOW_PATH,
    });
  });

  it.each([
    (value) => {
      value.run.conclusion = "failure";
    },
    (value) => {
      value.jobs.jobs[0].name = "lookalike cleanup";
    },
    (value) => {
      value.jobs.jobs[0].steps.find(
        (step) => step.name === "Revoke only temporary migration SUPER",
      ).conclusion = "failure";
    },
    (value) => {
      value.jobs.jobs[0].steps.find(
        (step) =>
          step.name === "Inspect immutable migration history after cleanup",
      ).number = 1;
    },
    (value) => {
      value.jobs.jobs[0].steps.push({
        ...value.jobs.jobs[0].steps.find(
          (step) =>
            step.name === "Upload immutable migration SUPER cleanup evidence",
        ),
        number: 99,
      });
    },
    (value) => {
      value.latest.workflow_runs[0].run_attempt = 2;
    },
  ])("rejects incomplete or ambiguous terminal cleanup evidence", (mutate) => {
    const value = completedCleanupFixture();
    mutate(value);
    expect(() =>
      assertCompletedMigrationSuperCleanup(value, expectedCleanup),
    ).toThrow("migration SUPER cleanup evidence rejected");
  });
});

describe("metadata-only cleanup artifact", () => {
  it("binds the separate cleanup credential without changing old token metadata", () => {
    expect(evidenceFixture()).toEqual({
      version: 1,
      type: MIGRATION_SUPER_CLEANUP_EVIDENCE_TYPE,
      cleanupRun: {
        ...expectedCleanup,
        workflowPath: MIGRATION_SUPER_CLEANUP_WORKFLOW_PATH,
      },
      predecessor: {
        id: String(predecessorId),
        attempt: "1",
        headSha: predecessorSha,
        workflowPath: SCHEMA_TRANSITION_WORKFLOW_PATH,
      },
      repairCredential: {
        tokenId: request.repairTokenId,
        name: `leaderbot-pr486-repair-${predecessorId}`,
        secretUpdatedAt: request.repairSecretUpdatedAt,
      },
      cleanupCredential: {
        tokenId: request.cleanupTokenId,
        name: `leaderbot-pr486-cleanup-${predecessorId}`,
        secretUpdatedAt: request.cleanupSecretUpdatedAt,
      },
      database: {
        app: "leaderbot-portal-mysql",
        machineId: "abcdef12345678",
        name: "leaderbot",
      },
      phase: "0016_expand",
      result: "temporary_super_absent",
      completedAt: "2026-09-05T05:30:00Z",
    });
  });

  it.each([
    (value) => {
      value.extra = true;
    },
    (value) => {
      value.cleanupRun.workflowPath = SCHEMA_TRANSITION_WORKFLOW_PATH;
    },
    (value) => {
      value.predecessor.id = String(predecessorId + 1);
    },
    (value) => {
      value.repairCredential.name = "leaderbot-pr486-repair-other";
    },
    (value) => {
      value.repairCredential.secretUpdatedAt = "2026-09-04T19:22:00.000Z";
    },
    (value) => {
      value.cleanupCredential.tokenId = value.repairCredential.tokenId;
    },
    (value) => {
      value.cleanupCredential.name = value.repairCredential.name;
    },
    (value) => {
      value.cleanupCredential.secretUpdatedAt =
        value.repairCredential.secretUpdatedAt;
    },
    (value) => {
      value.cleanupCredential.secretUpdatedAt = "2026-09-05T05:22:01Z";
    },
    (value) => {
      value.completedAt = value.cleanupCredential.secretUpdatedAt;
    },
    (value) => {
      delete value.cleanupCredential;
    },
    (value) => {
      value.database.machineId = "not-a-machine";
    },
    (value) => {
      value.phase = "0018_credit_checkout_reservation";
    },
    (value) => {
      value.result = "cleanup_assumed";
    },
  ])("rejects altered cleanup artifacts", (mutate) => {
    const value = structuredClone(evidenceFixture());
    mutate(value);
    expect(() =>
      assertMigrationSuperCleanupEvidence(value, {
        request,
        cleanupRun: expectedCleanup,
        databaseMachineId: "abcdef12345678",
      }),
    ).toThrow("migration SUPER cleanup evidence rejected");
  });
});

describe("cleanup-only workflow source", () => {
  const workflow = readFileSync(
    new URL(
      "../.github/workflows/cleanup-image-gen-migration-super.yml",
      import.meta.url,
    ),
    "utf8",
  );

  it("shares the deployment lock and uses the reviewed production environment", () => {
    expect(workflow).toContain("group: production-deploy-image-gen");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain(
      'node scripts/validate-production-deployment.mjs --verify-source-ci "$GITHUB_SHA"',
    );
  });

  it("invokes only the fixed SUPER revocation operation", () => {
    expect(workflow).toContain("--operation revoke-super");
    expect(workflow).not.toContain("--operation prepare");
    expect(workflow).not.toMatch(/LEADERBOT_PRODUCTION_MIGRATION_MODE=apply-/);
    expect(workflow).not.toMatch(/^\s*(?:GRANT|CREATE|ALTER|DROP)\s/im);
    expect(workflow).not.toContain("IMAGE_GEN_DATABASE_PROVISIONER_URL");
    expect(workflow).toContain(
      "FLY_API_TOKEN: ${{ secrets.FLY_DATABASE_CLEANUP_EXEC_TOKEN }}",
    );
    expect(workflow).not.toContain("secrets.FLY_DATABASE_REPAIR_EXEC_TOKEN");
  });

  it("rechecks the predecessor, then observes 0016 before evidence upload", () => {
    expect(
      workflow.match(/assertFailedMigrationSuperPredecessor\(\{/g),
    ).toHaveLength(3);
    const cleanup = workflow.indexOf(
      "- name: Revoke only temporary migration SUPER",
    );
    const phase = workflow.indexOf(
      "- name: Inspect immutable migration history after cleanup",
    );
    const evidence = workflow.indexOf(
      "- name: Reprove the complete chain and record metadata-only cleanup evidence",
    );
    const upload = workflow.indexOf(
      "- name: Upload immutable migration SUPER cleanup evidence",
    );
    expect(cleanup).toBeGreaterThan(0);
    expect(phase).toBeGreaterThan(cleanup);
    expect(evidence).toBeGreaterThan(phase);
    expect(upload).toBeGreaterThan(evidence);
    expect(workflow).toContain("captureMigrationHistory");
    expect(workflow).toContain(
      "canonicalJson(history) !== canonicalJson(contract.history0016)",
    );
  });

  it("publishes one exact metadata artifact without secret inventory authority", () => {
    expect(workflow).toContain(
      "name: image-gen-migration-super-cleanup-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    expect(workflow).toContain(
      "path: ${{ runner.temp }}/leaderbot-migration-super-cleanup/migration-super-cleanup-evidence.json",
    );
    expect(workflow).toContain("if-no-files-found: error");
    expect(workflow).toContain("retention-days: 90");
    expect(workflow).not.toContain("gh secret");
    expect(workflow).not.toContain("secrets: write");
  });
});
