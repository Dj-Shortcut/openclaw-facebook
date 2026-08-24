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

  const disableAgentMemory = (entry) => {
    if (!isObject(entry)) return;
    delete entry.memory;
    if (!isObject(entry.compaction)) entry.compaction = {};
    entry.compaction.memoryFlush = { enabled: false };
  };
  for (const roster of [config.agents.entries, config.agents.list]) {
    if (isObject(roster) || Array.isArray(roster)) {
      for (const entry of Object.values(roster)) {
        disableAgentMemory(entry);
      }
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

const publicMemoryEntries = ["USER.md", "MEMORY.md", "memory"];

function lstatIfPresent(entryPath) {
  try {
    return fs.lstatSync(entryPath);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
}

function normalizeAgentId(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function configuredAgentEntries(config) {
  const agents = isObject(config.agents) ? config.agents : {};
  if (Object.hasOwn(agents, "entries")) {
    if (!isObject(agents.entries)) return [];
    return Object.entries(agents.entries).flatMap(([id, entry]) =>
      isObject(entry) ? [{ id, entry }] : [],
    );
  }
  if (!Array.isArray(agents.list)) return [];
  return agents.list.flatMap((entry) =>
    isObject(entry) && typeof entry.id === "string"
      ? [{ id: entry.id, entry }]
      : [],
  );
}

function resolveConfiguredWorkspace(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  const configured = value.trim().replaceAll("\0", "");
  if (configured === "~") {
    return path.resolve(process.env.HOME || "/home/node");
  }
  if (configured.startsWith("~/")) {
    return path.resolve(process.env.HOME || "/home/node", configured.slice(2));
  }
  return path.resolve(configured);
}

function resolveEffectiveMainWorkspace(config) {
  const entries = configuredAgentEntries(config);
  const mainEntry = entries.find(({ id }) => normalizeAgentId(id) === "main");
  const mainWorkspace = resolveConfiguredWorkspace(mainEntry?.entry.workspace);
  if (mainWorkspace) return mainWorkspace;

  const fallback = resolveConfiguredWorkspace(
    config.agents?.defaults?.workspace,
  );
  const defaultEntry =
    entries.find(({ entry }) => entry.default === true) ?? entries[0];
  if (!defaultEntry || normalizeAgentId(defaultEntry.id) === "main") {
    return fallback || path.resolve(workspaceDir);
  }
  if (fallback) return path.join(fallback, "main");
  return path.join(path.resolve(stateDir), "workspace-main");
}

function assertSafeWorkspaceTarget(target) {
  const workspaceRoot = path.resolve(target.workspace);
  if (workspaceRoot === path.parse(workspaceRoot).root) {
    throw new Error(`${target.label} is not a safe quarantine source`);
  }
  const workspaceStat = lstatIfPresent(workspaceRoot);
  if (
    workspaceStat &&
    (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink())
  ) {
    throw new Error(`${target.label} is not a safe quarantine source`);
  }
  return workspaceStat ? fs.realpathSync(workspaceRoot) : workspaceRoot;
}

function isPathInside(parentPath, candidatePath) {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function assertSafeQuarantineDirectory(directoryPath) {
  const directoryStat = lstatIfPresent(directoryPath);
  if (
    directoryStat &&
    (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
  ) {
    throw new Error("Public memory quarantine path is not a safe directory");
  }
  if (directoryStat) fs.chmodSync(directoryPath, 0o700);
}

function quarantineSharedPublicMemory(config) {
  const quarantineDir = path.resolve(stateDir, "private-memory-quarantine-v1");
  const envWorkspace = path.resolve(workspaceDir);
  const effectiveMainWorkspace = resolveEffectiveMainWorkspace(config);
  const targetCandidates = [
    {
      workspace: envWorkspace,
      quarantine: quarantineDir,
      label: "Public workspace",
    },
  ];
  if (path.resolve(effectiveMainWorkspace) !== envWorkspace) {
    targetCandidates.push({
      workspace: effectiveMainWorkspace,
      quarantine: path.join(quarantineDir, "main-agent-workspace"),
      label: "Public main-agent workspace",
    });
  }

  const targets = [];
  for (const candidate of targetCandidates) {
    const target = {
      ...candidate,
      workspace: assertSafeWorkspaceTarget(candidate),
    };
    if (targets.some((existing) => existing.workspace === target.workspace)) {
      continue;
    }
    if (isPathInside(quarantineDir, target.workspace)) {
      throw new Error(`${target.label} is not a safe quarantine source`);
    }
    targets.push(target);
  }
  assertSafeQuarantineDirectory(quarantineDir);
  for (const target of targets.slice(1)) {
    assertSafeQuarantineDirectory(target.quarantine);
  }

  // Resolve every collision and cross-workspace overlap before moving anything.
  // This keeps a rollback/reappearance failure from partially consuming either
  // the current workspace or an existing recoverable quarantine.
  const moves = [];
  const quarantineRootStat = lstatIfPresent(quarantineDir);
  const stateDevice = fs.lstatSync(stateDir).dev;
  for (const target of targets) {
    const quarantineDevice =
      lstatIfPresent(target.quarantine)?.dev ??
      quarantineRootStat?.dev ??
      stateDevice;
    for (const entry of publicMemoryEntries) {
      const source = path.join(target.workspace, entry);
      const sourceStat = lstatIfPresent(source);
      if (!sourceStat) continue;
      for (const otherTarget of targets) {
        if (
          otherTarget !== target &&
          sourceStat.isDirectory() &&
          !sourceStat.isSymbolicLink() &&
          isPathInside(source, otherTarget.workspace)
        ) {
          throw new Error(
            "Public workspace memory overlaps another quarantine source",
          );
        }
      }
      if (sourceStat.dev !== quarantineDevice) {
        throw new Error(
          `${target.label} memory cannot be quarantined across filesystems`,
        );
      }
      const destination = path.join(target.quarantine, entry);
      if (lstatIfPresent(destination)) {
        throw new Error(
          `${target.label} memory reappeared after quarantine: ${entry}`,
        );
      }
      moves.push({ source, destination, quarantine: target.quarantine });
    }
  }

  for (const move of moves) {
    fs.mkdirSync(move.quarantine, { recursive: true, mode: 0o700 });
    fs.chmodSync(quarantineDir, 0o700);
    fs.chmodSync(move.quarantine, 0o700);
    fs.renameSync(move.source, move.destination);
  }
  for (const directory of [
    quarantineDir,
    ...targets.slice(1).map((target) => target.quarantine),
  ]) {
    if (lstatIfPresent(directory)) fs.chmodSync(directory, 0o700);
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
  const config = ensurePublicMessengerBaseline(readJsonFile(configPath));
  quarantineSharedPublicMemory(config);
  writeJsonFile(configPath, config);
  return config;
}

export function startGateway() {
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
