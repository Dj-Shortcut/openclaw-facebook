import { spawnSync } from "node:child_process";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepareGatewayConfig: vi.fn(),
  verifyGatewayStateRehearsalConfig: vi.fn(),
  verifyGatewayStateRehearsalMarker: vi.fn(),
}));

vi.mock("./bin/start-gateway.mjs", () => ({
  prepareGatewayConfig: mocks.prepareGatewayConfig,
  verifyGatewayStateRehearsalConfig:
    mocks.verifyGatewayStateRehearsalConfig,
  verifyGatewayStateRehearsalMarker:
    mocks.verifyGatewayStateRehearsalMarker,
}));

import { runMountedStateRehearsalCli } from "./bin/rehearse-mounted-state.mjs";

const scriptPath = path.resolve(
  "deploy/fly-gateway/bin/rehearse-mounted-state.mjs",
);
const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("mounted gateway state rehearsal CLI", () => {
  it("applies the canonical gateway configuration", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await runMountedStateRehearsalCli(["--apply"]);

    expect(mocks.prepareGatewayConfig).toHaveBeenCalledOnce();
    expect(mocks.prepareGatewayConfig).toHaveBeenCalledWith();
    expect(mocks.verifyGatewayStateRehearsalConfig).not.toHaveBeenCalled();
    expect(mocks.verifyGatewayStateRehearsalMarker).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith("gateway_mounted_state_apply_ok\n");
  });

  it("verifies the canonical gateway configuration without mutating it", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await runMountedStateRehearsalCli(["--verify"]);

    expect(mocks.prepareGatewayConfig).toHaveBeenCalledOnce();
    expect(mocks.prepareGatewayConfig).toHaveBeenCalledWith({
      verifyOnly: true,
    });
    expect(mocks.verifyGatewayStateRehearsalConfig).not.toHaveBeenCalled();
    expect(mocks.verifyGatewayStateRehearsalMarker).not.toHaveBeenCalled();
    expect(stdout).toHaveBeenCalledWith("gateway_mounted_state_verify_ok\n");
  });

  it("verifies the running rehearsal, exact start count, and loopback health", async () => {
    const cancel = vi.fn(async () => undefined);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      body: { cancel },
    }));
    globalThis.fetch = fetchMock;
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await runMountedStateRehearsalCli([
      "--verify-running",
      "--expected-starts",
      "2",
    ]);

    expect(mocks.prepareGatewayConfig).toHaveBeenCalledWith({
      verifyOnly: true,
    });
    expect(mocks.verifyGatewayStateRehearsalConfig).toHaveBeenCalledOnce();
    expect(mocks.verifyGatewayStateRehearsalMarker).toHaveBeenCalledWith(2);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:3000/healthz");
    expect(cancel).toHaveBeenCalledOnce();
    expect(stdout).toHaveBeenCalledWith("gateway_mounted_state_running_ok\n");
  });

  it("fails when the running rehearsal health endpoint is not ready", async () => {
    const cancel = vi.fn(async () => undefined);
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      body: { cancel },
    }));

    await expect(
      runMountedStateRehearsalCli([
        "--verify-running",
        "--expected-starts",
        "1",
      ]),
    ).rejects.toThrow("Gateway state rehearsal health check failed");

    expect(cancel).not.toHaveBeenCalled();
  });

  it.each(["", "0", "-1", "1.5", "not-a-number"])(
    "rejects an invalid exact start count %j",
    async expectedStarts => {
      await expect(
        runMountedStateRehearsalCli([
          "--verify-running",
          "--expected-starts",
          expectedStarts,
        ]),
      ).rejects.toThrow("--expected-starts must be a positive integer");

      expect(mocks.prepareGatewayConfig).not.toHaveBeenCalled();
      expect(mocks.verifyGatewayStateRehearsalConfig).not.toHaveBeenCalled();
      expect(mocks.verifyGatewayStateRehearsalMarker).not.toHaveBeenCalled();
    },
  );

  it("rejects unsupported argument shapes before touching gateway state", async () => {
    await expect(
      runMountedStateRehearsalCli(["--verify-running"]),
    ).rejects.toThrow(
      "Usage: rehearse-mounted-state.mjs --apply | --verify | --verify-running --expected-starts <count>",
    );

    expect(mocks.prepareGatewayConfig).not.toHaveBeenCalled();
  });

  it("reports invalid CLI usage through the executable entry point", () => {
    const result = spawnSync(process.execPath, [scriptPath, "--unknown"], {
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      "Usage: rehearse-mounted-state.mjs --apply | --verify | --verify-running --expected-starts <count>\n",
    );
  });
});
