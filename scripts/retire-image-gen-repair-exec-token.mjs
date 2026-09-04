#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { PINNED_FLYCTL_VERSION } from "./provision-image-gen-credit-provisioner.mjs";

const REPOSITORY = "Dj-Shortcut/openclaw-facebook";
const APP = "leaderbot-portal-mysql";
const ENVIRONMENT = "production";
const SECRET = "FLY_DATABASE_REPAIR_EXEC_TOKEN";
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
  ]);
  if (!Array.isArray(argv) || argv.length !== 8) reject();
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
  const name = `leaderbot-pr486-repair-${expected.runId}`;
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
    process.stdout.write(
      `${retireRepairExecToken(expected, { execute: commandRunner(env), reviewedWorkflow })}\n`,
    );
  } catch {
    // No provider messages, inventory rows, credentials, or workflow logs.
    process.stdout.write("repair_exec_token_retirement_failed\n");
    process.exitCode = 1;
  }
}
