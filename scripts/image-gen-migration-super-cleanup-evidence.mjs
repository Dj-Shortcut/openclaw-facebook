const REPOSITORY = "Dj-Shortcut/openclaw-facebook";
export const MIGRATION_SUPER_CLEANUP_WORKFLOW_PATH =
  ".github/workflows/cleanup-image-gen-migration-super.yml";
export const SCHEMA_TRANSITION_WORKFLOW_PATH =
  ".github/workflows/image-gen-schema-transition.yml";
export const SCHEMA_TRANSITION_JOB_NAME =
  "Snapshot, restore-test, and apply 0017 through 0018";
export const MIGRATION_SUPER_CLEANUP_JOB_NAME =
  "Revoke only temporary migration SUPER after a pre-DDL failure";
export const MIGRATION_SUPER_CLEANUP_EVIDENCE_TYPE =
  "image_gen_migration_super_cleanup";
export const MIGRATION_SUPER_CLEANUP_EVIDENCE_VERSION = 1;

const DATABASE_APP = "leaderbot-portal-mysql";
const DATABASE_NAME = "leaderbot";
const EXPECTED_PHASE = "0016_expand";
const EXPECTED_RESULT = "temporary_super_absent";
const RUN_ID = /^[1-9][0-9]{0,15}$/;
const SHA = /^[a-f0-9]{40}$/;
const MACHINE_ID = /^[a-f0-9]{14}$/;
const TOKEN_ID = /^[A-Za-z0-9][A-Za-z0-9_+/=:-]{3,127}$/;

const PRE_REPAIR_SUCCESS_STEPS = Object.freeze([
  "Bind snapshot and tunnel to the one live database Machine",
  "Start isolated database migration tunnel",
  "Snapshot the exact pre-repair credential boundary",
  "Upload pre-repair credential-boundary recovery reference",
]);
const REPAIR_STEP =
  "Repair and verify only the approved migration-principal rights";
const CLEANUP_STEP = "Revoke temporary migration SUPER privilege";
const PRE_DDL_SKIPPED_STEPS = Object.freeze([
  "Inspect the exact live schema phase without changing it",
  "Verify temporary SUPER is absent before the recovery snapshot",
  "Create fresh snapshot from the exact 0016 base",
  "Load exact prior 0016 recovery point for a resume",
  "Restore recovery snapshot into an isolated encrypted volume",
  "Prove the restored MySQL copy from the isolated Machine exit status",
  "Record exact pre-credit recovery point",
  "Validate exact 0016 recovery evidence before DDL",
  "Upload immutable pre-credit recovery evidence before DDL",
  "Re-prove the exact settled bridge immediately before DDL",
  "Restore approved migration rights only after recovery proof",
  "Grant the exact credit procedure definer table privileges",
  "Apply only the reviewed 0017 and 0018 credit migrations",
  "Verify the exact 0018 credit schema",
]);
const POST_CLEANUP_SKIPPED_STEP = "Record metadata-only successful transition";

function fail() {
  throw new Error("migration SUPER cleanup evidence rejected");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  if (
    !isObject(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify([...keys].sort())
  ) {
    fail();
  }
  return value;
}

function requireRunId(value) {
  if (
    typeof value !== "string" ||
    !RUN_ID.test(value) ||
    !Number.isSafeInteger(Number(value))
  ) {
    fail();
  }
  return value;
}

function requireSha(value) {
  if (typeof value !== "string" || !SHA.test(value)) fail();
  return value;
}

function requireTimestamp(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value.replace("Z", ".000Z")
  ) {
    fail();
  }
  return value;
}

function requireTokenId(value) {
  if (typeof value !== "string" || !TOKEN_ID.test(value)) fail();
  return value;
}

function requireRepositoryRun(run, expected, { status, conclusion }) {
  if (
    !isObject(run) ||
    run.id !== Number(expected.id) ||
    run.run_attempt !== Number(expected.attempt) ||
    run.head_sha !== expected.headSha ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "main" ||
    run.path !== expected.workflowPath ||
    run.repository?.full_name !== REPOSITORY ||
    run.head_repository?.full_name !== REPOSITORY ||
    run.status !== status ||
    run.conclusion !== conclusion
  ) {
    fail();
  }
}

function requireLatestRun(latest, expected) {
  if (
    !isObject(latest) ||
    !Array.isArray(latest.workflow_runs) ||
    latest.workflow_runs.length !== 1
  ) {
    fail();
  }
  const run = latest.workflow_runs[0];
  if (
    run?.id !== Number(expected.id) ||
    run?.run_attempt !== Number(expected.attempt) ||
    run?.head_sha !== expected.headSha ||
    run?.path !== expected.workflowPath
  ) {
    fail();
  }
}

