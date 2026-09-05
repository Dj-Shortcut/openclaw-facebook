#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { PINNED_FLYCTL_VERSION } from "./provision-image-gen-credit-provisioner.mjs";
import {
  assertCompletedMigrationSuperCleanup,
  assertFailedMigrationSuperPredecessor,
  assertMigrationSuperCleanupEvidence,
  MIGRATION_SUPER_CLEANUP_JOB_NAME,
  MIGRATION_SUPER_CLEANUP_WORKFLOW_PATH,
} from "./image-gen-migration-super-cleanup-evidence.mjs";

const REPOSITORY = "Dj-Shortcut/openclaw-facebook";
const APP = "leaderbot-portal-mysql";
const ENVIRONMENT = "production";
const SECRET = "FLY_DATABASE_REPAIR_EXEC_TOKEN";
const CLEANUP_SECRET = "FLY_DATABASE_CLEANUP_EXEC_TOKEN";
const WORKFLOW = ".github/workflows/image-gen-schema-transition.yml";
const JOB = "Snapshot, restore-test, and apply 0017 through 0018";
const CLEANUP = "Revoke temporary migration SUPER privilege";
const MAX_BYTES = 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_+/=:-]{3,127}$/;
const RUN_ID = /^[1-9][0-9]{0,15}$/;
const SHA = /^[a-f0-9]{40}$/;
const TERMINAL = new Set([
  "success",
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "neutral",
  "skipped",
  "stale",
]);

function reject() {
  throw new Error("repair exec token retirement rejected");
}

function validTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value.replace("Z", ".000Z")
  );
}

export function parseRetirementArguments(argv) {
  const flags = new Map([
    ["--run-id", "runId"],
    ["--run-attempt", "runAttempt"],
    ["--token-id", "tokenId"],
    ["--secret-updated-at", "secretUpdatedAt"],
    ["--cleanup-run-id", "cleanupRunId"],
    ["--cleanup-run-attempt", "cleanupRunAttempt"],
    ["--cleanup-token-id", "cleanupTokenId"],
    ["--cleanup-secret-updated-at", "cleanupSecretUpdatedAt"],
    ["--database-machine-id", "databaseMachineId"],
  ]);
  if (!Array.isArray(argv) || ![8, 18].includes(argv.length)) reject();
  const expected = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = flags.get(argv[index]);
    if (!key || Object.hasOwn(expected, key)) reject();
    expected[key] = argv[index + 1];
  }
  if (
    [expected.runId, expected.runAttempt].some(
      (value) =>
        typeof value !== "string" ||
        !RUN_ID.test(value) ||
        !Number.isSafeInteger(Number(value)),
    ) ||
    typeof expected.tokenId !== "string" ||
    !ID.test(expected.tokenId) ||
    !validTimestamp(expected.secretUpdatedAt)
  )
    reject();
  const recovery = argv.length === 18;
  if (
    recovery &&
    ([expected.cleanupRunId, expected.cleanupRunAttempt].some(
      (value) =>
        typeof value !== "string" ||
        !RUN_ID.test(value) ||
        !Number.isSafeInteger(Number(value)),
    ) ||
      expected.cleanupRunId === expected.runId ||
      typeof expected.cleanupTokenId !== "string" ||
      !ID.test(expected.cleanupTokenId) ||
      expected.cleanupTokenId === expected.tokenId ||
      !validTimestamp(expected.cleanupSecretUpdatedAt) ||
      Date.parse(expected.cleanupSecretUpdatedAt) <=
        Date.parse(expected.secretUpdatedAt) ||
      typeof expected.databaseMachineId !== "string" ||
      !/^[a-f0-9]{14}$/.test(expected.databaseMachineId))
  )
    reject();
  if (!recovery && Object.keys(expected).length !== 4) reject();
  return expected;
}

function goUtcTime(value) {
  const match =
    /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))? \+0000 UTC$/.exec(
      value,
    );
  if (!match) reject();
  const canonical = `${match[1]}T${match[2]}.${(match[3] ?? "").padEnd(3, "0").slice(0, 3)}Z`;
  const milliseconds = Date.parse(canonical);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== canonical
  )
    reject();
  return milliseconds;
}

