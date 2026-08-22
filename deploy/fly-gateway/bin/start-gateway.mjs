#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import process from "node:process";
import {
  buildGatewayLaunchPlan,
  startPublicRouteGuard,
} from "./public-route-guard.mjs";
import { assertLeaderbotAiAnswerQuotaReadiness } from "./ai-answer-quota-readiness.mjs";

const stateDir = process.env.OPENCLAW_STATE_DIR || "/data";
const configPath =
  process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir, "openclaw.json");
const workspaceDir =
  process.env.OPENCLAW_WORKSPACE_DIR || path.join(stateDir, "workspace");
const legacyWorkspaceDir = path.join(
  process.env.HOME || "/home/node",
  ".openclaw",
  "workspace",
);
const pluginPath =
  process.env.OPENCLAW_FACEBOOK_PLUGIN_PATH ||
  "/app/node_modules/@dj-shortcut/facebook";
const codexPluginPath =
  process.env.OPENCLAW_CODEX_PLUGIN_PATH || "/app/node_modules/@openclaw/codex";
const defaultDmPolicy =
  process.env.OPENCLAW_FACEBOOK_DEFAULT_DM_POLICY || "pairing";
const defaultUnknownSenderMode =
  process.env.OPENCLAW_FACEBOOK_UNKNOWN_SENDER_MODE || "";
const defaultLeaderbotBridgeEnabled =
  process.env.OPENCLAW_FACEBOOK_LEADERBOT_BRIDGE_ENABLED || "";
const defaultAgentModel = process.env.OPENCLAW_AGENT_MODEL || "";
const defaultAgentThinking = process.env.OPENCLAW_AGENT_THINKING_DEFAULT || "";
const allowOpen = process.env.OPENCLAW_FACEBOOK_ALLOW_OPEN === "1";
const allowedUnknownSenderModes = new Set(["pairing", "leaderbot_free_tier"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return {};
    }
    throw new Error(
      `Cannot read OpenClaw config JSON at ${filePath}: ${error.message}`,
    );
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
}

function uniquePush(list, value) {
  if (!list.includes(value)) {
    list.push(value);
  }
}

function ensurePublicToolDeny(config, toolId) {
  if (!isObject(config.tools)) {
    config.tools = {};
  }
  if (!Array.isArray(config.tools.deny)) {
    config.tools.deny = [];
  }
  uniquePush(config.tools.deny, toolId);
}

function ensureAgentDefaults(config) {
  if (!isObject(config.agents)) {
    config.agents = {};
  }
  if (!isObject(config.agents.defaults)) {
    config.agents.defaults = {};
  }
  if (
    config.agents.defaults.workspace === undefined ||
    path.resolve(String(config.agents.defaults.workspace)) ===
      path.resolve(legacyWorkspaceDir)
  ) {
    config.agents.defaults.workspace = workspaceDir;
  }
  if (defaultAgentModel && config.agents.defaults.model === undefined) {
    config.agents.defaults.model = { primary: defaultAgentModel };
  }
  if (
    defaultAgentThinking &&
    config.agents.defaults.thinkingDefault === undefined
  ) {
    config.agents.defaults.thinkingDefault = defaultAgentThinking;
  }
}

function ensurePublicMemoryDisabled(config) {
  if (!isObject(config.plugins)) config.plugins = {};
  if (!isObject(config.plugins.slots)) config.plugins.slots = {};
  config.plugins.slots.memory = "none";
  if (!isObject(config.plugins.entries)) config.plugins.entries = {};
  if (!isObject(config.plugins.entries["memory-core"])) {
    config.plugins.entries["memory-core"] = {};
  }
  config.plugins.entries["memory-core"].enabled = false;

  if (!isObject(config.agents)) config.agents = {};
  if (!isObject(config.agents.defaults)) config.agents.defaults = {};
  if (!isObject(config.agents.defaults.compaction)) {
    config.agents.defaults.compaction = {};
  }
  config.agents.defaults.compaction.memoryFlush = { enabled: false };
  delete config.agents.defaults.memory;
  if (isObject(config.agents.entries) || Array.isArray(config.agents.entries)) {
    for (const entry of Object.values(config.agents.entries)) {
      if (isObject(entry)) delete entry.memory;
    }
  }
  delete config.memory;

  if (!isObject(config.hooks)) config.hooks = {};
  if (!isObject(config.hooks.internal)) config.hooks.internal = {};
  if (!isObject(config.hooks.internal.entries)) {
    config.hooks.internal.entries = {};
  }
  config.hooks.internal.entries["session-memory"] = { enabled: false };

  for (const tool of [
    "memory_search",
    "memory_get",
    "memory_recall",
    "group:memory",
  ]) {
    ensurePublicToolDeny(config, tool);
  }
}

