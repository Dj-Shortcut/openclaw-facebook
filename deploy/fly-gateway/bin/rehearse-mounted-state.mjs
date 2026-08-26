#!/usr/bin/env node
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  prepareGatewayConfig,
  verifyGatewayStateRehearsalConfig,
  verifyGatewayStateRehearsalMarker,
} from "./start-gateway.mjs";

function parseExpectedStarts(args) {
  const index = args.indexOf("--expected-starts");
  const raw = index >= 0 ? args[index + 1] : "";
  const expected = Number(raw);
  if (!Number.isSafeInteger(expected) || expected < 1) {
    throw new Error("--expected-starts must be a positive integer");
  }
  return expected;
}

export async function runMountedStateRehearsalCli(args = process.argv.slice(2)) {
  if (args.length === 1 && args[0] === "--apply") {
    prepareGatewayConfig();
    process.stdout.write("gateway_mounted_state_apply_ok\n");
    return;
  }
  if (args.length === 1 && args[0] === "--verify") {
    prepareGatewayConfig({ verifyOnly: true });
    process.stdout.write("gateway_mounted_state_verify_ok\n");
    return;
  }
  if (
    args.length === 3 &&
    args[0] === "--verify-running" &&
    args[1] === "--expected-starts"
  ) {
    const expectedStarts = parseExpectedStarts(args);
    prepareGatewayConfig({ verifyOnly: true });
    verifyGatewayStateRehearsalConfig();
    verifyGatewayStateRehearsalMarker(expectedStarts);
    const response = await fetch("http://127.0.0.1:3000/healthz");
    if (!response.ok) {
      throw new Error("Gateway state rehearsal health check failed");
    }
    await response.body?.cancel();
    process.stdout.write("gateway_mounted_state_running_ok\n");
    return;
  }
  throw new Error(
    "Usage: rehearse-mounted-state.mjs --apply | --verify | --verify-running --expected-starts <count>",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runMountedStateRehearsalCli().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Gateway state rehearsal failed"}\n`,
    );
    process.exitCode = 1;
  });
}