export function parseFlyTokenInventory(output) {
  // v0.4.94 has no JSON flag: list.go emits this exact app-scoped table.
  // Revoke can exit zero after a per-token error, so its text is never proof.
  // https://github.com/superfly/flyctl/blob/v0.4.94/internal/command/tokens/list.go
  // https://github.com/superfly/flyctl/blob/v0.4.94/internal/command/tokens/revoke.go
  if (
    typeof output !== "string" ||
    Buffer.byteLength(output) > MAX_BYTES ||
    /[\x00-\x08\x0b-\x1f\x7f]/.test(output)
  )
    reject();
  const lines = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.shift() !== `Tokens for app "${APP}":`) reject();
  const header = lines
    .shift()
    ?.split("│")
    .map((cell) => cell.trim());
  if (
    JSON.stringify(header) !==
    JSON.stringify(["ID", "NAME", "CREATED BY", "EXPIRES AT", "REVOKED AT"])
  )
    reject();
  const ids = new Set();
  return lines.map((line) => {
    const cells = line.split("│").map((cell) => cell.trim());
    if (cells.length !== 5) reject();
    const [id, name, creator, expiresAt, revokedAt] = cells;
    if (
      !ID.test(id) ||
      ids.has(id) ||
      !name ||
      !creator ||
      name.length > 256 ||
      creator.length > 256
    )
      reject();
    ids.add(id);
    return {
      id,
      name,
      expiresAt: goUtcTime(expiresAt),
      revokedAt: revokedAt === "" ? null : goUtcTime(revokedAt),
    };
  });
}

function selectToken(tokens, expected, now) {
  const name = expected.tokenName ?? `leaderbot-pr486-repair-${expected.runId}`;
  const matches = tokens.filter(
    (token) => token.id === expected.tokenId || token.name === name,
  );
  if (
    matches.length !== 1 ||
    matches[0].id !== expected.tokenId ||
    matches[0].name !== name
  )
    reject();
  const token = matches[0];
  if (token.revokedAt === null && token.expiresAt > now + 4 * 60 * 60 * 1000)
    reject();
  if (token.revokedAt !== null && token.revokedAt > now + 60_000) reject();
  return token;
}

export function assertRetirementRun(run, jobs, latest, expected) {
  if (
    run?.id !== Number(expected.runId) ||
    run?.run_attempt !== Number(expected.runAttempt) ||
    run?.status !== "completed" ||
    !TERMINAL.has(run.conclusion) ||
    run.event !== "workflow_dispatch" ||
    run.head_branch !== "main" ||
    run.path !== WORKFLOW ||
    run.repository?.full_name !== REPOSITORY ||
    run.head_repository?.full_name !== REPOSITORY ||
    !SHA.test(run.head_sha ?? "")
  )
    reject();
  if (
    latest?.workflow_runs?.length !== 1 ||
    latest.workflow_runs[0]?.id !== run.id ||
    latest.workflow_runs[0]?.run_attempt !== run.run_attempt
  )
    reject();
  if (
    !Array.isArray(jobs?.jobs) ||
    !Number.isSafeInteger(jobs.total_count) ||
    jobs.total_count !== jobs.jobs.length ||
    jobs.total_count < 1 ||
    jobs.total_count > 100
  )
    reject();
  const matches = jobs.jobs.filter((job) => job.name === JOB);
  if (matches.length !== 1) reject();
  const job = matches[0];
  if (
    job.status !== "completed" ||
    !TERMINAL.has(job.conclusion) ||
    job.run_id !== run.id ||
    job.head_sha !== run.head_sha ||
    !Array.isArray(job.steps) ||
    (job.run_attempt !== undefined && job.run_attempt !== run.run_attempt)
  )
    reject();
  const cleanups = job.steps.filter((step) => step.name === CLEANUP);
  if (
    cleanups.length !== 1 ||
    cleanups[0].status !== "completed" ||
    cleanups[0].conclusion !== "success" ||
    !Number.isSafeInteger(cleanups[0].number) ||
    !Number.isFinite(Date.parse(cleanups[0].completed_at))
  )
    reject();
  return run.head_sha;
}

