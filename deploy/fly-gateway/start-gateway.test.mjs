import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildGatewayLaunchPlan,
  startPublicRouteGuard,
} from "./bin/public-route-guard.mjs";

const scriptPath = path.resolve("deploy/fly-gateway/bin/start-gateway.mjs");
const originalEnv = { ...process.env };
const prepareGatewayConfigTimeoutMs = 30000;

afterEach(() => {
  process.env = { ...originalEnv };
});

function configureTempGatewayEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-fly-start-"));
  const stateDir = path.join(root, "data");
  const workspaceDir = path.join(stateDir, "workspace");
  const homeDir = path.join(root, "home");
  process.env.OPENCLAW_STATE_DIR = stateDir;
  process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
  process.env.OPENCLAW_WORKSPACE_DIR = workspaceDir;
  process.env.OPENCLAW_AGENT_MODEL = "openai/gpt-5.4-mini";
  process.env.OPENCLAW_AGENT_THINKING_DEFAULT = "low";
  process.env.HOME = homeDir;
  return { root, stateDir, workspaceDir, homeDir };
}

function runPrepareGatewayConfig(env) {
  const script = `
    import fs from "node:fs";
    import { pathToFileURL } from "node:url";
    const mod = await import(pathToFileURL(process.env.START_GATEWAY_SCRIPT).href);
    const config = mod.prepareGatewayConfig();
    console.log(JSON.stringify({
      config,
      workspaceExists: fs.existsSync(process.env.OPENCLAW_WORKSPACE_DIR),
      agents: fs.existsSync(process.env.OPENCLAW_WORKSPACE_DIR + "/AGENTS.md")
        ? fs.readFileSync(process.env.OPENCLAW_WORKSPACE_DIR + "/AGENTS.md", "utf8")
        : null,
      user: fs.existsSync(process.env.OPENCLAW_WORKSPACE_DIR + "/USER.md")
        ? fs.readFileSync(process.env.OPENCLAW_WORKSPACE_DIR + "/USER.md", "utf8")
        : null
    }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...env,
      START_GATEWAY_SCRIPT: scriptPath,
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `node exited ${result.status}`);
  }
  return JSON.parse(result.stdout);
}

function waitForListening(server) {
  return new Promise((resolve) => {
    if (server.listening) {
      resolve();
      return;
    }
    server.once("listening", resolve);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

describe("Fly gateway startup", () => {
  it("persists the default OpenClaw workspace on the Fly volume", () => {
    const { workspaceDir } = configureTempGatewayEnv();
    const result = runPrepareGatewayConfig({});

    const config = result.config;
    expect(result.workspaceExists).toBe(true);
    expect(config.agents.defaults.workspace).toBe(workspaceDir);
    expect(config.agents.defaults.model).toEqual({ primary: "openai/gpt-5.4-mini" });
    expect(config.agents.defaults.thinkingDefault).toBe("low");
    expect(config.tools.deny).toContain("image_generate");
  }, prepareGatewayConfigTimeoutMs);

  it("migrates missing legacy workspace markdowns without overwriting persistent files", () => {
    const { workspaceDir, homeDir } = configureTempGatewayEnv();
    const legacyWorkspace = path.join(homeDir, ".openclaw", "workspace");
    fs.mkdirSync(legacyWorkspace, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(legacyWorkspace, "AGENTS.md"), "legacy agents\n");
    fs.writeFileSync(path.join(legacyWorkspace, "USER.md"), "legacy user\n");
    fs.writeFileSync(path.join(workspaceDir, "USER.md"), "persistent user\n");

    const result = runPrepareGatewayConfig({});

    expect(result.agents).toBe("legacy agents\n");
    expect(result.user).toBe("persistent user\n");
  }, prepareGatewayConfigTimeoutMs);

  it("repairs the known legacy default workspace path in persisted config", () => {
    const { stateDir, workspaceDir, homeDir } = configureTempGatewayEnv();
    const legacyWorkspace = path.join(homeDir, ".openclaw", "workspace");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "openclaw.json"),
      `${JSON.stringify({ agents: { defaults: { workspace: legacyWorkspace } } })}\n`,
    );

    const result = runPrepareGatewayConfig({});

    expect(result.config.agents.defaults.workspace).toBe(workspaceDir);
  }, prepareGatewayConfigTimeoutMs);

  it("runs OpenClaw on loopback behind the public route guard", async () => {
    const plan = buildGatewayLaunchPlan(["--allow-unconfigured", "--port", "3000", "--bind", "lan"], {
      OPENCLAW_PUBLIC_GATEWAY_GUARD: "1",
      OPENCLAW_INTERNAL_GATEWAY_PORT: "3100",
    });

    expect(plan).toEqual({
      guardEnabled: true,
      publicPort: 3000,
      internalPort: 3100,
      openclawArgs: ["--allow-unconfigured", "--port", "3100", "--bind", "loopback"],
    });
  }, 15000);

  it("only proxies the public webhook and health routes", async () => {
    const seenPaths = [];
    const target = http.createServer((req, res) => {
      seenPaths.push(req.url);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    target.listen(0, "127.0.0.1");
    await waitForListening(target);

    const targetPort = target.address().port;
    const guard = startPublicRouteGuard({ publicPort: 0, targetPort });
    await waitForListening(guard);

    const publicPort = guard.address().port;
    const webhookResponse = await fetch(`http://127.0.0.1:${publicPort}/facebook/webhook?hub.challenge=ok`);
    const blockedResponse = await fetch(`http://127.0.0.1:${publicPort}/`);

    expect(webhookResponse.status).toBe(200);
    expect(await webhookResponse.json()).toEqual({
      ok: true,
      path: "/facebook/webhook?hub.challenge=ok",
    });
    expect(blockedResponse.status).toBe(404);
    expect(await blockedResponse.text()).toBe("Not found");
    expect(seenPaths).toEqual(["/facebook/webhook?hub.challenge=ok"]);

    await closeServer(guard);
    await closeServer(target);
  }, 15000);

  it("returns 504 when the internal gateway proxy request times out", async () => {
    const target = http.createServer((_req, _res) => {});
    target.listen(0, "127.0.0.1");
    await waitForListening(target);

    const targetPort = target.address().port;
    const guard = startPublicRouteGuard({
      publicPort: 0,
      targetPort,
      env: {
        OPENCLAW_PUBLIC_GATEWAY_PROXY_TIMEOUT_MS: "25",
      },
    });
    await waitForListening(guard);

    const publicPort = guard.address().port;
    const response = await fetch(`http://127.0.0.1:${publicPort}/healthz`);

    expect(response.status).toBe(504);
    expect(await response.text()).toBe("Gateway timeout");

    await closeServer(guard);
    await closeServer(target);
  }, 15000);
});
