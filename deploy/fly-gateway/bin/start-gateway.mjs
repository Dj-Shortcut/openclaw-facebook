#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const stateDir = process.env.OPENCLAW_STATE_DIR || "/data";
const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(stateDir, "openclaw.json");
const pluginPath = process.env.OPENCLAW_FACEBOOK_PLUGIN_PATH || "/app/node_modules/@dj-shortcut/facebook";
const codexPluginPath = process.env.OPENCLAW_CODEX_PLUGIN_PATH || "/app/node_modules/@openclaw/codex";
const defaultDmPolicy = process.env.OPENCLAW_FACEBOOK_DEFAULT_DM_POLICY || "pairing";
const defaultAgentModel = process.env.OPENCLAW_AGENT_MODEL || "";
const defaultAgentThinking = process.env.OPENCLAW_AGENT_THINKING_DEFAULT || "";
const allowOpen = process.env.OPENCLAW_FACEBOOK_ALLOW_OPEN === "1";

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

function ensurePublicMessengerBaseline(config) {
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
  uniquePush(config.plugins.load.paths, codexPluginPath);
  if (Array.isArray(config.plugins.allow)) {
    uniquePush(config.plugins.allow, "facebook");
    uniquePush(config.plugins.allow, "codex");
  }

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
  if (config.plugins.entries.codex.enabled === undefined) {
    config.plugins.entries.codex.enabled = true;
  }
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

  if (defaultAgentModel || defaultAgentThinking) {
    if (!isObject(config.agents)) {
      config.agents = {};
    }
    if (!isObject(config.agents.defaults)) {
      config.agents.defaults = {};
    }
    if (defaultAgentModel && config.agents.defaults.model === undefined) {
      config.agents.defaults.model = { primary: defaultAgentModel };
    }
    if (defaultAgentThinking && config.agents.defaults.thinkingDefault === undefined) {
      config.agents.defaults.thinkingDefault = defaultAgentThinking;
    }
  }

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

fs.mkdirSync(stateDir, { recursive: true });
const config = ensurePublicMessengerBaseline(readJsonFile(configPath));
writeJsonFile(configPath, config);

const openclawBin = path.join(process.cwd(), "node_modules", "openclaw", "openclaw.mjs");
const args = [openclawBin, "gateway", ...process.argv.slice(2)];
const child = spawn(process.execPath, args, {
  stdio: "inherit",
  env: {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: configPath,
  },
});

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