export function assertRetirementWorkflow(remote, reviewed) {
  if (
    typeof remote !== "string" ||
    remote !== reviewed ||
    Buffer.byteLength(remote) > MAX_BYTES ||
    remote.includes("\r")
  )
    reject();
  const jobs = remote.split(/(?=^  [A-Za-z0-9_-]+:\n)/m);
  const matches = jobs.filter((job) => job.startsWith("  expand:\n"));
  if (matches.length !== 1) reject();
  const job = matches[0];
  if (
    job.match(/^    environment:.*$/gm)?.join("\n") !==
      "    environment: production" ||
    job.match(/^    name:.*$/gm)?.join("\n") !== `    name: ${JOB}`
  )
    reject();
  const steps = job.split(/(?=^      - name: )/m);
  const cleanups = steps.filter((step) =>
    step.startsWith(`      - name: ${CLEANUP}\n`),
  );
  if (cleanups.length !== 1) reject();
  const cleanup = cleanups[0];
  if (
    cleanup.includes("continue-on-error:") ||
    !cleanup.includes(
      "        if: always() && env.DATABASE_MIGRATION_TUNNEL_STARTED == 'true'\n",
    ) ||
    !cleanup.includes("          set -euo pipefail\n")
  )
    reject();
  // Require the reviewed fixed-output root command and its complete final gate,
  // not merely the step name or a success-looking log string.
  const gate = `          output="$(node scripts/repair-image-gen-credit-migration-principal.mjs \\
            --database-app "$db_app" \\
            --database-machine-id "$DATABASE_MACHINE_ID" \\
            --operation revoke-super)"
          cleanup_status="$?"
          set -e
          if [[ "$cleanup_status" -eq 0 && "$output" = "credit_migration_principal_super_revoked" ]]; then
            exit 0
          fi
          printf '%s\\n' "credit_migration_principal_repair_cleanup_incomplete"
          exit 1`;
  if (
    !cleanup.trimEnd().endsWith(gate) ||
    !cleanup.includes("          set +e\n")
  )
    reject();
}

export function operatorEnvironment(env) {
  if (env.GITHUB_ACTIONS) reject();
  const result = { NO_COLOR: "1", GH_PROMPT_DISABLED: "1" };
  for (const key of [
    "PATH",
    "HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_DATA_HOME",
    "TMPDIR",
  ]) {
    if (typeof env[key] === "string") result[key] = env[key];
  }
  return result;
}

function commandRunner(env) {
  return (command, args) =>
    execFileSync(command, args, {
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: MAX_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
}

// Unlike flyctl's unpaginated table, this proves the whole app inventory was
// read. Fly documents that the inventory lists active tokens; absence is not
// reported as an explicit revocation timestamp. No token value is requested.
export async function readCompleteFlyTokenInventory(execute, fetcher = fetch) {
  const credential = execute("flyctl", ["auth", "token", "--quiet"]).trim();
  if (!credential || /[\r\n]/.test(credential)) reject();
  const tokens = [];
  const cursors = new Set();
  let after = null;
  for (let page = 0; page < 20; page += 1) {
    const response = await fetcher("https://api.fly.io/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({
        query:
          'query($after:String){app(name:"leaderbot-portal-mysql"){name limitedAccessTokens(first:100,after:$after){nodes{id name expiresAt revokedAt} pageInfo{hasNextPage endCursor}}}}',
        variables: { after },
      }),
    });
    const result = await response.json();
    const app = result.data?.app;
    const connection = app?.limitedAccessTokens;
    if (
      !response.ok ||
      result.errors ||
      app?.name !== APP ||
      !Array.isArray(connection?.nodes) ||
      connection.nodes.length > 100 ||
      typeof connection.pageInfo?.hasNextPage !== "boolean"
    )
      reject();
    for (const token of connection.nodes) {
      if (
        !ID.test(token?.id ?? "") ||
        typeof token.name !== "string" ||
        !token.name ||
        !Number.isFinite(Date.parse(token.expiresAt)) ||
        (token.revokedAt !== null &&
          !Number.isFinite(Date.parse(token.revokedAt))) ||
        tokens.some((existing) => existing.id === token.id)
      )
        reject();
      tokens.push({
        id: token.id,
        name: token.name,
        expiresAt: Date.parse(token.expiresAt),
        revokedAt:
          token.revokedAt === null ? null : Date.parse(token.revokedAt),
      });
    }
    if (!connection.pageInfo.hasNextPage) return tokens;
    after = connection.pageInfo.endCursor;
    if (typeof after !== "string" || !after || cursors.has(after)) reject();
    cursors.add(after);
  }
  reject();
}

