#!/usr/bin/env node
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import { spawn, spawnSync } from "node:child_process";

const app = process.env.OPENCLAW_FLY_APP || "leaderbot-openclaw-gateway";
const target = new URL(process.env.OPENCLAW_GATEWAY_URL || "https://leaderbot-openclaw-gateway.fly.dev");
const host = target.hostname;
const port = Number(process.env.OPENCLAW_LOGIN_PORT || "18791");
const bind = "127.0.0.1";
const adminSessionLabel = "openclaw-admin-session";
const adminCookieName = "openclaw_admin";

function fail(message, error) {
  console.error(`openclaw-login: ${message}`);
  if (error?.message) console.error(error.message);
  process.exit(1);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) fail(`kon ${command} niet starten`, result.error);
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    fail(`${command} faalde: ${detail}`);
  }
  return result.stdout;
}

function readRemoteAuth() {
  const remoteScript = String.raw`
const fs = require('node:fs');
const adminToken = String(process.env.OPENCLAW_ADMIN_TOKEN || '').trim();
let gatewayToken = '';
try {
  const config = JSON.parse(fs.readFileSync('/data/openclaw.json', 'utf8'));
  gatewayToken = String(config?.gateway?.auth?.token || '').trim();
} catch {}
process.stdout.write(JSON.stringify({ hasAdminToken: Boolean(adminToken), adminToken, gatewayToken }));
`;
  const output = run("fly", ["ssh", "console", "-a", app, "-C", `node -e ${JSON.stringify(remoteScript)}`]);
  let parsed;
  try {
    parsed = JSON.parse(output.trim());
  } catch (error) {
    fail("kon authdetails niet lezen uit Fly-output", error);
  }
  if (!parsed.hasAdminToken || !parsed.adminToken) fail("OPENCLAW_ADMIN_TOKEN ontbreekt op Fly");
  if (!parsed.gatewayToken) fail("gateway.auth.token ontbreekt in /data/openclaw.json");
  const adminCookie = crypto.createHmac("sha256", parsed.adminToken).update(adminSessionLabel).digest("base64url");
  return { adminCookie, gatewayToken: parsed.gatewayToken };
}

function openBrowser(gatewayToken) {
  const url = `http://${bind}:${port}/?gatewayUrl=${encodeURIComponent(`ws://${bind}:${port}`)}&fresh=${Date.now()}#token=${encodeURIComponent(gatewayToken)}`;
  const child = spawn("open", [url], { stdio: "ignore", detached: true });
  child.unref();
}

function stripHopByHop(headers) {
  const next = { ...headers };
  for (const name of [
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    "origin",
    "cookie",
    "authorization",
  ]) {
    delete next[name];
  }
  return next;
}

const auth = readRemoteAuth();

const server = http.createServer((req, res) => {
  const headers = stripHopByHop(req.headers);
  headers.host = host;
  headers.cookie = `${adminCookieName}=${auth.adminCookie}`;
  headers.authorization = `Bearer ${auth.gatewayToken}`;
  headers["x-forwarded-host"] = `${bind}:${port}`;
  headers["x-forwarded-proto"] = "http";

  const upstream = https.request({
    hostname: host,
    port: 443,
    method: req.method,
    path: req.url || "/",
    headers,
  }, (upstreamRes) => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });

  upstream.on("error", (error) => {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
    res.end(`Gateway proxy error: ${error.message}\n`);
  });

  req.pipe(upstream);
});

server.on("upgrade", (req, socket, head) => {
  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const upstream = tls.connect({ host, port: 443, servername: host }, () => {
    const path = req.url || "/";
    const protocol = req.headers["sec-websocket-protocol"];
    const lines = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}`,
      "Connection: Upgrade",
      "Upgrade: websocket",
      `Sec-WebSocket-Key: ${key}`,
      `Sec-WebSocket-Version: ${req.headers["sec-websocket-version"] || "13"}`,
      `Cookie: ${adminCookieName}=${auth.adminCookie}`,
      `Authorization: Bearer ${auth.gatewayToken}`,
      `Origin: http://${bind}:${port}`,
    ];
    if (protocol) lines.push(`Sec-WebSocket-Protocol: ${protocol}`);
    lines.push("", "");
    upstream.write(lines.join("\r\n"));
    if (head?.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });

  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`openclaw-login: poort ${port} is al in gebruik. Sluit de oude proxy of kies OPENCLAW_LOGIN_PORT.`);
    process.exit(1);
  }
  fail("proxy kon niet starten", error);
});

server.listen(port, bind, () => {
  console.log(`OpenClaw login-proxy draait lokaal op http://${bind}:${port}`);
  console.log("Sluiten: druk Ctrl+C in dit terminalvenster.");
  openBrowser(auth.gatewayToken);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
