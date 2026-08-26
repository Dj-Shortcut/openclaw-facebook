import { describe, expect, it } from "vitest";
import {
  validateFlyGatewayConfig,
  validateGatewayDeploymentSafety,
  validateManagedUpdateWorkflow,
  validatePluginWorkflow,
} from "./validate-gateway-deployment-safety.mjs";

const validFlyConfig = [
  "[env]",
  'OPENCLAW_AGENT_MODEL = "openai/gpt-5.4-mini"',
  'NODE_OPTIONS = "--max-old-space-size=1536"',
  'OPENCLAW_FACEBOOK_UNKNOWN_SENDER_MODE = "pairing"',
  'OPENCLAW_FACEBOOK_LEADERBOT_BRIDGE_ENABLED = "0"',
  'OPENCLAW_PUBLIC_GATEWAY_GUARD = "1"',
  'OPENCLAW_PUBLIC_GATEWAY_PATHS = "/healthz"',
  "",
  "[[vm]]",
  'memory = "4096"',
].join("\n");

const validUpdateWorkflow = [
  "managed-redeploy-handoff.md",
  "approval_status: pending",
  'gh pr ready "$branch" --undo',
  'git push --force-with-lease origin "$branch"',
  "gh pr create --draft",
].join("\n");

function moveTomlAssignmentToOtherTable(text, setting) {
  const lines = text.split("\n");
  const assignmentIndex = lines.findIndex((line) =>
    line.startsWith(`${setting} =`),
  );
  const [assignment] = lines.splice(assignmentIndex, 1);
  return [...lines, "", "[other]", assignment].join("\n");
}

