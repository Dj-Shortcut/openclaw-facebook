import { pathToFileURL } from "node:url";

const MAX_INPUT_BYTES = 1024 * 1024;
const PENDING_STATES = new Set(["created", "starting", "started", "stopping"]);
const RESULTS = {
  success: { marker: "mysql_restore_probe_verified", code: 0 },
  pending: { marker: "mysql_restore_probe_pending", code: 2 },
  failure: { marker: "mysql_restore_probe_failed", code: 1 },
};

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFalseOrOmitted(value) {
  return value === undefined || value === false;
}

function validExpected(expected) {
  return (
    isObject(expected) &&
    typeof expected.machineId === "string" &&
    /^[a-f0-9]{14}$/.test(expected.machineId) &&
    typeof expected.volumeId === "string" &&
    /^vol_[a-z0-9]+$/.test(expected.volumeId) &&
    typeof expected.runId === "string" &&
    /^[1-9][0-9]{0,19}$/.test(expected.runId) &&
    typeof expected.runAttempt === "string" &&
    /^[1-9][0-9]{0,19}$/.test(expected.runAttempt)
  );
}

export function classifyFlyRestoreProbe(machine, expected) {
  if (!validExpected(expected)) {
    return "failure";
  }
  const name = `leaderbot-restore-probe-${expected.runId}-${expected.runAttempt}`;
  if (
    !isObject(machine) ||
    machine.id !== expected.machineId ||
    machine.name !== name ||
    !isObject(machine.config) ||
    machine.config.metadata?.leaderbot_restore_probe !== expected.runId ||
    machine.config.metadata?.leaderbot_restore_probe_attempt !==
      expected.runAttempt ||
    !Array.isArray(machine.config.mounts) ||
    machine.config.mounts.length !== 1 ||
    machine.config.mounts[0]?.volume !== expected.volumeId ||
    machine.config.mounts[0]?.path !== "/var/lib/mysql" ||
    machine.config.restart?.policy !== "no" ||
    !isFalseOrOmitted(machine.config.auto_destroy) ||
    (machine.host_status !== undefined && machine.host_status !== "ok")
  ) {
    return "failure";
  }
  if (PENDING_STATES.has(machine.state)) {
    return "pending";
  }
  if (
    machine.state !== "stopped" ||
    !Array.isArray(machine.events) ||
    !machine.events.every(isObject)
  ) {
    return "failure";
  }
  const exits = machine.events.filter((event) => event.type === "exit");
  if (exits.length !== 1) {
    return "failure";
  }
  const event = exits[0];
  const exit = event.request?.exit_event;
  // flyctl v0.4.85 uses fly-go v0.9.4. MachineExitEvent marks false
  // booleans omitempty, so absence is valid for those fields. Never default
  // an absent exit_code to zero: callers must supply the raw Machines GET
  // response, not flyctl's lossy JSON remarshal.
  // https://github.com/superfly/fly-go/blob/v0.9.4/machine_types.go
  if (
    event.status !== "stopped" ||
    event.source !== "flyd" ||
    !Number.isSafeInteger(event.timestamp) ||
    event.timestamp <= 0 ||
    !isObject(event.request) ||
    event.request.MonitorEvent !== undefined ||
    !isObject(exit) ||
    exit.exit_code !== 0 ||
    !isFalseOrOmitted(exit.oom_killed) ||
    !isFalseOrOmitted(exit.requested_stop) ||
    !isFalseOrOmitted(exit.restarting) ||
    (exit.guest_exit_code !== undefined && exit.guest_exit_code !== 0) ||
    (event.request.restart_count !== undefined &&
      event.request.restart_count !== 0) ||
    [exit.signal, exit.guest_signal].some(
      (signal) => signal !== undefined && signal !== -1 && signal !== 0,
    ) ||
    [exit.error, exit.guest_error].some(
      (error) => error !== undefined && error !== "",
    )
  ) {
    return "failure";
  }
  return "success";
}

export function flyMachinesAuthorization(token) {
  if (typeof token !== "string" || /[\r\n]/.test(token)) {
    throw new Error("invalid token");
  }
  // Match fly-go v0.9.4 Tokens.Parse + FlapsHeader: schemes are optional,
  // macaroons take precedence over OAuth tokens on the Machines API.
  // https://github.com/superfly/fly-go/blob/v0.9.4/tokens/tokens.go
  const stripped = token.trim().replace(/^(?:(?:Bearer|FlyV1)\s+)+/i, "");
  const tokens = stripped.split(",").map((value) => value.trim());
  if (
    tokens.some(
      (value) => !value || /\s/.test(value) || /^(Bearer|FlyV1)$/i.test(value),
    )
  ) {
    throw new Error("invalid token");
  }
  const macaroons = tokens.filter((value) => /^(fm1r|fm1a|fm2)_/.test(value));
  return macaroons.length > 0
    ? `FlyV1 ${macaroons.join(",")}`
    : `Bearer ${tokens.join(",")}`;
}

async function readBoundedBody(stream) {
  if (!stream) {
    throw new Error("missing body");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_INPUT_BYTES) {
      throw new Error("oversized body");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function fetchFlyRestoreProbe(
  expected,
  { token, fetchImpl = fetch } = {},
) {
  if (
    !validExpected(expected) ||
    typeof expected.app !== "string" ||
    !/^[a-z][a-z0-9-]{1,62}$/.test(expected.app)
  ) {
    return "failure";
  }
  let authorization;
  try {
    authorization = flyMachinesAuthorization(token);
  } catch {
    return "failure";
  }
  let response;
  let body;
  try {
    response = await fetchImpl(
      `https://api.machines.dev/v1/apps/${expected.app}/machines/${expected.machineId}`,
      {
        method: "GET",
        headers: { authorization, accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return response.status === 401 || response.status === 403
        ? "failure"
        : "pending";
    }
    body = await readBoundedBody(response.body);
  } catch (error) {
    // Only an explicitly oversized/missing body is a validation failure;
    // network failures and the shared fetch/body deadline can be retried.
    return error?.message === "oversized body" ||
      error?.message === "missing body"
      ? "failure"
      : "pending";
  }
  try {
    return classifyFlyRestoreProbe(JSON.parse(body), expected);
  } catch {
    return "failure";
  }
}

async function runCli(argv) {
  const names = new Map([
    ["--machine-id", "machineId"],
    ["--volume-id", "volumeId"],
    ["--run-id", "runId"],
    ["--run-attempt", "runAttempt"],
    ["--app", "app"],
  ]);
  if (argv.length !== 8 && argv.length !== 10) {
    return "failure";
  }
  const expected = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = names.get(argv[index]);
    if (!name || Object.hasOwn(expected, name)) {
      return "failure";
    }
    expected[name] = argv[index + 1];
  }
  if (Object.hasOwn(expected, "app")) {
    return fetchFlyRestoreProbe(expected, { token: process.env.FLY_API_TOKEN });
  }
  return classifyFlyRestoreProbe(
    JSON.parse(await readBoundedBody(process.stdin)),
    expected,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  let state = "failure";
  try {
    state = await runCli(process.argv.slice(2));
  } catch {
    // Never include API bodies, Machine config, or input errors in CI logs.
  }
  process.stdout.write(`${RESULTS[state].marker}\n`);
  process.exitCode = RESULTS[state].code;
}