function requireUniqueStep(steps, name, conclusion) {
  const matches = steps.filter((step) => step?.name === name);
  if (
    matches.length !== 1 ||
    matches[0].status !== "completed" ||
    matches[0].conclusion !== conclusion ||
    !Number.isSafeInteger(matches[0].number) ||
    matches[0].number < 1
  ) {
    fail();
  }
  return matches[0].number;
}

export function parseMigrationSuperCleanupRequest(value) {
  const request = exactKeys(value, [
    "predecessorRunId",
    "predecessorRunAttempt",
    "predecessorHeadSha",
    "databaseMachineId",
    "repairTokenId",
    "repairSecretUpdatedAt",
    "cleanupTokenId",
    "cleanupSecretUpdatedAt",
  ]);
  const predecessorRunId = requireRunId(request.predecessorRunId);
  const predecessorRunAttempt = requireRunId(request.predecessorRunAttempt);
  const predecessorHeadSha = requireSha(request.predecessorHeadSha);
  const databaseMachineId = request.databaseMachineId;
  if (
    typeof databaseMachineId !== "string" ||
    !MACHINE_ID.test(databaseMachineId)
  )
    fail();
  const repairTokenId = requireTokenId(request.repairTokenId);
  const repairSecretUpdatedAt = requireTimestamp(request.repairSecretUpdatedAt);
  const cleanupTokenId = requireTokenId(request.cleanupTokenId);
  const cleanupSecretUpdatedAt = requireTimestamp(
    request.cleanupSecretUpdatedAt,
  );
  if (
    cleanupTokenId === repairTokenId ||
    Date.parse(cleanupSecretUpdatedAt) <= Date.parse(repairSecretUpdatedAt)
  )
    fail();
  return Object.freeze({
    predecessorRunId,
    predecessorRunAttempt,
    predecessorHeadSha,
    databaseMachineId,
    repairTokenId,
    repairSecretUpdatedAt,
    cleanupTokenId,
    cleanupSecretUpdatedAt,
  });
}

export function assertFailedMigrationSuperPredecessor(
  { run, jobs, latest },
  rawRequest,
) {
  const request = parseMigrationSuperCleanupRequest(rawRequest);
  const expected = {
    id: request.predecessorRunId,
    attempt: request.predecessorRunAttempt,
    headSha: request.predecessorHeadSha,
    workflowPath: SCHEMA_TRANSITION_WORKFLOW_PATH,
  };
  requireRepositoryRun(run, expected, {
    status: "completed",
    conclusion: "failure",
  });
  requireLatestRun(latest, expected);
  if (
    !isObject(jobs) ||
    !Number.isSafeInteger(jobs.total_count) ||
    jobs.total_count !== jobs.jobs?.length ||
    jobs.total_count < 1 ||
    jobs.total_count > 100
  ) {
    fail();
  }
  const matches = jobs.jobs.filter(
    (candidate) => candidate?.name === SCHEMA_TRANSITION_JOB_NAME,
  );
  if (matches.length !== 1) fail();
  const job = matches[0];
  if (
    job.status !== "completed" ||
    job.conclusion !== "failure" ||
    job.run_id !== run.id ||
    (job.run_attempt !== undefined && job.run_attempt !== run.run_attempt) ||
    job.head_sha !== run.head_sha ||
    !Array.isArray(job.steps)
  ) {
    fail();
  }

  const preRepair = PRE_REPAIR_SUCCESS_STEPS.map((name) =>
    requireUniqueStep(job.steps, name, "success"),
  );
  const repair = requireUniqueStep(job.steps, REPAIR_STEP, "failure");
  const skipped = PRE_DDL_SKIPPED_STEPS.map((name) =>
    requireUniqueStep(job.steps, name, "skipped"),
  );
  const cleanup = requireUniqueStep(job.steps, CLEANUP_STEP, "failure");
  const postCleanup = requireUniqueStep(
    job.steps,
    POST_CLEANUP_SKIPPED_STEP,
    "skipped",
  );
  if (
    !preRepair.every((number, index) =>
      index === 0
        ? number < repair
        : number > preRepair[index - 1] && number < repair,
    ) ||
    !skipped.every((number) => number > repair && number < cleanup) ||
    postCleanup <= cleanup
  ) {
    fail();
  }

  return Object.freeze({
    id: request.predecessorRunId,
    attempt: request.predecessorRunAttempt,
    headSha: request.predecessorHeadSha,
    workflowPath: SCHEMA_TRANSITION_WORKFLOW_PATH,
  });
}