function resolveDefaultUnknownSenderMode() {
  const mode = defaultUnknownSenderMode.trim();
  if (!mode) {
    return "";
  }
  if (!allowedUnknownSenderModes.has(mode)) {
    throw new Error(
      'OPENCLAW_FACEBOOK_UNKNOWN_SENDER_MODE must be "pairing" or "leaderbot_free_tier".',
    );
  }
  return mode;
}

function resolveDefaultLeaderbotBridgeEnabled() {
  const value = defaultLeaderbotBridgeEnabled.trim().toLowerCase();
  if (!value) {
    return undefined;
  }
  if (value === "1" || value === "true") {
    return true;
  }
  if (value === "0" || value === "false") {
    return false;
  }
  throw new Error(
    'OPENCLAW_FACEBOOK_LEADERBOT_BRIDGE_ENABLED must be "1", "0", "true", or "false".',
  );
}

function copyIfMissing(sourcePath, destPath) {
  if (!fs.existsSync(sourcePath) || fs.existsSync(destPath)) {
    return false;
  }
  fs.cpSync(sourcePath, destPath, {
    recursive: fs.statSync(sourcePath).isDirectory(),
    errorOnExist: true,
    force: false,
  });
  return true;
}

function migrateLegacyWorkspaceFiles() {
  if (path.resolve(legacyWorkspaceDir) === path.resolve(workspaceDir)) {
    return;
  }
  if (!fs.existsSync(legacyWorkspaceDir)) {
    return;
  }
  fs.mkdirSync(workspaceDir, { recursive: true });
  const entries = ["AGENTS.md", "SOUL.md", "TOOLS.md", "IDENTITY.md"];
  let copied = 0;
  for (const entry of entries) {
    if (
      copyIfMissing(
        path.join(legacyWorkspaceDir, entry),
        path.join(workspaceDir, entry),
      )
    ) {
      copied += 1;
    }
  }
  if (copied > 0) {
    console.warn(
      `migrated ${copied} OpenClaw workspace entr${copied === 1 ? "y" : "ies"} from ${legacyWorkspaceDir} to ${workspaceDir}`,
    );
  }
}

function quarantineSharedPublicMemory() {
  const quarantineDir = path.join(stateDir, "private-memory-quarantine-v1");
  const entries = ["USER.md", "MEMORY.md", "memory"];
  for (const entry of entries) {
    const source = path.join(workspaceDir, entry);
    if (!fs.existsSync(source)) continue;
    fs.mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
    const destination = path.join(quarantineDir, entry);
    if (fs.existsSync(destination)) {
      throw new Error(
        `Public workspace memory reappeared after quarantine: ${entry}`,
      );
    }
    fs.renameSync(source, destination);
  }
}

