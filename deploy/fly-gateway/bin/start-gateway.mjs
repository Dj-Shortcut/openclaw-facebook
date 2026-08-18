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

const stateDir = process.env.OPENCLAW_STATE_DIR || "/data";
const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir, "openclaw.json");
const workspaceDir = process.env.OPENCLAW_WORKSPACE_DIR || path.join(stateDir, "workspace");
const legacyWorkspaceDir = path.join(
  process.env.HOME || "/home/node",
  ".openclaw",
  "workspace",
);
const pluginPath = process.env.OPENCLAW_FACEBOOK_PLUGIN_PATH || "/app/node_modules/@dj-shortcut/facebook";
const codexPluginPath = process.env.OPENCLAW_CODEX_PLUGIN_PATH || "/app/node_modules/@openclaw/codex";
const defaultDmPolicy = process.env.OPENCLAW_FACEBOOK_DEFAULT_DM_POLICY || "pairing";
const defaultUnknownSenderMode = process.env.OPENCLAW_FACEBOOK_UNKNOWN_SENDER_MODE || "";
const defaultLeaderbotBridgeEnabled =
  process.env.OPENCLAW_FACEBOOK_LEADERBOT_BRIDGE_ENABLED || "";
const defaultAgentModel = process.env.OPENCLAW_AGENT_MODEL || "";
const defaultAgentThinking = process.env.OPENCLAW_AGENT_THINKING_DEFAULT || "";
const openAiApiKeyAvailable = Boolean(process.env.OPENAI_API_KEY?.trim());
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
    throw new Error(`Cannot read OpenClaw config JSON at ${filePath}: ${error.message}`);
  }
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
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
    path.resolve(String(config.agents.defaults.workspace)) === path.resolve(legacyWorkspaceDir)
  ) {
    config.agents.defaults.workspace = workspaceDir;
  }
  if (defaultAgentModel && config.agents.defaults.model === undefined) {
    config.agents.defaults.model = { primary: defaultAgentModel };
  }
  if (defaultAgentThinking && config.agents.defaults.thinkingDefault === undefined) {
    config.agents.defaults.thinkingDefault = defaultAgentThinking;
  }
}

function ensureMemorySearchSecretRef(config) {
  if (!openAiApiKeyAvailable) {
    return;
  }

  const secretRef = {
    source: "env",
    provider: "default",
    id: "OPENAI_API_KEY",
  };

  const configureMemory = (owner) => {
    if (!isObject(owner)) {
      return;
    }
    if (!isObject(owner.memory)) {
      owner.memory = {};
    }
    if (!isObject(owner.memory.search)) {
      owner.memory.search = {};
    }
    if (owner.memory.search.provider === undefined) {
      owner.memory.search.provider = "openai";
    }
    if (owner.memory.search.provider === "openai") {
      if (!isObject(owner.memory.search.remote)) {
        owner.memory.search.remote = {};
      }
      owner.memory.search.remote.apiKey = secretRef;
    }
  };

  configureMemory(config);
  if (isObject(config.agents)) {
    if (isObject(config.agents.defaults)) {
      delete config.agents.defaults.memory;
    }
    if (isObject(config.agents.entries)) {
      for (const entry of Object.values(config.agents.entries)) {
        if (isObject(entry)) {
          delete entry.memory;
        }
      }
    }
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
  const entries = [
    "AGENTS.md",
    "SOUL.md",
    "TOOLS.md",
    "IDENTITY.md",
    "USER.md",
    "HEARTBEAT.md",
    "MEMORY.md",
    "memory",
  ];
  let copied = 0;
  for (const entry of entries) {
    if (copyIfMissing(path.join(legacyWorkspaceDir, entry), path.join(workspaceDir, entry))) {
      copied += 1;
    }
  }
  if (copied > 0) {
    console.warn(
      `migrated ${copied} OpenClaw workspace entr${copied === 1 ? "y" : "ies"} from ${legacyWorkspaceDir} to ${workspaceDir}`,
    );
  }
}

function ensureWorkspaceMemoryFile() {
  const memoryPath = path.join(workspaceDir, "MEMORY.md");
  if (fs.existsSync(memoryPath)) {
    return false;
  }
  fs.writeFileSync(
    memoryPath,
    "# Memory\n\nPersistent assistant memory for this OpenClaw workspace.\n",
    { mode: 0o600 },
  );
  return true;
}

function ensurePublicMessengerBaseline(config) {
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
  config.plugins.load.paths = config.plugins.load.paths.filter((entry) => entry !== codexPluginPath);
  if (!Array.isArray(config.plugins.allow)) {
    config.plugins.allow = [];
  }
  config.plugins.allow = config.plugins.allow.filter((entry) => entry !== "codex");
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
  if (unknownSenderMode && config.channels.facebook.unknownSenderMode === undefined) {
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
  ensureMemorySearchSecretRef(config);

  const facebookConfig = config.channels.facebook;
  const allowFrom = Array.isArray(facebookConfig.allowFrom) ? facebookConfig.allowFrom : [];
  if (facebookConfig.dmPolicy === "open" && !allowOpen) {
    console.warn(
      'channels.facebook.dmPolicy="open" is not allowed for this public gateway; switching to "pairing".',
    );
    facebookConfig.dmPolicy = "pairing";
  }
  if (facebookConfig.dmPolicy === "open" && !allowFrom.includes("*")) {
    throw new Error('channels.facebook.dmPolicy="open" requires channels.facebook.allowFrom to include "*".');
  }

  return config;
}

export function prepareGatewayConfig() {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  migrateLegacyWorkspaceFiles();
  ensureWorkspaceMemoryFile();
  const config = ensurePublicMessengerBaseline(readJsonFile(configPath));
  writeJsonFile(configPath, config);
  return config;
}

export function startGateway() {
  prepareGatewayConfig();
  const openclawBin = path.join(process.cwd(), "node_modules", "openclaw", "openclaw.mjs");
  const launchPlan = buildGatewayLaunchPlan();
  if (launchPlan.guardEnabled) {
    startPublicRouteGuard({
      publicPort: launchPlan.publicPort,
      targetPort: launchPlan.internalPort,
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
  startGateway();
}