export function assertRunningMigrationSuperCleanup(
  { run, latest },
  rawExpected,
) {
  const expected = exactKeys(rawExpected, ["id", "attempt", "headSha"]);
  const identity = {
    id: requireRunId(expected.id),
    attempt: requireRunId(expected.attempt),
    headSha: requireSha(expected.headSha),
    workflowPath: MIGRATION_SUPER_CLEANUP_WORKFLOW_PATH,
  };
  requireRepositoryRun(run, identity, {
    status: "in_progress",
    conclusion: null,
  });
  requireLatestRun(latest, identity);
  return Object.freeze(identity);
}

export function assertCompletedMigrationSuperCleanup(
  { run, jobs, latest },
  rawExpected,
) {
  const expected = exactKeys(rawExpected, ["id", "attempt", "headSha"]);
  const identity = {
    id: requireRunId(expected.id),
    attempt: requireRunId(expected.attempt),
    headSha: requireSha(expected.headSha),
    workflowPath: MIGRATION_SUPER_CLEANUP_WORKFLOW_PATH,
  };
  requireRepositoryRun(run, identity, {
    status: "completed",
    conclusion: "success",
  });
  requireLatestRun(latest, identity);
  if (
    !isObject(jobs) ||
    !Number.isSafeInteger(jobs.total_count) ||
    jobs.total_count !== jobs.jobs?.length ||
    jobs.total_count < 1 ||
    jobs.total_count > 100
  ) {
    fail();
  }
  const matches = jobs.jobs.filter(
    (candidate) => candidate?.name === MIGRATION_SUPER_CLEANUP_JOB_NAME,
  );
  if (matches.length !== 1) fail();
  const job = matches[0];
  if (
    job.status !== "completed" ||
    job.conclusion !== "success" ||
    job.run_id !== run.id ||
    (job.run_attempt !== undefined && job.run_attempt !== run.run_attempt) ||
    job.head_sha !== run.head_sha ||
    !Array.isArray(job.steps)
  ) {
    fail();
  }
  const orderedSteps = [
    "Revoke only temporary migration SUPER",
    "Inspect immutable migration history after cleanup",
    "Reprove the complete chain and record metadata-only cleanup evidence",
    "Upload immutable migration SUPER cleanup evidence",
    "Stop isolated database migration tunnel",
  ].map((name) => requireUniqueStep(job.steps, name, "success"));
  if (
    !orderedSteps.every(
      (number, index) => index === 0 || number > orderedSteps[index - 1],
    )
  ) {
    fail();
  }
  return Object.freeze(identity);
}

function validateRunIdentity(value, workflowPath) {
  const run = exactKeys(value, ["id", "attempt", "headSha", "workflowPath"]);
  const result = {
    id: requireRunId(run.id),
    attempt: requireRunId(run.attempt),
    headSha: requireSha(run.headSha),
    workflowPath: run.workflowPath,
  };
  if (result.workflowPath !== workflowPath) fail();
  return result;
}

