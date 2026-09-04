import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import {
  classifyFlyRestoreProbe,
  fetchFlyRestoreProbe,
  flyMachinesAuthorization,
} from "./fly-restore-probe-status.mjs";

const expected = {
  machineId: "a123456789abcd",
  volumeId: "vol_test123",
  runId: "123456789",
  runAttempt: "2",
};

function machine() {
  return {
    id: expected.machineId,
    name: `leaderbot-restore-probe-${expected.runId}-${expected.runAttempt}`,
    state: "stopped",
    host_status: "ok",
    config: {
      metadata: {
        leaderbot_restore_probe: expected.runId,
        leaderbot_restore_probe_attempt: expected.runAttempt,
      },
      mounts: [{ volume: expected.volumeId, path: "/var/lib/mysql" }],
      restart: { policy: "no" },
      auto_destroy: false,
    },
    events: [
      {
        type: "exit",
        status: "stopped",
        source: "flyd",
        timestamp: 1788512401000,
        request: {
          restart_count: 0,
          exit_event: {
            exit_code: 0,
            guest_exit_code: 0,
            oom_killed: false,
            requested_stop: false,
            restarting: false,
            signal: -1,
            guest_signal: -1,
            error: "",
            guest_error: "",
          },
        },
      },
      { type: "start", status: "started", source: "flyd" },
    ],
  };
}

describe("isolated Fly restore probe status", () => {
  it("verifies one natural successful exit of the exact one-shot probe", () => {
    expect(classifyFlyRestoreProbe(machine(), expected)).toBe("success");
  });

  it("allows omitted false booleans, but still requires explicit exit code", () => {
    const value = machine();
    value.events[0].request = { exit_event: { exit_code: 0 } };
    delete value.config.auto_destroy;
    expect(classifyFlyRestoreProbe(value, expected)).toBe("success");
    delete value.events[0].request.exit_event.exit_code;
    expect(classifyFlyRestoreProbe(value, expected)).toBe("failure");
  });

  it.each(["created", "starting", "started", "stopping"])(
    "waits while the exact probe is %s without requiring an observed start",
    (state) => {
      const value = machine();
      value.state = state;
      delete value.events;
      expect(classifyFlyRestoreProbe(value, expected)).toBe("pending");
    },
  );

  it.each(["failed", "suspended", "destroyed", "destroying", "unknown", null])(
    "rejects unsuccessful or unknown terminal state %s",
    (state) => {
      const value = machine();
      value.state = state;
      expect(classifyFlyRestoreProbe(value, expected)).toBe("failure");
    },
  );

  it.each([
    ["exit_code", 1],
    ["exit_code", "0"],
    ["exit_code", null],
    ["exit_code", undefined],
    ["oom_killed", true],
    ["oom_killed", "false"],
    ["oom_killed", null],
    ["requested_stop", true],
    ["requested_stop", "false"],
    ["requested_stop", 0],
    ["requested_stop", null],
    ["restarting", true],
    ["restarting", "false"],
    ["guest_exit_code", 1],
    ["guest_exit_code", "0"],
    ["signal", 15],
    ["guest_signal", 9],
    ["error", "failure"],
    ["guest_error", "failure"],
  ])("rejects invalid exit field %s=%s", (key, field) => {
    const value = machine();
    value.events[0].request.exit_event[key] = field;
    expect(classifyFlyRestoreProbe(value, expected)).toBe("failure");
  });

  it.each([
    ["id", "b123456789abcd"],
    ["name", "leaderbot-production-db"],
    ["host_status", "unreachable"],
  ])("rejects Machine binding field %s=%s", (key, field) => {
    const value = machine();
    value[key] = field;
    expect(classifyFlyRestoreProbe(value, expected)).toBe("failure");
  });

  it.each([
    (value) => {
      value.config.metadata.leaderbot_restore_probe = "123";
    },
    (value) => {
      value.config.metadata.leaderbot_restore_probe_attempt = "1";
    },
    (value) => {
      value.config.mounts[0].volume = "vol_other";
    },
    (value) => {
      value.config.mounts[0].path = "/wrong";
    },
    (value) => {
      value.config.mounts.push({ volume: "vol_other", path: "/other" });
    },
    (value) => {
      value.config.restart.policy = "always";
    },
    (value) => {
      value.config.auto_destroy = true;
    },
    (value) => {
      value.config.auto_destroy = "false";
    },
    (value) => {
      value.config = null;
    },
  ])("rejects wrong ownership, mount or lifecycle configuration", (mutate) => {
    const value = machine();
    mutate(value);
    expect(classifyFlyRestoreProbe(value, expected)).toBe("failure");
    value.state = "started";
    expect(classifyFlyRestoreProbe(value, expected)).toBe("failure");
  });

  it.each([
    (value) => {
      delete value.events;
    },
    (value) => {
      value.events = [];
    },
    (value) => {
      value.events.push(value.events[0]);
    },
    (value) => {
      value.events.push(null);
    },
    (value) => {
      value.events[0].request = {};
    },
    (value) => {
      value.events[0].request.exit_event = null;
    },
    (value) => {
      value.events[0].request.restart_count = 1;
    },
    (value) => {
      value.events[0].request.MonitorEvent = {};
    },
    (value) => {
      value.events[0].source = "user";
    },
    (value) => {
      value.events[0].status = "started";
    },
    (value) => {
      value.events[0].timestamp = "1788512401000";
    },
    (value) => {
      value.events[0].timestamp = 0;
    },
  ])("rejects missing, ambiguous, or malformed exit evidence", (mutate) => {
    const value = machine();
    mutate(value);
    expect(classifyFlyRestoreProbe(value, expected)).toBe("failure");
  });

  it.each([null, [], {}, { ...expected, runAttempt: "0" }])(
    "rejects malformed expected bindings",
    (binding) => {
      expect(classifyFlyRestoreProbe(machine(), binding)).toBe("failure");
    },
  );
});