export function assertProtectedCleanupWorkflow(remote, reviewed) {
  if (
    typeof remote !== "string" ||
    remote !== reviewed ||
    Buffer.byteLength(remote) > MAX_BYTES ||
    remote.includes("\r")
  )
    reject();
  const required = [
    "  workflow_dispatch:\n",
    "  group: production-deploy-image-gen\n",
    "  cancel-in-progress: false\n",
    "  cleanup:\n",
    `    name: ${MIGRATION_SUPER_CLEANUP_JOB_NAME}\n`,
    "    environment: production\n",
    '          test "$GITHUB_REF" = "refs/heads/main"',
    "assertFailedMigrationSuperPredecessor",
    "assertRunningMigrationSuperCleanup",
    "createMigrationSuperCleanupEvidence",
    "--verify-source-ci",
    'cmp "$work/predecessor-workflow.yml" .github/workflows/image-gen-schema-transition.yml',
    "--operation revoke-super)",
    "credit_migration_principal_super_revoked",
    'if [[ "$cleanup_status" -ne 0 || "$output" != "credit_migration_principal_super_revoked" ]]; then',
    'test "$MIGRATION_SUPER_REVOKED" = true',
    "canonicalJson(history) !== canonicalJson(contract.history0016)",
    "FLY_API_TOKEN: ${{ secrets.FLY_DATABASE_CLEANUP_EXEC_TOKEN }}",
    "      - name: Stop isolated database migration tunnel\n        if: always()",
  ];
  if (
    required.some((value) => !remote.includes(value)) ||
    remote
      .split("jobs:\n")[1]
      ?.match(/^  [A-Za-z0-9_-]+:\n/gm)
      ?.join("") !== "  cleanup:\n" ||
    (remote.match(/--operation /g)?.length ?? 0) !== 1 ||
    /continue-on-error:|--operation prepare|--operation apply|secrets\.FLY_DATABASE_REPAIR_EXEC_TOKEN/.test(
      remote,
    )
  )
    reject();
}

