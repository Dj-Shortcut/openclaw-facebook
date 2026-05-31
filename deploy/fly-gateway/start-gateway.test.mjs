import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildGatewayLaunchPlan,
  isLocalAdminHost,
  startPublicRouteGuard,
} from "./bin/public-route-guard.mjs";

const scriptPath = path.resolve("deploy/fly-gateway/bin/start-gateway.mjs");
const originalEnv = { ...process.env };

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

function requestRawUpgrade({ port, path = "/socket", cookie }) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    let response = "";
    socket.setEncoding("utf8");
    socket.setTimeout(1000, () => {
      socket.destroy();
      resolve(response);
    });
    socket.on("connect", () => {
      const websocketKey = crypto.randomBytes(16).toString("base64");
      socket.write(
        [
          `GET ${path} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Key: ${websocketKey}`,
          cookie ? `Cookie: ${cookie}` : null,
          "",
          "",
        ]
          .filter((line) => line !== null)
          .join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => resolve(response));
    socket.on("close", () => resolve(response));
    socket.on("error", reject);
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
  }, 15000);

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
  }, 15000);

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
  }, 15000);

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

  it("keeps admin login disabled until an admin token is configured", async () => {
    const target = http.createServer((_req, res) => {
      res.end("target");
    });
    target.listen(0, "127.0.0.1");
    await waitForListening(target);

    const guard = startPublicRouteGuard({
      publicPort: 0,
      targetPort: target.address().port,
      env: {},
    });
    await waitForListening(guard);

    const publicPort = guard.address().port;
    const loginResponse = await fetch(`http://127.0.0.1:${publicPort}/admin/login`);
    const dashboardResponse = await fetch(`http://127.0.0.1:${publicPort}/`);

    expect(loginResponse.status).toBe(404);
    expect(dashboardResponse.status).toBe(404);

    await closeServer(guard);
    await closeServer(target);
  }, 15000);

  it("proxies dashboard requests only after local admin token login", async () => {
    const seenPaths = [];
    const target = http.createServer((req, res) => {
      seenPaths.push(req.url);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
    target.listen(0, "127.0.0.1");
    await waitForListening(target);

    const guard = startPublicRouteGuard({
      publicPort: 0,
      targetPort: target.address().port,
      env: {
        OPENCLAW_ADMIN_TOKEN: "secret-token",
      },
    });
    await waitForListening(guard);

    const publicPort = guard.address().port;
    const loginPage = await fetch(`http://127.0.0.1:${publicPort}/admin/login`);
    const failedLogin = await fetch(`http://127.0.0.1:${publicPort}/admin/login`, {
      method: "POST",
      body: new URLSearchParams({ token: "wrong-token" }),
    });
    const successfulLogin = await fetch(`http://127.0.0.1:${publicPort}/admin/login`, {
      method: "POST",
      body: new URLSearchParams({ token: "secret-token" }),
      redirect: "manual",
    });
    const cookie = successfulLogin.headers.get("set-cookie") || "";
    const dashboardResponse = await fetch(`http://127.0.0.1:${publicPort}/dashboard?tab=plugins`, {
      headers: {
        cookie,
      },
    });

    expect(loginPage.status).toBe(200);
    expect(await loginPage.text()).toContain("OpenClaw Admin");
    expect(failedLogin.status).toBe(401);
    expect(successfulLogin.status).toBe(303);
    expect(successfulLogin.headers.get("location")).toBe("/");
    expect(cookie).toContain("openclaw_admin=");
    expect(dashboardResponse.status).toBe(200);
    expect(await dashboardResponse.json()).toEqual({
      ok: true,
      path: "/dashboard?tab=plugins",
    });
    expect(seenPaths).toEqual(["/dashboard?tab=plugins"]);

    await closeServer(guard);
    await closeServer(target);
  }, 15000);


  it("proxies authenticated admin WebSocket upgrades through the tunnel", async () => {
    const seenUpgrades = [];
    const target = http.createServer((_req, res) => {
      res.statusCode = 404;
      res.end("not found");
    });
    target.on("upgrade", (req, socket) => {
      seenUpgrades.push({
        url: req.url,
        host: req.headers.host,
        forwardedHost: req.headers["x-forwarded-host"],
        forwardedProto: req.headers["x-forwarded-proto"],
      });
      socket.end(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Connection: Upgrade",
          "Upgrade: websocket",
          "",
          "upgraded",
        ].join("\r\n"),
      );
    });
    target.listen(0, "127.0.0.1");
    await waitForListening(target);

    const guard = startPublicRouteGuard({
      publicPort: 0,
      targetPort: target.address().port,
      env: {
        OPENCLAW_ADMIN_TOKEN: "secret-token",
      },
    });
    await waitForListening(guard);

    const publicPort = guard.address().port;
    const blockedUpgrade = await requestRawUpgrade({ port: publicPort, path: "/ws" });
    const successfulLogin = await fetch(`http://127.0.0.1:${publicPort}/admin/login`, {
      method: "POST",
      body: new URLSearchParams({ token: "secret-token" }),
      redirect: "manual",
    });
    const cookie = successfulLogin.headers.get("set-cookie") || "";
    const proxiedUpgrade = await requestRawUpgrade({ port: publicPort, path: "/ws", cookie });

    expect(blockedUpgrade).toBe("");
    expect(proxiedUpgrade).toContain("HTTP/1.1 101 Switching Protocols");
    expect(proxiedUpgrade).toContain("upgraded");
    expect(seenUpgrades).toEqual([
      {
        url: "/ws",
        host: `127.0.0.1:${target.address().port}`,
        forwardedHost: `127.0.0.1:${publicPort}`,
        forwardedProto: "https",
      },
    ]);

    await closeServer(guard);
    await closeServer(target);
  }, 15000);

  it("rejects admin access when the request host is not local to the tunnel", () => {
    expect(isLocalAdminHost("127.0.0.1:7300")).toBe(true);
    expect(isLocalAdminHost("localhost:7300")).toBe(true);
    expect(isLocalAdminHost("[::1]:7300")).toBe(true);
    expect(isLocalAdminHost("leaderbot-openclaw-gateway.fly.dev")).toBe(false);
  });

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