describe("gateway deployment safety validation", () => {
  it("accepts the checked-in gateway config and update workflow", () => {
    expect(validateGatewayDeploymentSafety()).toEqual({
      agentModel: "openai/gpt-5.4-mini",
      heapLimitMiB: 1536,
      vmMemoryMiB: 4096,
    });
  });

  it("rejects unreviewed model or memory drift", () => {
    expect(() =>
      validateFlyGatewayConfig(
        validFlyConfig.replace("gpt-5.4-mini", "placeholder"),
      ),
    ).toThrow("provider-qualified");
    expect(() =>
      validateFlyGatewayConfig(validFlyConfig.replace("1536", "3072")),
    ).toThrow("heap limit");
    expect(() =>
      validateFlyGatewayConfig(
        validFlyConfig.replace('GUARD = "1"', 'GUARD = "0"'),
      ),
    ).toThrow("route guard enabled");
    expect(() =>
      validateFlyGatewayConfig(
        validFlyConfig.replace(
          'UNKNOWN_SENDER_MODE = "pairing"',
          'UNKNOWN_SENDER_MODE = "leaderbot_free_tier"',
        ),
      ),
    ).toThrow("pairing mode");
    expect(() =>
      validateFlyGatewayConfig(
        validFlyConfig.replace(
          'LEADERBOT_BRIDGE_ENABLED = "0"',
          'LEADERBOT_BRIDGE_ENABLED = "1"',
        ),
      ),
    ).toThrow("bridge disabled");
    expect(() =>
      validateFlyGatewayConfig(
        `${validFlyConfig}\nLEADERBOT_IMAGE_GEN_URL = "https://image-gen.example.test"`,
      ),
    ).toThrow("retired Leaderbot bridge URL");
    expect(() =>
      validateFlyGatewayConfig(validFlyConfig.replace("4096", "2048")),
    ).toThrow("VM allocation");
  });

  it.each([
    ["OPENCLAW_AGENT_MODEL", "provider-qualified"],
    ["NODE_OPTIONS", "heap limit"],
    ["OPENCLAW_FACEBOOK_UNKNOWN_SENDER_MODE", "pairing mode"],
    ["OPENCLAW_FACEBOOK_LEADERBOT_BRIDGE_ENABLED", "bridge disabled"],
    ["OPENCLAW_PUBLIC_GATEWAY_GUARD", "route guard enabled"],
    ["OPENCLAW_PUBLIC_GATEWAY_PATHS", "public health route"],
    ["memory", "VM allocation"],
  ])("rejects %s outside its reviewed Fly table", (setting, message) => {
    expect(() =>
      validateFlyGatewayConfig(
        moveTomlAssignmentToOtherTable(validFlyConfig, setting),
      ),
    ).toThrow(message);
  });

  it("rejects table-like settings hidden inside TOML multiline strings", () => {
    const spoofed = [
      'description = """',
      validFlyConfig,
      '"""',
      "[other]",
    ].join("\n");

    expect(() => validateFlyGatewayConfig(spoofed)).toThrow(
      "does not allow multiline strings",
    );
  });

  it("requires the reviewed memory in every Fly VM table", () => {
    expect(() =>
      validateFlyGatewayConfig(`${validFlyConfig}\n\n[[vm]]\nmemory = "512"`),
    ).toThrow("VM allocation");
  });

  it("rejects update automation that deploys or skips draft approval", () => {
    expect(() =>
      validateManagedUpdateWorkflow(`${validUpdateWorkflow}\nfly deploy`),
    ).toThrow("must never deploy");
    expect(() =>
      validateManagedUpdateWorkflow(validUpdateWorkflow.replace("--draft", "")),
    ).toThrow("created as drafts");
    expect(() =>
      validateManagedUpdateWorkflow(
        validUpdateWorkflow.replace('gh pr ready "$branch" --undo\n', ""),
      ),
    ).toThrow("returned to draft");
    expect(() =>
      validateManagedUpdateWorkflow(
        validUpdateWorkflow.replace(
          'gh pr ready "$branch" --undo\ngit push --force-with-lease origin "$branch"',
          'git push --force-with-lease origin "$branch"\ngh pr ready "$branch" --undo',
        ),
      ),
    ).toThrow("before force-pushing");
  });

  it.each([
    "gh pr create --title unsafe",
    "gh pr create --title unsafe # --draft",
    'gh pr create --body "mention --draft later"',
    "gh pr create --title unsafe; echo --draft",
  ])("requires draft mode on every creation command: %s", (createCommand) => {
    expect(() =>
      validateManagedUpdateWorkflow(`${validUpdateWorkflow}\n${createCommand}`),
    ).toThrow("created as drafts");
  });

  it.each(["# gh pr create --draft", 'echo "gh pr create --draft"'])(
    "does not count inactive creation text as a command: %s",
    (inactiveText) => {
      expect(() =>
        validateManagedUpdateWorkflow(
          validUpdateWorkflow.replace("gh pr create --draft", inactiveText),
        ),
      ).toThrow("created as drafts");
    },
  );

  it.each([
    "id-token: write",
    'id-token: "write"',
    "id-token: 'write'",
    "id-token: write # deploy identity",
    "\"id-token\": 'write' # deploy identity",
    "id-token: >-\n    write",
    "id-token: *oidc_permission",
    "permissions: { contents: read, id-token: write }",
    '"id\\u002dtoken": write',
  ])("rejects deploy identity permission form: %s", (permission) => {
    expect(() =>
      validateManagedUpdateWorkflow(
        `${validUpdateWorkflow}\npermissions:\n  ${permission}`,
      ),
    ).toThrow("deploy identity tokens");
  });

  it("ignores disabled deploy identity permission comments", () => {
    expect(() =>
      validateManagedUpdateWorkflow(
        `${validUpdateWorkflow}\npermissions:\n  # id-token: write`,
      ),
    ).not.toThrow();
  });

  it.each([
    "id-token: none",
    'id-token: "none" # explicitly disabled',
    "permissions: { contents: read, id-token: none }",
  ])(
    "allows explicitly disabled deploy identity permission: %s",
    (permission) => {
      expect(() =>
        validateManagedUpdateWorkflow(
          `${validUpdateWorkflow}\npermissions:\n  ${permission}`,
        ),
      ).not.toThrow();
    },
  );

  it("requires pull-request validation for fly.toml-only changes", () => {
    expect(() => validatePluginWorkflow('paths:\n  - "docs/**"')).toThrow(
      "fly.toml pull-request changes",
    );
    expect(() =>
      validatePluginWorkflow('paths:\n  - "fly.toml"'),
    ).not.toThrow();
    expect(() =>
      validatePluginWorkflow(
        "on:\n  pull_request:\n  push:\n    branches: [main]",
      ),
    ).not.toThrow();
  });
});
