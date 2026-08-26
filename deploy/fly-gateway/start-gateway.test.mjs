import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
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
        : null,
      quarantinedUser: fs.existsSync(process.env.OPENCLAW_STATE_DIR + "/private-memory-quarantine-v1/USER.md")
        ? fs.readFileSync(process.env.OPENCLAW_STATE_DIR + "/private-memory-quarantine-v1/USER.md", "utf8")
        : null,
      quarantinedMemory: fs.existsSync(process.env.OPENCLAW_STATE_DIR + "/private-memory-quarantine-v1/MEMORY.md")
        ? fs.readFileSync(process.env.OPENCLAW_STATE_DIR + "/private-memory-quarantine-v1/MEMORY.md", "utf8")
        : null
    }));
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
        START_GATEWAY_SCRIPT: scriptPath,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      result.stderr || result.stdout || `node exited ${result.status}`,
    );
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

function requestWithHost({
  port,
  path = "/",
  method = "GET",
  host,
  body,
  cookie,
}) {
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
  it(
    "persists the default OpenClaw workspace on the Fly volume",
    () => {
      const { workspaceDir } = configureTempGatewayEnv();
      const result = runPrepareGatewayConfig({});

      const config = result.config;
      expect(result.workspaceExists).toBe(true);
      expect(config.agents.defaults.workspace).toBe(workspaceDir);
      expect(config.agents.defaults.model).toEqual({
        primary: "openai/gpt-5.4-mini",
      });
      expect(config.agents.defaults.thinkingDefault).toBe("low");
      expect(config.session.dmScope).toBe("per-account-channel-peer");
      expect(config.attachments.ttlHours).toBe(24);
      expect(config.tools.deny).toContain("image_generate");
      expect(result.memory).toBeNull();
    },
    prepareGatewayConfigTimeoutMs,
  );

  it(
    "bounds persisted attachment cleanup without discarding safe attachment settings",
    () => {
      const { stateDir } = configureTempGatewayEnv();
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "openclaw.json"),
        `${JSON.stringify({
          attachments: { ttlHours: 168, preserveFilenames: false },
        })}\n`,
        "utf8",
      );

      const { config } = runPrepareGatewayConfig({});
      expect(config.attachments).toEqual({
        ttlHours: 24,
        preserveFilenames: false,
      });
    },
    prepareGatewayConfigTimeoutMs,
  );

  it(
    "forces public Messenger DMs into account, channel, and sender scoped sessions",
    () => {
      const { stateDir } = configureTempGatewayEnv();
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "openclaw.json"),
        `${JSON.stringify({
          session: {
            dmScope: "main",
            reset: { mode: "daily", atHour: 4 },
          },
          bindings: [
            {
              agentId: "main",
              match: { channel: "facebook", accountId: "*" },
              session: { dmScope: "main" },
            },
          ],
        })}\n`,
        "utf8",
      );

      const { config } = runPrepareGatewayConfig({});
      expect(config.session).toEqual({
        dmScope: "per-account-channel-peer",
        reset: { mode: "daily", atHour: 4 },
      });
      expect(config.bindings[0].session.dmScope).toBe(
        "per-account-channel-peer",
      );

      const sessionKeys = [
        ["page-account-a", "sender-1"],
        ["page-account-a", "sender-2"],
        ["page-account-b", "sender-1"],
      ].map(
        ([accountId, senderId]) =>
          resolveAgentRoute({
            cfg: config,
            channel: "facebook",
            accountId,
            peer: { kind: "direct", id: senderId },
          }).sessionKey,
      );

      expect(new Set(sessionKeys)).toHaveLength(3);
    },
    prepareGatewayConfigTimeoutMs,
  );

  it(
    "fails startup when a persisted Facebook binding routes to a shared secondary agent",
    () => {
      const { stateDir } = configureTempGatewayEnv();
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "openclaw.json"),
        `${JSON.stringify({
          bindings: [
            {
              agentId: "support",
              match: { channel: "facebook", accountId: "*" },
            },
          ],
        })}\n`,
        "utf8",
      );

      expect(() => runPrepareGatewayConfig({})).toThrow(
        "Public Facebook routes must use the isolated main agent",
      );
    },
    prepareGatewayConfigTimeoutMs,
  );

  it(
    "seeds Leaderbot free-tier unknown sender mode when configured",
    () => {
      configureTempGatewayEnv();
      const result = runPrepareGatewayConfig({
        OPENCLAW_FACEBOOK_UNKNOWN_SENDER_MODE: "leaderbot_free_tier",
        OPENCLAW_FACEBOOK_LEADERBOT_BRIDGE_ENABLED: "1",
      });

      expect(result.config.channels.facebook.dmPolicy).toBe("pairing");
      expect(result.config.channels.facebook.unknownSenderMode).toBe(
        "leaderbot_free_tier",
      );
      expect(result.config.channels.facebook.leaderbotBridgeEnabled).toBe(true);
    },
    prepareGatewayConfigTimeoutMs,
  );

  it(
    "disables public memory even when an OpenAI key is available",
    () => {
      configureTempGatewayEnv();
      const result = runPrepareGatewayConfig({
        OPENAI_API_KEY: "present-but-redacted",
      });
      expect(result.config.memory).toBeUndefined();
      expect(result.config.plugins.slots.memory).toBe("none");
      expect(result.config.plugins.entries["memory-core"].enabled).toBe(false);
      expect(result.config.hooks.internal.entries["session-memory"]).toEqual({
        enabled: false,
      });
      expect(result.config.agents.defaults.compaction.memoryFlush).toEqual({
        enabled: false,
      });
      expect(result.config.agents.defaults.memory).toBeUndefined();
      expect(result.config.tools.deny).toEqual(
        expect.arrayContaining([
          "memory_search",
          "memory_get",
          "memory_recall",
          "group:memory",
        ]),
      );
    },
    prepareGatewayConfigTimeoutMs,
  );

  it(
    "removes persisted per-agent memory settings from the public gateway",
    () => {
      const { stateDir } = configureTempGatewayEnv();
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "openclaw.json"),
        `${JSON.stringify(
          {
            agents: {
              defaults: {
                memory: {
                  rememberAcrossConversations: false,
                  search: { provider: "local", local: { model: "existing" } },
                },
              },
              entries: {
                support: {
                  memory: {
                    rememberAcrossConversations: true,
                    search: {
                      provider: "openai",
                      remote: { model: "existing" },
                    },
                  },
                  compaction: { memoryFlush: { enabled: true } },
                },
              },
              list: [
                {
                  id: "main",
                  memory: { search: { provider: "openai" } },
                  compaction: { memoryFlush: { enabled: true } },
                },
              ],
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const result = runPrepareGatewayConfig({
        OPENAI_API_KEY: "present-but-redacted",
      });
      expect(result.config.agents.defaults.memory).toBeUndefined();
      expect(result.config.agents.entries.support.memory).toBeUndefined();
      expect(
        result.config.agents.entries.support.compaction.memoryFlush,
      ).toEqual({
        enabled: false,
      });
      expect(result.config.agents.list[0].memory).toBeUndefined();
      expect(result.config.agents.list[0].compaction.memoryFlush).toEqual({
        enabled: false,
      });
    },
    prepareGatewayConfigTimeoutMs,
  );

  it(
    "trusts Facebook explicitly without trusting the optional Codex plugin",
    () => {
      configureTempGatewayEnv();
      const result = runPrepareGatewayConfig({});

      expect(result.config.plugins.allow).toContain("facebook");
      expect(result.config.plugins.allow).not.toContain("codex");
      expect(result.config.plugins.entries.codex.enabled).toBe(false);
    },
    prepareGatewayConfigTimeoutMs,
  );

  it(
    "keeps the co-located Messenger gateway in local mode",
    () => {
      const { stateDir } = configureTempGatewayEnv();
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "openclaw.json"),
        `${JSON.stringify({
          gateway: {
            mode: "remote",
            remote: { url: "wss://example.invalid" },
            controlUi: { enabled: true },
          },
        })}\n`,
      );

      const result = runPrepareGatewayConfig({});

      expect(result.config.gateway.mode).toBe("local");
      expect(result.config.gateway.remote).toBeUndefined();
      expect(result.config.gateway.controlUi).toEqual({ enabled: true });
    },
    prepareGatewayConfigTimeoutMs,
  );

  it(
    "keeps explicit safer persisted Facebook settings when env requests public mode",
    () => {
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
        OPENCLAW_FACEBOOK_LEADERBOT_BRIDGE_ENABLED: "1",
      });

      expect(result.config.channels.facebook.dmPolicy).toBe("pairing");
      expect(result.config.channels.facebook.unknownSenderMode).toBe("pairing");
      expect(result.config.channels.facebook.leaderbotBridgeEnabled).toBe(
        false,
      );
    },
    prepareGatewayConfigTimeoutMs,
  );

  it(
    "makes reviewed personal-only env settings authoritative over persisted public mode",
    () => {
      const { stateDir } = configureTempGatewayEnv();
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "openclaw.json"),
        `${JSON.stringify({
          channels: {
            facebook: {
              dmPolicy: "pairing",
              unknownSenderMode: "leaderbot_free_tier",
              leaderbotBridgeEnabled: true,
            },
          },
        })}\n`,
      );

      const result = runPrepareGatewayConfig({
        OPENCLAW_FACEBOOK_UNKNOWN_SENDER_MODE: "pairing",
        OPENCLAW_FACEBOOK_LEADERBOT_BRIDGE_ENABLED: "0",
      });

      expect(result.config.channels.facebook.dmPolicy).toBe("pairing");
      expect(result.config.channels.facebook.unknownSenderMode).toBe("pairing");
      expect(result.config.channels.facebook.leaderbotBridgeEnabled).toBe(
        false,
      );
    },
    prepareGatewayConfigTimeoutMs,
  );

  it(
    "makes reviewed personal-only env settings authoritative for persisted account overrides",
    () => {
      const { stateDir } = configureTempGatewayEnv();
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "openclaw.json"),
        `${JSON.stringify({
          channels: {
            facebook: {
              dmPolicy: "pairing",
              accounts: {
                customer: {
                  pageId: "synthetic-page-id",
                  tokenFile: "/data/secrets/facebook-customer-token",
                  dmPolicy: "open",
                  allowFrom: ["*"],
                  unknownSenderMode: "leaderbot_free_tier",
                  leaderbotBridgeEnabled: true,
                },
              },
            },
          },
        })}\n`,
      );

      const result = runPrepareGatewayConfig({
        OPENCLAW_FACEBOOK_UNKNOWN_SENDER_MODE: "pairing",
        OPENCLAW_FACEBOOK_LEADERBOT_BRIDGE_ENABLED: "0",
      });

      expect(result.config.channels.facebook.accounts.customer).toEqual({
        pageId: "synthetic-page-id",
        tokenFile: "/data/secrets/facebook-customer-token",
        dmPolicy: "pairing",
        allowFrom: ["*"],
        unknownSenderMode: "pairing",
        leaderbotBridgeEnabled: false,
      });
    },
    prepareGatewayConfigTimeoutMs,
  );

  it(
    "quarantines existing shared public memory before startup",
    () => {
      const { stateDir, workspaceDir } = configureTempGatewayEnv();
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.writeFileSync(
        path.join(workspaceDir, "MEMORY.md"),
        "existing memory\n",
      );

      const result = runPrepareGatewayConfig({});

      expect(result.memory).toBeNull();
      expect(result.quarantinedMemory).toBe("existing memory\n");
      expect(
        fs.statSync(path.join(stateDir, "private-memory-quarantine-v1")).mode &
          0o777,
      ).toBe(0o700);
    },
    prepareGatewayConfigTimeoutMs,
  );

  it(
    "quarantines both the env workspace and a persisted custom main workspace",
    () => {
      const { stateDir, workspaceDir } = configureTempGatewayEnv();
      const mainWorkspace = path.join(stateDir, "workspace-main-custom");
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.mkdirSync(path.join(mainWorkspace, "memory"), { recursive: true });
      fs.writeFileSync(path.join(workspaceDir, "USER.md"), "env user\n");
      fs.writeFileSync(
        path.join(mainWorkspace, "MEMORY.md"),
        "custom main memory\n",
      );
      fs.writeFileSync(
        path.join(mainWorkspace, "memory", "2026-08-24.md"),
        "custom daily memory\n",
      );
      fs.writeFileSync(
        path.join(stateDir, "openclaw.json"),
        `${JSON.stringify({
          agents: {
            defaults: { workspace: mainWorkspace },
            entries: { main: { default: true } },
          },
        })}\n`,
      );

      const result = runPrepareGatewayConfig({});
      const quarantineDir = path.join(stateDir, "private-memory-quarantine-v1");
      const mainQuarantineDir = path.join(
        quarantineDir,
        "main-agent-workspace",
      );

      expect(result.config.agents.defaults.workspace).toBe(mainWorkspace);
      expect(fs.existsSync(path.join(workspaceDir, "USER.md"))).toBe(false);
      expect(fs.readFileSync(path.join(quarantineDir, "USER.md"), "utf8")).toBe(
        "env user\n",
      );
      expect(fs.existsSync(path.join(mainWorkspace, "MEMORY.md"))).toBe(false);
      expect(fs.existsSync(path.join(mainWorkspace, "memory"))).toBe(false);
      expect(
        fs.readFileSync(path.join(mainQuarantineDir, "MEMORY.md"), "utf8"),
      ).toBe("custom main memory\n");
      expect(
        fs.readFileSync(
          path.join(mainQuarantineDir, "memory", "2026-08-24.md"),
          "utf8",
        ),
      ).toBe("custom daily memory\n");
      expect(fs.statSync(mainQuarantineDir).mode & 0o777).toBe(0o700);
    },
    prepareGatewayConfigTimeoutMs,
  );

  it(
    "quarantines only the effective main override without traversing other agent workspaces",
    () => {
      const { stateDir } = configureTempGatewayEnv();
      const defaultsWorkspace = path.join(stateDir, "workspace-defaults");
      const mainWorkspace = path.join(stateDir, "workspace-main-override");
      const supportWorkspace = path.join(stateDir, "workspace-support");
      for (const candidate of [
        defaultsWorkspace,
        mainWorkspace,
        supportWorkspace,
      ]) {
        fs.mkdirSync(candidate, { recursive: true });
        fs.writeFileSync(path.join(candidate, "MEMORY.md"), `${candidate}\n`);
      }
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "openclaw.json"),
        `${JSON.stringify({
          agents: {
            defaults: { workspace: defaultsWorkspace },
            entries: {
              main: { default: true, workspace: mainWorkspace },
              support: { workspace: supportWorkspace },
            },
          },
        })}\n`,
      );

      runPrepareGatewayConfig({});

      expect(fs.existsSync(path.join(mainWorkspace, "MEMORY.md"))).toBe(false);
      expect(
        fs.readFileSync(path.join(defaultsWorkspace, "MEMORY.md"), "utf8"),
      ).toBe(`${defaultsWorkspace}\n`);
      expect(
        fs.readFileSync(path.join(supportWorkspace, "MEMORY.md"), "utf8"),
      ).toBe(`${supportWorkspace}\n`);
    },
    prepareGatewayConfigTimeoutMs,
  );

  it(
    "resolves the isolated main subdirectory when another agent owns the defaults workspace",
    () => {
      const { stateDir } = configureTempGatewayEnv();
      const defaultsWorkspace = path.join(stateDir, "workspace-default-agent");
      const mainWorkspace = path.join(defaultsWorkspace, "main");
      fs.mkdirSync(mainWorkspace, { recursive: true });
      fs.writeFileSync(
        path.join(defaultsWorkspace, "MEMORY.md"),
        "support memory\n",
      );
      fs.writeFileSync(path.join(mainWorkspace, "MEMORY.md"), "main memory\n");
      fs.writeFileSync(
        path.join(stateDir, "openclaw.json"),
        `${JSON.stringify({
          agents: {
            defaults: { workspace: defaultsWorkspace },
            entries: {
              support: { default: true },
              main: {},
            },
          },
          bindings: [
            {
              agentId: "main",
              match: { channel: "facebook", accountId: "*" },
            },
          ],
        })}\n`,
      );

      runPrepareGatewayConfig({});

      expect(fs.existsSync(path.join(mainWorkspace, "MEMORY.md"))).toBe(false);
      expect(
        fs.readFileSync(path.join(defaultsWorkspace, "MEMORY.md"), "utf8"),
      ).toBe("support memory\n");
      expect(
        fs.readFileSync(
          path.join(
            stateDir,
            "private-memory-quarantine-v1",
            "main-agent-workspace",
            "MEMORY.md",
          ),
          "utf8",
        ),
      ).toBe("main memory\n");
    },
    prepareGatewayConfigTimeoutMs,
  );

  it(
    "fails closed when rollback recreates memory in the custom main workspace",
    () => {
      const { stateDir } = configureTempGatewayEnv();
      const mainWorkspace = path.join(stateDir, "workspace-main-custom");
      const configPath = path.join(stateDir, "openclaw.json");
      fs.mkdirSync(mainWorkspace, { recursive: true });
      fs.writeFileSync(path.join(mainWorkspace, "MEMORY.md"), "original\n");
      fs.writeFileSync(
        configPath,
        `${JSON.stringify({
          agents: {
            defaults: { workspace: mainWorkspace },
            entries: { main: { default: true } },
          },
        })}\n`,
      );

      runPrepareGatewayConfig({});
      const quarantinedMemory = path.join(
        stateDir,
        "private-memory-quarantine-v1",
        "main-agent-workspace",
        "MEMORY.md",
      );
      fs.writeFileSync(path.join(mainWorkspace, "MEMORY.md"), "rollback\n");

      expect(() => runPrepareGatewayConfig({})).toThrow(
        "Public main-agent workspace memory reappeared after quarantine: MEMORY.md",
      );
      expect(fs.readFileSync(quarantinedMemory, "utf8")).toBe("original\n");
      expect(
        fs.readFileSync(path.join(mainWorkspace, "MEMORY.md"), "utf8"),
      ).toBe("rollback\n");
    },
    prepareGatewayConfigTimeoutMs,
  );

  it(
    "migrates only static legacy instructions and quarantines user memory",
    () => {
      const { workspaceDir, homeDir } = configureTempGatewayEnv();
      const legacyWorkspace = path.join(homeDir, ".openclaw", "workspace");
      fs.mkdirSync(legacyWorkspace, { recursive: true });
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.writeFileSync(
        path.join(legacyWorkspace, "AGENTS.md"),
        "legacy agents\n",
      );
      fs.writeFileSync(path.join(legacyWorkspace, "USER.md"), "legacy user\n");
      fs.writeFileSync(
        path.join(legacyWorkspace, "MEMORY.md"),
        "legacy memory\n",
      );
      fs.writeFileSync(path.join(workspaceDir, "USER.md"), "persistent user\n");

      const result = runPrepareGatewayConfig({});

      expect(result.agents).toBe("legacy agents\n");
      expect(result.user).toBeNull();
      expect(result.quarantinedUser).toBe("persistent user\n");
      expect(result.memory).toBeNull();
      expect(result.quarantinedMemory).toBeNull();
      expect(
        fs.readFileSync(path.join(legacyWorkspace, "MEMORY.md"), "utf8"),
      ).toBe("legacy memory\n");
    },
    prepareGatewayConfigTimeoutMs,
  );

  it(
    "quarantines the legacy daily-memory directory as one recoverable tree",
    () => {
      const { stateDir, workspaceDir } = configureTempGatewayEnv();
      const memoryDir = path.join(workspaceDir, "memory");
      fs.mkdirSync(memoryDir, { recursive: true });
      fs.writeFileSync(path.join(memoryDir, "2026-08-23.md"), "private note\n");

      runPrepareGatewayConfig({});

      expect(fs.existsSync(memoryDir)).toBe(false);
      expect(
        fs.readFileSync(
          path.join(
            stateDir,
            "private-memory-quarantine-v1",
            "memory",
            "2026-08-23.md",
          ),
          "utf8",
        ),
      ).toBe("private note\n");
    },
    prepareGatewayConfigTimeoutMs,
  );

  it(
    "fails closed instead of overwriting a prior memory quarantine",
    () => {
      const { stateDir, workspaceDir } = configureTempGatewayEnv();
      const quarantineDir = path.join(stateDir, "private-memory-quarantine-v1");
      fs.mkdirSync(workspaceDir, { recursive: true });
      fs.mkdirSync(quarantineDir, { recursive: true });
      fs.writeFileSync(path.join(workspaceDir, "USER.md"), "reappeared user\n");
      fs.writeFileSync(path.join(quarantineDir, "USER.md"), "prior user\n");

      expect(() => runPrepareGatewayConfig({})).toThrow(
        "Public workspace memory reappeared after quarantine: USER.md",
      );
      expect(fs.readFileSync(path.join(workspaceDir, "USER.md"), "utf8")).toBe(
        "reappeared user\n",
      );
      expect(fs.readFileSync(path.join(quarantineDir, "USER.md"), "utf8")).toBe(
        "prior user\n",
      );
    },
    prepareGatewayConfigTimeoutMs,
  );

  it(
    "repairs the known legacy default workspace path in persisted config",
    () => {
      const { stateDir, workspaceDir, homeDir } = configureTempGatewayEnv();
      const legacyWorkspace = path.join(homeDir, ".openclaw", "workspace");
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(
        path.join(stateDir, "openclaw.json"),
        `${JSON.stringify({ agents: { defaults: { workspace: legacyWorkspace } } })}\n`,
      );

      const result = runPrepareGatewayConfig({});

      expect(result.config.agents.defaults.workspace).toBe(workspaceDir);
    },
    prepareGatewayConfigTimeoutMs,
  );

  it("runs OpenClaw on loopback behind the public route guard", async () => {
    const plan = buildGatewayLaunchPlan(
      ["--allow-unconfigured", "--port", "3000", "--bind", "lan"],
      {
        OPENCLAW_PUBLIC_GATEWAY_GUARD: "1",
        OPENCLAW_INTERNAL_GATEWAY_PORT: "3100",
      },
    );

    expect(plan).toEqual({
      guardEnabled: true,
      publicPort: 3000,
      internalPort: 3100,
      openclawArgs: [
        "--allow-unconfigured",
        "--port",
        "3100",
        "--bind",
        "loopback",
      ],
    });
  }, 15000);

  it("refuses to start the personal gateway without the public guard", () => {
    expect(() =>
      buildGatewayLaunchPlan(
        ["--allow-unconfigured", "--port", "3000", "--bind", "lan"],
        { OPENCLAW_PUBLIC_GATEWAY_GUARD: "0" },
      ),
    ).toThrow("requires its public route guard");
  });

  it("only proxies the public health route by default", async () => {
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
    const healthResponse = await fetch(
      `http://127.0.0.1:${publicPort}/healthz?status=ok`,
    );
    const webhookResponse = await fetch(
      `http://127.0.0.1:${publicPort}/facebook/webhook?hub.challenge=ok`,
    );
    const legacyWebhookResponse = await fetch(
      `http://127.0.0.1:${publicPort}/messenger/webhook?hub.challenge=ok`,
    );
    const blockedResponse = await fetch(`http://127.0.0.1:${publicPort}/`);

    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.json()).toEqual({
      ok: true,
      path: "/healthz?status=ok",
    });
    expect(webhookResponse.status).toBe(404);
    expect(await webhookResponse.text()).toBe("Not found");
    expect(legacyWebhookResponse.status).toBe(404);
    expect(await legacyWebhookResponse.text()).toBe("Not found");
    expect(blockedResponse.status).toBe(404);
    expect(await blockedResponse.text()).toBe("Not found");
    expect(seenPaths).toEqual(["/healthz?status=ok"]);

    await closeServer(guard);
    await closeServer(target);
  }, 15000);

  it("ignores stale public-path overrides for both customer webhook paths", async () => {
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
        OPENCLAW_PUBLIC_GATEWAY_PATHS:
          "/facebook/webhook,/messenger/webhook,/healthz",
      },
    });
    await waitForListening(guard);

    const publicPort = guard.address().port;
    const legacyWebhookResponse = await fetch(
      `http://127.0.0.1:${publicPort}/messenger/webhook?hub.challenge=ok`,
    );
    const defaultWebhookResponse = await fetch(
      `http://127.0.0.1:${publicPort}/facebook/webhook?hub.challenge=ok`,
    );
    const healthResponse = await fetch(
      `http://127.0.0.1:${publicPort}/healthz?status=ok`,
    );

    expect(legacyWebhookResponse.status).toBe(404);
    expect(await legacyWebhookResponse.text()).toBe("Not found");
    expect(defaultWebhookResponse.status).toBe(404);
    expect(await defaultWebhookResponse.text()).toBe("Not found");
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.json()).toEqual({
      ok: true,
      path: "/healthz?status=ok",
    });
    expect(seenPaths).toEqual(["/healthz?status=ok"]);

    await closeServer(guard);
    await closeServer(target);
  }, 15000);

  it("ignores a stale portal origin and keeps every customer route off the personal gateway", async () => {
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
        OPENCLAW_PUBLIC_PORTAL_ORIGIN: `http://127.0.0.1:${portalTarget.address().port}`,
      },
    });
    await waitForListening(guard);

    const publicUrl = `http://127.0.0.1:${guard.address().port}`;
    const customerRequests = [
      ["/", undefined],
      ["/portal", undefined],
      ["/api/trpc/portal.auth.session", undefined],
      ["/api/facebook/connect/callback?code=ok&state=state-value", undefined],
      ["/api/portal/ai-identity", { method: "POST" }],
      [
        "/api/webhooks/mollie/payments",
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "id=tr_payment123",
        },
      ],
    ];
    const responses = await Promise.all(
      customerRequests.map(([pathname, init]) =>
        fetch(`${publicUrl}${pathname}`, init),
      ),
    );

    for (const response of responses) {
      expect(response.status).toBe(404);
    }
    expect(seenGatewayPaths).toEqual([]);
    expect(seenPortalPaths).toEqual([]);

    await closeServer(guard);
    await closeServer(portalTarget);
    await closeServer(gatewayTarget);
  }, 15000);

  it("ignores a stale portal origin for the Mollie payment webhook", async () => {
    const seenGatewayRequests = [];
    const gatewayTarget = http.createServer((req, res) => {
      seenGatewayRequests.push({ method: req.method, path: req.url });
      res.end("gateway");
    });
    gatewayTarget.listen(0, "127.0.0.1");
    await waitForListening(gatewayTarget);

    const seenPortalRequests = [];
    const portalTarget = http.createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        seenPortalRequests.push({ method: req.method, path: req.url, body });
        res.end("portal");
      });
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

    try {
      const publicPort = guard.address().port;
      const allowed = await fetch(
        `http://127.0.0.1:${publicPort}/api/webhooks/mollie/payments`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: "id=tr_payment123",
        },
      );
      const blockedGet = await fetch(
        `http://127.0.0.1:${publicPort}/api/webhooks/mollie/payments`,
      );
      const blockedNearMisses = await Promise.all([
        fetch(`http://127.0.0.1:${publicPort}/api/webhooks/mollie/payment`, {
          method: "POST",
        }),
        fetch(`http://127.0.0.1:${publicPort}/api/webhooks/mollie/payments/`, {
          method: "POST",
        }),
        fetch(
          `http://127.0.0.1:${publicPort}/api/webhooks/mollie/payments-extra`,
          {
            method: "POST",
          },
        ),
      ]);

      expect(allowed.status).toBe(404);
      expect(await allowed.text()).toBe("Not found");
      expect(blockedGet.status).toBe(404);
      expect(blockedNearMisses.map((response) => response.status)).toEqual([
        404, 404, 404,
      ]);
      expect(seenPortalRequests).toEqual([]);
      expect(seenGatewayRequests).toEqual([]);
    } finally {
      await closeServer(guard);
      await closeServer(portalTarget);
      await closeServer(gatewayTarget);
    }
  }, 15000);

  it("ignores a stale portal origin for billing export and receipt routes", async () => {
    const seenGatewayRequests = [];
    const gatewayTarget = http.createServer((req, res) => {
      seenGatewayRequests.push({ method: req.method, path: req.url });
      res.end("gateway");
    });
    gatewayTarget.listen(0, "127.0.0.1");
    await waitForListening(gatewayTarget);

    const seenPortalRequests = [];
    const portalTarget = http.createServer((req, res) => {
      seenPortalRequests.push({ method: req.method, path: req.url });
      res.end("portal");
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

    try {
      const publicUrl = `http://127.0.0.1:${guard.address().port}`;
      const exportPath = "/api/portal/billing/export.csv?workspaceId=42";
      const receiptPath =
        "/api/portal/billing/receipts/tr_payment123?workspaceId=42";

      const allowedExportGet = await fetch(`${publicUrl}${exportPath}`);
      const allowedExportHead = await fetch(`${publicUrl}${exportPath}`, {
        method: "HEAD",
      });
      const allowedReceiptGet = await fetch(`${publicUrl}${receiptPath}`);
      const allowedReceiptHead = await fetch(`${publicUrl}${receiptPath}`, {
        method: "HEAD",
      });

      expect([
        allowedExportGet.status,
        allowedExportHead.status,
        allowedReceiptGet.status,
        allowedReceiptHead.status,
      ]).toEqual([404, 404, 404, 404]);

      const blockedResponses = await Promise.all([
        fetch(`${publicUrl}/api/portal/billing/export.csv`, { method: "POST" }),
        fetch(`${publicUrl}/api/portal/billing/receipts/tr_payment123`, {
          method: "PUT",
        }),
        fetch(`${publicUrl}/api/portal/billing/export.csv/`),
        fetch(`${publicUrl}/api/portal/billing/export.csv-extra`),
        fetch(`${publicUrl}/api/portal/billing/receipts`),
        fetch(`${publicUrl}/api/portal/billing/receipt/tr_payment123`),
        fetch(`${publicUrl}/api/portal/billing/receipts-extra/tr_payment123`),
      ]);

      expect(blockedResponses.map((response) => response.status)).toEqual([
        404, 404, 404, 404, 404, 404, 404,
      ]);
      expect(seenPortalRequests).toEqual([]);
      expect(seenGatewayRequests).toEqual([]);
    } finally {
      await closeServer(guard);
      await closeServer(portalTarget);
      await closeServer(gatewayTarget);
    }
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
    const loginResponse = await fetch(
      `http://127.0.0.1:${publicPort}/admin/login`,
    );
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
    const failedLogin = await fetch(
      `http://127.0.0.1:${publicPort}/admin/login`,
      {
        method: "POST",
        body: new URLSearchParams({ token: "wrong-token" }),
      },
    );
    const successfulLogin = await fetch(
      `http://127.0.0.1:${publicPort}/admin/login`,
      {
        method: "POST",
        body: new URLSearchParams({ token: "secret-token" }),
        redirect: "manual",
      },
    );
    const cookie = successfulLogin.headers.get("set-cookie") || "";
    const dashboardResponse = await fetch(
      `http://127.0.0.1:${publicPort}/dashboard?tab=plugins`,
      {
        headers: {
          cookie,
        },
      },
    );
    const retiredWebhookResponse = await fetch(
      `http://127.0.0.1:${publicPort}/facebook/webhook`,
      { headers: { cookie } },
    );

    expect(loginPage.status).toBe(200);
    expect(await loginPage.text()).toContain("OpenClaw Admin");
    expect(failedLogin.status).toBe(401);
    expect(successfulLogin.status).toBe(303);
    expect(successfulLogin.headers.get("location")).toBe("/");
    expect(cookie).toContain("openclaw_admin=");
    expect(dashboardResponse.status).toBe(200);
    expect(retiredWebhookResponse.status).toBe(404);
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
    expect(JSON.parse(dashboardResponse.body)).toEqual({
      ok: true,
      path: "/dashboard",
    });

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
    const blockedUpgrade = await requestRawUpgrade({
      port: publicPort,
      path: "/ws",
    });
    const successfulLogin = await fetch(
      `http://127.0.0.1:${publicPort}/admin/login`,
      {
        method: "POST",
        body: new URLSearchParams({ token: "secret-token" }),
        redirect: "manual",
      },
    );
    const cookie = successfulLogin.headers.get("set-cookie") || "";
    const retiredWebhookUpgrade = await requestRawUpgrade({
      port: publicPort,
      path: "/facebook/webhook",
      cookie,
    });
    const proxiedUpgrade = await requestRawUpgrade({
      port: publicPort,
      path: "/ws",
      cookie,
    });

    expect(blockedUpgrade).toBe("");
    expect(retiredWebhookUpgrade).toBe("");
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
    expect(isAdminHostAllowed("leaderbot-openclaw-gateway.fly.dev")).toBe(
      false,
    );
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