describe("restore probe CLI", () => {
  const script = fileURLToPath(
    new URL("./fly-restore-probe-status.mjs", import.meta.url),
  );
  const args = [
    "--machine-id",
    expected.machineId,
    "--volume-id",
    expected.volumeId,
    "--run-id",
    expected.runId,
    "--run-attempt",
    expected.runAttempt,
  ];
  const run = (input, argv = args) =>
    spawnSync(process.execPath, [script, ...argv], {
      input: typeof input === "string" ? input : JSON.stringify(input),
      encoding: "utf8",
      timeout: 5000,
    });

  it.each([
    ["stopped", 0, "mysql_restore_probe_verified"],
    ["started", 2, "mysql_restore_probe_pending"],
    ["failed", 1, "mysql_restore_probe_failed"],
  ])("reports metadata-only %s status with exit %s", (state, code, marker) => {
    const value = machine();
    value.state = state;
    const result = run(value);
    expect(result.status).toBe(code);
    expect(result.stdout).toBe(`${marker}\n`);
    expect(result.stderr).toBe("");
  });

  it.each([
    ["{invalid-private-input", args],
    ["x".repeat(1024 * 1024 + 1), args],
    ["{}", []],
    ["{}", [...args.slice(0, 6), "--run-id", expected.runId]],
    ["{}", [...args.slice(0, 6), "--unknown", "sensitive-value"]],
  ])(
    "fails closed without printing malformed input or arguments",
    (input, argv) => {
      const result = run(input, argv);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("mysql_restore_probe_failed\n");
      expect(result.stderr).toBe("");
    },
  );

  it("does not accept a token from CLI arguments", () => {
    const result = run("", [...args, "--token", "sensitive-value"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("mysql_restore_probe_failed\n");
    expect(result.stderr).toBe("");
  });
});

describe("Machines API authentication normalization", () => {
  it.each([
    ["oauth-example", "Bearer oauth-example"],
    ["Bearer oauth-example", "Bearer oauth-example"],
    ["FlyV1 oauth-example", "Bearer oauth-example"],
    ["fm2_example", "FlyV1 fm2_example"],
    ["FlyV1 fm2_example", "FlyV1 fm2_example"],
    ["Bearer FlyV1 fm2_example", "FlyV1 fm2_example"],
    ["  flyv1  fm2_example  ", "FlyV1 fm2_example"],
    ["fm1a_example, fm1r_example", "FlyV1 fm1a_example,fm1r_example"],
    ["oauth-example, fm2_example", "FlyV1 fm2_example"],
  ])("normalizes only synthetic credential %s", (token, header) => {
    expect(flyMachinesAuthorization(token)).toBe(header);
  });

  it.each([undefined, null, "", " ", "Bearer ", "fm2_x\n", "fm2_x,", "a b"])(
    "rejects invalid or empty credentials",
    (token) => {
      expect(() => flyMachinesAuthorization(token)).toThrow("invalid token");
    },
  );
});

describe("bounded read-only Machines API poll", () => {
  const binding = { ...expected, app: "leaderbot-portal-mysql" };
  const token = "FlyV1 fm2_synthetic-test-only";

  it("fetches only the exact HTTPS Machine using normalized headers", async () => {
    const fetchImpl = vi.fn(async () => Response.json(machine()));
    expect(await fetchFlyRestoreProbe(binding, { token, fetchImpl })).toBe(
      "success",
    );
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe(
      `https://api.machines.dev/v1/apps/${binding.app}/machines/${binding.machineId}`,
    );
    expect(options).toEqual({
      method: "GET",
      headers: {
        authorization: token,
        accept: "application/json",
      },
      redirect: "error",
      signal: expect.any(AbortSignal),
    });
  });

  it.each([401, 403])(
    "fails permanently for unauthorized HTTP %s",
    async (status) => {
      const fetchImpl = vi.fn(
        async () => new Response("private error body", { status }),
      );
      expect(await fetchFlyRestoreProbe(binding, { token, fetchImpl })).toBe(
        "failure",
      );
    },
  );

  it.each([404, 429, 500, 503])(
    "retries HTTP %s without reading error bodies",
    async (status) => {
      let canceled = false;
      const stream = new ReadableStream({
        cancel() {
          canceled = true;
        },
      });
      const fetchImpl = vi.fn(async () => new Response(stream, { status }));
      expect(await fetchFlyRestoreProbe(binding, { token, fetchImpl })).toBe(
        "pending",
      );
      expect(canceled).toBe(true);
    },
  );

  it("retries transport failures without leaking messages", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("private transport detail");
    });
    expect(await fetchFlyRestoreProbe(binding, { token, fetchImpl })).toBe(
      "pending",
    );
  });

  it("enforces a 20 second shared request and body deadline", async () => {
    const deadline = vi.spyOn(AbortSignal, "timeout");
    try {
      const fetchImpl = vi.fn(async () => Response.json(machine()));
      expect(await fetchFlyRestoreProbe(binding, { token, fetchImpl })).toBe(
        "success",
      );
      expect(deadline).toHaveBeenCalledWith(20_000);
    } finally {
      deadline.mockRestore();
    }
  });

  it.each(["{private-invalid-json", "x".repeat(1024 * 1024 + 1)])(
    "fails closed on invalid or oversized API JSON",
    async (body) => {
      const fetchImpl = vi.fn(async () => new Response(body));
      expect(await fetchFlyRestoreProbe(binding, { token, fetchImpl })).toBe(
        "failure",
      );
    },
  );

  it.each([
    { ...binding, app: "evil.example/path" },
    { ...binding, app: "leaderbot-portal-mysql?foo=bar" },
    { ...binding, machineId: "../machines" },
    { ...binding, volumeId: "wrong" },
  ])(
    "does not fetch an invalid target or incomplete binding",
    async (invalid) => {
      const fetchImpl = vi.fn();
      expect(await fetchFlyRestoreProbe(invalid, { token, fetchImpl })).toBe(
        "failure",
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it("does not fetch without a usable environment credential", async () => {
    const fetchImpl = vi.fn();
    expect(await fetchFlyRestoreProbe(binding, { fetchImpl })).toBe("failure");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