function downloadCleanupArtifact(execute, runId, artifactName) {
  const directory = mkdtempSync(
    path.join(tmpdir(), "leaderbot-cleanup-evidence-"),
  );
  try {
    execute("gh", [
      "run",
      "download",
      runId,
      "--repo",
      REPOSITORY,
      "--name",
      artifactName,
      "--dir",
      directory,
    ]);
    const files = readdirSync(directory);
    const filename = "migration-super-cleanup-evidence.json";
    if (files.length !== 1 || files[0] !== filename) reject();
    const target = path.join(directory, filename);
    const stat = lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES)
      reject();
    return JSON.parse(readFileSync(target, "utf8"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export async function retireAfterProtectedCleanup(
  expected,
  {
    execute,
    reviewedWorkflow,
    reviewedCleanupWorkflow,
    readInventory = () => readCompleteFlyTokenInventory(execute),
    readArtifact = (runId, artifactName) =>
      downloadCleanupArtifact(execute, runId, artifactName),
    now = Date.now,
  } = {},
) {
  parseRetirementArguments(
    Object.entries({
      "--run-id": expected.runId,
      "--run-attempt": expected.runAttempt,
      "--token-id": expected.tokenId,
      "--secret-updated-at": expected.secretUpdatedAt,
      "--cleanup-run-id": expected.cleanupRunId,
      "--cleanup-run-attempt": expected.cleanupRunAttempt,
      "--cleanup-token-id": expected.cleanupTokenId,
      "--cleanup-secret-updated-at": expected.cleanupSecretUpdatedAt,
      "--database-machine-id": expected.databaseMachineId,
    }).flat(),
  );
  if (
    !execute("flyctl", ["version"]).startsWith(
      `flyctl v${PINNED_FLYCTL_VERSION} `,
    )
  )
    reject();
  const api = (endpoint) =>
    JSON.parse(
      execute("gh", [
        "api",
        "--hostname",
        "github.com",
        `/repos/${REPOSITORY}/${endpoint}`,
      ]),
    );
  const source = (workflowPath, sha) => {
    const content = api(`contents/${workflowPath}?ref=${sha}`);
    if (
      content?.encoding !== "base64" ||
      content.type !== "file" ||
      content.path !== workflowPath ||
      typeof content.content !== "string" ||
      !Number.isSafeInteger(content.size) ||
      content.size < 1 ||
      content.size > MAX_BYTES
    )
      reject();
    const text = Buffer.from(content.content, "base64").toString("utf8");
    if (Buffer.byteLength(text) !== content.size) reject();
    return text;
  };
  const bundle = (id, attempt, filename) => ({
    run: api(`actions/runs/${id}`),
    jobs: api(`actions/runs/${id}/attempts/${attempt}/jobs?per_page=100`),
    latest: api(
      `actions/workflows/${filename}/runs?branch=main&event=workflow_dispatch&per_page=1`,
    ),
  });
  let binding;
  const safety = () => {
    const predecessor = bundle(
      expected.runId,
      expected.runAttempt,
      "image-gen-schema-transition.yml",
    );
    const cleanup = bundle(
      expected.cleanupRunId,
      expected.cleanupRunAttempt,
      "cleanup-image-gen-migration-super.yml",
    );
    const request = {
      predecessorRunId: expected.runId,
      predecessorRunAttempt: expected.runAttempt,
      predecessorHeadSha: predecessor.run.head_sha,
      databaseMachineId: expected.databaseMachineId,
      repairTokenId: expected.tokenId,
      repairSecretUpdatedAt: expected.secretUpdatedAt,
      cleanupTokenId: expected.cleanupTokenId,
      cleanupSecretUpdatedAt: expected.cleanupSecretUpdatedAt,
    };
    assertFailedMigrationSuperPredecessor(predecessor, request);
    const cleanupRun = {
      id: expected.cleanupRunId,
      attempt: expected.cleanupRunAttempt,
      headSha: cleanup.run.head_sha,
    };
    assertCompletedMigrationSuperCleanup(cleanup, cleanupRun);
    assertRetirementWorkflow(
      source(WORKFLOW, predecessor.run.head_sha),
      reviewedWorkflow,
    );
    assertProtectedCleanupWorkflow(
      source(MIGRATION_SUPER_CLEANUP_WORKFLOW_PATH, cleanup.run.head_sha),
      reviewedCleanupWorkflow,
    );
    const environment = api(`environments/${ENVIRONMENT}`);
    if (
      environment?.name !== ENVIRONMENT ||
      environment.can_admins_bypass !== false ||
      environment.deployment_branch_policy?.protected_branches !== true ||
      !environment.protection_rules?.some(
        (rule) =>
          rule.type === "required_reviewers" && rule.reviewers?.length > 0,
      )
    )
      reject();
    const artifacts = api(
      `actions/runs/${expected.cleanupRunId}/artifacts?per_page=100`,
    );
    if (
      !Array.isArray(artifacts.artifacts) ||
      artifacts.total_count !== artifacts.artifacts.length ||
      artifacts.total_count > 100
    )
      reject();
    const artifactName = `image-gen-migration-super-cleanup-${expected.cleanupRunId}-${expected.cleanupRunAttempt}`;
    const matches = artifacts.artifacts.filter(
      (item) => item.name === artifactName,
    );
    const artifact = matches[0];
    if (
      matches.length !== 1 ||
      artifact.expired !== false ||
      !Number.isSafeInteger(artifact.id) ||
      !Number.isSafeInteger(artifact.size_in_bytes) ||
      artifact.size_in_bytes < 1 ||
      artifact.size_in_bytes > MAX_BYTES ||
      artifact.workflow_run?.id !== Number(expected.cleanupRunId) ||
      artifact.workflow_run?.head_sha !== cleanupRun.headSha ||
      !/^sha256:[a-f0-9]{64}$/.test(artifact.digest ?? "")
    )
      reject();
    const current = JSON.stringify({
      request,
      cleanupRun,
      artifactId: artifact.id,
      digest: artifact.digest,
    });
    if (binding !== undefined && binding !== current) reject();
    binding = current;
    return { request, cleanupRun, artifactName };
  };
  const checked = safety();
  const evidence = assertMigrationSuperCleanupEvidence(
    readArtifact(expected.cleanupRunId, checked.artifactName),
    checked,
  );
  if (
    Date.parse(evidence.completedAt) > now() + 60_000 ||
    Date.parse(evidence.completedAt) <
      Date.parse(expected.cleanupSecretUpdatedAt)
  )
    reject();
  safety();
  const targets = [
    {
      id: expected.tokenId,
      name: `leaderbot-pr486-repair-${expected.runId}`,
      secret: SECRET,
      updatedAt: expected.secretUpdatedAt,
    },
    {
      id: expected.cleanupTokenId,
      name: `leaderbot-pr486-cleanup-${expected.runId}`,
      secret: CLEANUP_SECRET,
      updatedAt: expected.cleanupSecretUpdatedAt,
    },
  ];
  const secret = (target) => {
    const values = JSON.parse(
      execute("gh", [
        "secret",
        "list",
        "--repo",
        REPOSITORY,
        "--env",
        ENVIRONMENT,
        "--json",
        "name,updatedAt",
      ]),
    );
    if (
      !Array.isArray(values) ||
      values.some((item) => typeof item.name !== "string") ||
      new Set(values.map((item) => item.name)).size !== values.length
    )
      reject();
    const found = values.find((item) => item.name === target.secret);
    if (found && found.updatedAt !== target.updatedAt) reject();
    return found?.updatedAt ?? null;
  };
  const inventory = async (target) => {
    const tokens = await readInventory();
    const matches = tokens.filter(
      (token) => token.id === target.id || token.name === target.name,
    );
    if (matches.length === 0) {
      // Only the separate completed-cleanup path accepts an old absent token,
      // and only after its documented four-hour maximum validity window. This
      // is inventory absence, never a fabricated revokedAt value.
      if (now() < Date.parse(target.updatedAt) + 4 * 60 * 60 * 1000 + 1000)
        reject();
      return null;
    }
    if (
      matches.length !== 1 ||
      matches[0].id !== target.id ||
      matches[0].name !== target.name ||
      !Number.isFinite(matches[0].expiresAt) ||
      matches[0].expiresAt >
        Date.parse(target.updatedAt) + 4 * 60 * 60 * 1000 + 1000 ||
      (matches[0].revokedAt !== null &&
        (!Number.isFinite(matches[0].revokedAt) ||
          matches[0].revokedAt > now() + 60_000))
    )
      reject();
    return matches[0];
  };
  // Reject all replacement identities before any mutation; retirement of one
  // target can then be retried without recreating or overwriting either key.
  for (const target of targets) {
    await inventory(target);
    secret(target);
  }
  for (const target of targets) {
    safety();
    const stamp = secret(target);
    const before = await inventory(target);
    if (before?.revokedAt === null) {
      try {
        execute("flyctl", ["tokens", "revoke", target.id]);
      } catch {
        /* readback decides */
      }
      const after = await inventory(target);
      if (after?.revokedAt === null) reject();
    }
    safety();
    if (secret(target) !== stamp) reject();
    if (stamp !== null) {
      try {
        execute("gh", [
          "secret",
          "delete",
          target.secret,
          "--repo",
          REPOSITORY,
          "--env",
          ENVIRONMENT,
        ]);
      } catch {
        /* readback decides */
      }
    }
    if (secret(target) !== null) reject();
  }
  return "repair_and_cleanup_exec_tokens_retired";
}

export function retireRepairExecToken(
  expected,
  { execute, reviewedWorkflow, now = Date.now } = {},
) {
  // Revalidate injected callers too. All subprocess output remains in memory.
  parseRetirementArguments([
    "--run-id",
    expected?.runId,
    "--run-attempt",
    expected?.runAttempt,
    "--token-id",
    expected?.tokenId,
    "--secret-updated-at",
    expected?.secretUpdatedAt,
  ]);
  const version = execute("flyctl", ["version"]);
  if (
    !new RegExp(
      `^flyctl v${PINNED_FLYCTL_VERSION.replaceAll(".", "\\.")}(?: |\\n|$)`,
    ).test(version)
  )
    reject();
  const api = (path) =>
    JSON.parse(
      execute("gh", [
        "api",
        "--hostname",
        "github.com",
        `/repos/${REPOSITORY}/${path}`,
      ]),
    );
  const inventory = () =>
    selectToken(
      parseFlyTokenInventory(
        execute("flyctl", ["tokens", "list", "--app", APP, "--scope", "app"]),
      ),
      expected,
      now(),
    );
  const secret = () => {
    const secrets = JSON.parse(
      execute("gh", [
        "secret",
        "list",
        "--repo",
        REPOSITORY,
        "--env",
        ENVIRONMENT,
        "--json",
        "name,updatedAt",
      ]),
    );
    if (
      !Array.isArray(secrets) ||
      secrets.some((item) => typeof item?.name !== "string") ||
      new Set(secrets.map((item) => item.name)).size !== secrets.length
    )
      reject();
    const found = secrets.find((item) => item.name === SECRET);
    if (
      found &&
      (!validTimestamp(found.updatedAt) ||
        found.updatedAt !== expected.secretUpdatedAt)
    )
      reject();
    return found?.updatedAt ?? null;
  };
  let expectedHead;
  const safety = () => {
    const run = api(`actions/runs/${expected.runId}`);
    const jobs = api(
      `actions/runs/${expected.runId}/attempts/${expected.runAttempt}/jobs?per_page=100`,
    );
    const latest = api(
      `actions/workflows/image-gen-schema-transition.yml/runs?per_page=1`,
    );
    const head = assertRetirementRun(run, jobs, latest, expected);
    if (expectedHead !== undefined && head !== expectedHead) reject();
    expectedHead = head;
    const content = api(`contents/${WORKFLOW}?ref=${head}`);
    if (
      content?.encoding !== "base64" ||
      typeof content.content !== "string" ||
      content.type !== "file" ||
      content.path !== WORKFLOW ||
      !Number.isSafeInteger(content.size) ||
      content.size > MAX_BYTES
    )
      reject();
    const workflow = Buffer.from(content.content, "base64").toString("utf8");
    if (Buffer.byteLength(workflow) !== content.size) reject();
    assertRetirementWorkflow(workflow, reviewedWorkflow);
    const environment = api(`environments/${ENVIRONMENT}`);
    if (
      environment?.name !== ENVIRONMENT ||
      environment.can_admins_bypass !== false ||
      environment.deployment_branch_policy?.protected_branches !== true ||
      !Array.isArray(environment.protection_rules) ||
      !environment.protection_rules.some(
        (rule) =>
          rule.type === "required_reviewers" &&
          Array.isArray(rule.reviewers) &&
          rule.reviewers.length > 0,
      )
    )
      reject();
  };

  safety();
  const before = inventory();
  const originalSecret = secret();
  if (before.revokedAt === null) {
    // Preserve grant-cleanup access if the run was retried or replaced while
    // collecting metadata. The operator must not dispatch concurrently.
    safety();
    const refreshed = inventory();
    if (refreshed.expiresAt !== before.expiresAt || secret() !== originalSecret)
      reject();
    if (refreshed.revokedAt === null) {
      try {
        execute("flyctl", ["tokens", "revoke", expected.tokenId]);
      } catch {
        /* readback decides */
      }
    }
  }
  if (inventory().revokedAt === null) reject();
  safety();
  if (secret() !== originalSecret) reject();
  if (originalSecret !== null) {
    try {
      execute("gh", [
        "secret",
        "delete",
        SECRET,
        "--repo",
        REPOSITORY,
        "--env",
        ENVIRONMENT,
      ]);
    } catch {
      /* readback decides */
    }
  }
  if (secret() !== null) reject();
  return "repair_exec_token_retired";
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const expected = parseRetirementArguments(process.argv.slice(2));
    const env = operatorEnvironment(process.env);
    const reviewedWorkflow = readFileSync(
      new URL(`../${WORKFLOW}`, import.meta.url),
      "utf8",
    );
    const execute = commandRunner(env);
    const result = expected.cleanupRunId
      ? await retireAfterProtectedCleanup(expected, {
          execute,
          reviewedWorkflow,
          reviewedCleanupWorkflow: readFileSync(
            new URL(
              `../${MIGRATION_SUPER_CLEANUP_WORKFLOW_PATH}`,
              import.meta.url,
            ),
            "utf8",
          ),
        })
      : retireRepairExecToken(expected, { execute, reviewedWorkflow });
    process.stdout.write(`${result}\n`);
  } catch {
    // No provider messages, inventory rows, credentials, or workflow logs.
    process.stdout.write("repair_exec_token_retirement_failed\n");
    process.exitCode = 1;
  }
}