export function assertMigrationSuperCleanupEvidence(value, expected = {}) {
  const evidence = exactKeys(value, [
    "version",
    "type",
    "cleanupRun",
    "predecessor",
    "repairCredential",
    "cleanupCredential",
    "database",
    "phase",
    "result",
    "completedAt",
  ]);
  if (
    evidence.version !== MIGRATION_SUPER_CLEANUP_EVIDENCE_VERSION ||
    evidence.type !== MIGRATION_SUPER_CLEANUP_EVIDENCE_TYPE ||
    evidence.phase !== EXPECTED_PHASE ||
    evidence.result !== EXPECTED_RESULT
  ) {
    fail();
  }
  const cleanupRun = validateRunIdentity(
    evidence.cleanupRun,
    MIGRATION_SUPER_CLEANUP_WORKFLOW_PATH,
  );
  const predecessor = validateRunIdentity(
    evidence.predecessor,
    SCHEMA_TRANSITION_WORKFLOW_PATH,
  );
  const repairCredential = exactKeys(evidence.repairCredential, [
    "tokenId",
    "name",
    "secretUpdatedAt",
  ]);
  const tokenId = requireTokenId(repairCredential.tokenId);
  const secretUpdatedAt = requireTimestamp(repairCredential.secretUpdatedAt);
  const tokenName = `leaderbot-pr486-repair-${predecessor.id}`;
  if (repairCredential.name !== tokenName) fail();
  const cleanupCredential = exactKeys(evidence.cleanupCredential, [
    "tokenId",
    "name",
    "secretUpdatedAt",
  ]);
  const cleanupTokenId = requireTokenId(cleanupCredential.tokenId);
  const cleanupSecretUpdatedAt = requireTimestamp(
    cleanupCredential.secretUpdatedAt,
  );
  const cleanupTokenName = `leaderbot-pr486-cleanup-${predecessor.id}`;
  if (
    cleanupCredential.name !== cleanupTokenName ||
    cleanupTokenId === tokenId ||
    Date.parse(cleanupSecretUpdatedAt) <= Date.parse(secretUpdatedAt)
  )
    fail();
  const database = exactKeys(evidence.database, ["app", "machineId", "name"]);
  if (
    database.app !== DATABASE_APP ||
    database.name !== DATABASE_NAME ||
    typeof database.machineId !== "string" ||
    !MACHINE_ID.test(database.machineId)
  ) {
    fail();
  }
  const completedAt = requireTimestamp(evidence.completedAt);
  if (Date.parse(completedAt) <= Date.parse(cleanupSecretUpdatedAt)) fail();

  if (Object.hasOwn(expected, "request")) {
    const request = parseMigrationSuperCleanupRequest(expected.request);
    if (
      predecessor.id !== request.predecessorRunId ||
      predecessor.attempt !== request.predecessorRunAttempt ||
      predecessor.headSha !== request.predecessorHeadSha ||
      database.machineId !== request.databaseMachineId ||
      tokenId !== request.repairTokenId ||
      secretUpdatedAt !== request.repairSecretUpdatedAt ||
      cleanupTokenId !== request.cleanupTokenId ||
      cleanupSecretUpdatedAt !== request.cleanupSecretUpdatedAt
    ) {
      fail();
    }
  }
  if (Object.hasOwn(expected, "cleanupRun")) {
    const expectedCleanup = exactKeys(expected.cleanupRun, [
      "id",
      "attempt",
      "headSha",
    ]);
    if (
      cleanupRun.id !== requireRunId(expectedCleanup.id) ||
      cleanupRun.attempt !== requireRunId(expectedCleanup.attempt) ||
      cleanupRun.headSha !== requireSha(expectedCleanup.headSha)
    ) {
      fail();
    }
  }
  if (Object.hasOwn(expected, "databaseMachineId")) {
    if (
      typeof expected.databaseMachineId !== "string" ||
      !MACHINE_ID.test(expected.databaseMachineId) ||
      database.machineId !== expected.databaseMachineId
    ) {
      fail();
    }
  }

  return Object.freeze({
    version: evidence.version,
    type: evidence.type,
    cleanupRun: Object.freeze(cleanupRun),
    predecessor: Object.freeze(predecessor),
    repairCredential: Object.freeze({
      tokenId,
      name: tokenName,
      secretUpdatedAt,
    }),
    cleanupCredential: Object.freeze({
      tokenId: cleanupTokenId,
      name: cleanupTokenName,
      secretUpdatedAt: cleanupSecretUpdatedAt,
    }),
    database: Object.freeze({ ...database }),
    phase: evidence.phase,
    result: evidence.result,
    completedAt,
  });
}

export function createMigrationSuperCleanupEvidence({
  request: rawRequest,
  cleanupRun: rawCleanupRun,
  databaseMachineId,
  phase,
  result,
  completedAt,
}) {
  const request = parseMigrationSuperCleanupRequest(rawRequest);
  const cleanupRun = exactKeys(rawCleanupRun, ["id", "attempt", "headSha"]);
  const evidence = {
    version: MIGRATION_SUPER_CLEANUP_EVIDENCE_VERSION,
    type: MIGRATION_SUPER_CLEANUP_EVIDENCE_TYPE,
    cleanupRun: {
      id: cleanupRun.id,
      attempt: cleanupRun.attempt,
      headSha: cleanupRun.headSha,
      workflowPath: MIGRATION_SUPER_CLEANUP_WORKFLOW_PATH,
    },
    predecessor: {
      id: request.predecessorRunId,
      attempt: request.predecessorRunAttempt,
      headSha: request.predecessorHeadSha,
      workflowPath: SCHEMA_TRANSITION_WORKFLOW_PATH,
    },
    repairCredential: {
      tokenId: request.repairTokenId,
      name: `leaderbot-pr486-repair-${request.predecessorRunId}`,
      secretUpdatedAt: request.repairSecretUpdatedAt,
    },
    cleanupCredential: {
      tokenId: request.cleanupTokenId,
      name: `leaderbot-pr486-cleanup-${request.predecessorRunId}`,
      secretUpdatedAt: request.cleanupSecretUpdatedAt,
    },
    database: {
      app: DATABASE_APP,
      machineId: databaseMachineId,
      name: DATABASE_NAME,
    },
    phase,
    result,
    completedAt,
  };
  return assertMigrationSuperCleanupEvidence(evidence, {
    request,
    cleanupRun,
    databaseMachineId,
  });
}
