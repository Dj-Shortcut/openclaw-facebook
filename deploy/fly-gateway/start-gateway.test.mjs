import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

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
  });

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
  });

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
  });
});
