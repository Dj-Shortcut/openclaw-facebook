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
  isAdminHostAllowed,
  isLocalAdminHost,
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
        : null,
      memory: fs.existsSync(process.env.OPENCLAW_WORKSPACE_DIR + "/MEMORY.md")
        ? fs.readFileSync(process.env.OPENCLAW_WORKSPACE_DIR + "/MEMORY.md", "utf8")
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

function requestWithHost({ port, path = "/", method = "GET", host, body, cookie }) {
  const bodyText = body ? String(body) : "";
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          host,
          ...(cookie ? { cookie } : {}),
          ...(bodyText
            ? {
                "content-type": "application/x-www-form-urlencoded",
                "content-length": Buffer.byteLength(bodyText),
              }
            : {}),
        },
      },
      (res) => {
        let responseBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          responseBody += chunk;
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: responseBody,
          });
        });
      },
    );
    req.on("error", reject);
    if (bodyText) {
      req.write(bodyText);
    }
    req.end();
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
    expect(result.memory).toBe("# Memory\n\nPersistent assistant memory for this OpenClaw workspace.\n");
  }, prepareGatewayConfigTimeoutMs);

  it("seeds Leaderbot free-tier unknown sender mode when configured", () => {
    configureTempGatewayEnv();
    const result = runPrepareGatewayConfig({
      OPENCLAW_FACEBOOK_UNKNOWN_SENDER_MODE: "leaderbot_free_tier",
      OPENCLAW_FACEBOOK_LEADERBOT_BRIDGE_ENABLED: "1",
    });

    expect(result.config.channels.facebook.dmPolicy).toBe("pairing");
    expect(result.config.channels.facebook.unknownSenderMode).toBe("leaderbot_free_tier");
    expect(result.config.channels.facebook.leaderbotBridgeEnabled).toBe(true);
  }, prepareGatewayConfigTimeoutMs);

  it("keeps explicit pairing-only unknown sender mode and bridge setting", () => {
    const { stateDir } = configureTempGatewayEnv();
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "openclaw.json"),
      `${JSON.stringify({
        channels: {
          facebook: {
            dmPolicy: "pairing",
            unknownSenderMode: "pairing",
            leaderbotBridgeEnabled: false,
          },
        },
      })}\n`,
    );

    const result = runPrepareGatewayConfig({
      OPENCLAW_FACEBOOK_UNKNOWN_SENDER_MODE: "leaderbot_free_tier",
    });

    expect(result.config.channels.facebook.dmPolicy).toBe("pairing");
    expect(result.config.channels.facebook.unknownSenderMode).toBe("pairing");
    expect(result.config.channels.facebook.leaderbotBridgeEnabled).toBe(false);
  }, prepareGatewayConfigTimeoutMs);

  it("keeps an existing persistent memory file", () => {
    const { workspaceDir } = configureTempGatewayEnv();
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, "MEMORY.md"), "existing memory\n");

    const result = runPrepareGatewayConfig({});

    expect(result.memory).toBe("existing memory\n");
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

  it("only proxies the public webhook and health routes by default", async () => {
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

  it("proxies customer portal routes to the configured portal origin without exposing gateway UI", async () => {
    const seenGatewayPaths = [];
    const gatewayTarget = http.createServer((req, res) => {
      seenGatewayPaths.push(req.url);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ target: "gateway", path: req.url }));
    });
    gatewayTarget.listen(0, "127.0.0.1");
    await waitForListening(gatewayTarget);

    const seenPortalPaths = [];
    const portalTarget = http.createServer((req, res) => {
      seenPortalPaths.push(req.url);
      res.setHeader("content-type", "text/plain");
      res.end(`portal:${req.url}`);
    });
    portalTarget.listen(0, "127.0.0.1");
    await waitForListening(portalTarget);

    const guard = startPublicRouteGuard({
      publicPort: 0,
      targetPort: gatewayTarget.address().port,
      env: {
        LEADERBOT_PORTAL_ORIGIN: `http://127.0.0.1:${portalTarget.address().port}`,
      },
    });
    await waitForListening(guard);

    const publicPort = guard.address().port;
    const portalRoot = await fetch(`http://127.0.0.1:${publicPort}/`);
    const portalAsset = await fetch(`http://127.0.0.1:${publicPort}/assets/app.js`);
    const portalApi = await fetch(`http://127.0.0.1:${publicPort}/api/trpc/portal.auth.session`);
    const webhookResponse = await fetch(`http://127.0.0.1:${publicPort}/facebook/webhook?hub.challenge=ok`);
    const blockedDashboard = await fetch(`http://127.0.0.1:${publicPort}/dashboard`);
    const blockedDebug = await fetch(`http://127.0.0.1:${publicPort}/debug/build`);

    expect(portalRoot.status).toBe(200);
    expect(await portalRoot.text()).toBe("portal:/");
    expect(portalAsset.status).toBe(200);
    expect(await portalAsset.text()).toBe("portal:/assets/app.js");
    expect(portalApi.status).toBe(200);
    expect(await portalApi.text()).toBe("portal:/api/trpc/portal.auth.session");
    expect(webhookResponse.status).toBe(200);
    expect(await webhookResponse.json()).toEqual({
      target: "gateway",
      path: "/facebook/webhook?hub.challenge=ok",
    });
    expect(blockedDashboard.status).toBe(404);
    expect(blockedDebug.status).toBe(404);
    expect(seenGatewayPaths).toEqual(["/facebook/webhook?hub.challenge=ok"]);
    expect(seenPortalPaths).toEqual([
      "/",
      "/assets/app.js",
      "/api/trpc/portal.auth.session",
    ]);

    await closeServer(guard);
    await closeServer(portalTarget);
    await closeServer(gatewayTarget);
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

  it("allows admin-token login from an explicitly configured Fly host", async () => {
    const target = http.createServer((req, res) => {
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
        OPENCLAW_ADMIN_HOSTS: "leaderbot-openclaw-gateway.fly.dev",
      },
    });
    await waitForListening(guard);

    const publicPort = guard.address().port;
    const blockedLogin = await requestWithHost({
      port: publicPort,
      path: "/admin/login",
      host: "other.fly.dev",
    });
    const successfulLogin = await requestWithHost({
      port: publicPort,
      path: "/admin/login",
      method: "POST",
      body: new URLSearchParams({ token: "secret-token" }),
      host: "leaderbot-openclaw-gateway.fly.dev",
    });
    const cookie = successfulLogin.headers["set-cookie"]?.[0] || "";
    const dashboardResponse = await requestWithHost({
      port: publicPort,
      path: "/dashboard",
      cookie,
      host: "leaderbot-openclaw-gateway.fly.dev",
    });

    expect(blockedLogin.status).toBe(404);
    expect(successfulLogin.status).toBe(303);
    expect(dashboardResponse.status).toBe(200);
    expect(JSON.parse(dashboardResponse.body)).toEqual({ ok: true, path: "/dashboard" });

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

  it("rejects admin access when the request host is not local or explicitly allowlisted", () => {
    expect(isLocalAdminHost("127.0.0.1:7300")).toBe(true);
    expect(isLocalAdminHost("localhost:7300")).toBe(true);
    expect(isLocalAdminHost("[::1]:7300")).toBe(true);
    expect(isLocalAdminHost("leaderbot-openclaw-gateway.fly.dev")).toBe(false);
    expect(isAdminHostAllowed("leaderbot-openclaw-gateway.fly.dev")).toBe(false);
    expect(
      isAdminHostAllowed("leaderbot-openclaw-gateway.fly.dev", {
        OPENCLAW_ADMIN_HOSTS: "leaderbot-openclaw-gateway.fly.dev",
      }),
    ).toBe(true);
    expect(
      isAdminHostAllowed("leaderbot-openclaw-gateway.fly.dev.", {
        OPENCLAW_ADMIN_HOSTS: "leaderbot-openclaw-gateway.fly.dev",
      }),
    ).toBe(true);
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