function ensurePublicMessengerBaseline(config) {
  if (!isObject(config.session)) {
    config.session = {};
  }
  if (config.session.dmScope !== "per-account-channel-peer") {
    if (config.session.dmScope !== undefined) {
      console.warn(
        `session.dmScope=${JSON.stringify(config.session.dmScope)} is not safe for a public multi-tenant Messenger gateway; switching to "per-account-channel-peer".`,
      );
    }
    config.session.dmScope = "per-account-channel-peer";
  }
  if (Array.isArray(config.bindings)) {
    for (const binding of config.bindings) {
      if (
        !isObject(binding) ||
        !isObject(binding.match) ||
        binding.match.channel !== "facebook"
      ) {
        continue;
      }
      if (binding.agentId !== undefined && binding.agentId !== "main") {
        throw new Error(
          "Public Facebook routes must use the isolated main agent",
        );
      }
      if (
        !isObject(binding.session) ||
        binding.session.dmScope === undefined ||
        binding.session.dmScope === "per-account-channel-peer"
      ) {
        continue;
      }
      console.warn(
        "A Facebook route binding used an unsafe DM scope; switching it to per-account-channel-peer.",
      );
      binding.session.dmScope = "per-account-channel-peer";
    }
  }

  if (!isObject(config.attachments)) {
    config.attachments = {};
  }
  if (
    !Number.isFinite(config.attachments.ttlHours) ||
    config.attachments.ttlHours <= 0 ||
    config.attachments.ttlHours > 24
  ) {
    config.attachments.ttlHours = 24;
  }

  if (!isObject(config.gateway)) {
    config.gateway = {};
  }
  // This deployment runs the gateway and Messenger worker in the same process.
  // A persisted remote target makes OpenClaw call back through the public proxy,
  // which can strand work in a reconnect/draining loop.
  config.gateway.mode = "local";
  delete config.gateway.remote;

  if (!isObject(config.plugins)) {
    config.plugins = {};
  }
  if (!isObject(config.plugins.load)) {
    config.plugins.load = {};
  }
  if (!Array.isArray(config.plugins.load.paths)) {
    config.plugins.load.paths = [];
  }
  uniquePush(config.plugins.load.paths, pluginPath);
  config.plugins.load.paths = config.plugins.load.paths.filter(
    (entry) => entry !== codexPluginPath,
  );
  if (!Array.isArray(config.plugins.allow)) {
    config.plugins.allow = [];
  }
  config.plugins.allow = config.plugins.allow.filter(
    (entry) => entry !== "codex",
  );
  uniquePush(config.plugins.allow, "facebook");

  if (!isObject(config.plugins.entries)) {
    config.plugins.entries = {};
  }
  if (!isObject(config.plugins.entries.facebook)) {
    config.plugins.entries.facebook = {};
  }
  if (config.plugins.entries.facebook.enabled === undefined) {
    config.plugins.entries.facebook.enabled = true;
  }
  if (!isObject(config.plugins.entries.codex)) {
    config.plugins.entries.codex = {};
  }
  config.plugins.entries.codex.enabled = false;
  ensurePublicToolDeny(config, "image_generate");

  if (!isObject(config.channels)) {
    config.channels = {};
  }
  if (!isObject(config.channels.facebook)) {
    config.channels.facebook = {};
  }
  if (config.channels.facebook.dmPolicy === undefined) {
    config.channels.facebook.dmPolicy = defaultDmPolicy;
  }
  const unknownSenderMode = resolveDefaultUnknownSenderMode();
  if (
    unknownSenderMode &&
    config.channels.facebook.unknownSenderMode === undefined
  ) {
    config.channels.facebook.unknownSenderMode = unknownSenderMode;
  }
  const leaderbotBridgeEnabled = resolveDefaultLeaderbotBridgeEnabled();
  if (
    leaderbotBridgeEnabled !== undefined &&
    config.channels.facebook.leaderbotBridgeEnabled === undefined
  ) {
    config.channels.facebook.leaderbotBridgeEnabled = leaderbotBridgeEnabled;
  }

  ensureAgentDefaults(config);
  ensurePublicMemoryDisabled(config);

  const facebookConfig = config.channels.facebook;
  const allowFrom = Array.isArray(facebookConfig.allowFrom)
    ? facebookConfig.allowFrom
    : [];
  if (facebookConfig.dmPolicy === "open" && !allowOpen) {
    console.warn(
      'channels.facebook.dmPolicy="open" is not allowed for this public gateway; switching to "pairing".',
    );
    facebookConfig.dmPolicy = "pairing";
  }
  if (facebookConfig.dmPolicy === "open" && !allowFrom.includes("*")) {
    throw new Error(
      'channels.facebook.dmPolicy="open" requires channels.facebook.allowFrom to include "*".',
    );
  }

  return config;
}

export function prepareGatewayConfig() {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  migrateLegacyWorkspaceFiles();
  quarantineSharedPublicMemory();
  const config = ensurePublicMessengerBaseline(readJsonFile(configPath));
  writeJsonFile(configPath, config);
  return config;
}

export async function startGateway() {
  await assertLeaderbotAiAnswerQuotaReadiness();
  prepareGatewayConfig();
  const openclawBin = path.join(
    process.cwd(),
    "node_modules",
    "openclaw",
    "openclaw.mjs",
  );
  const launchPlan = buildGatewayLaunchPlan();
  if (launchPlan.guardEnabled) {
    startPublicRouteGuard({
      publicPort: launchPlan.publicPort,
      targetPort: launchPlan.internalPort,
      readinessCheck: () => assertLeaderbotAiAnswerQuotaReadiness(),
    });
  }
  const args = [openclawBin, "gateway", ...launchPlan.openclawArgs];
  const child = spawn(process.execPath, args, {
    stdio: "inherit",
    env: {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_WORKSPACE_DIR: workspaceDir,
    },
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startGateway().catch(() => {
    console.error("gateway startup failed: readiness preflight did not pass");
    process.exit(1);
  });
}
