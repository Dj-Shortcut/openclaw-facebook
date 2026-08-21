import { describe, expect, it } from "vitest";
import {
  validateFlyGatewayConfig,
  validateGatewayDeploymentSafety,
  validateManagedUpdateWorkflow,
} from "./validate-gateway-deployment-safety.mjs";

describe("gateway deployment safety validation", () => {
  it("accepts the checked-in gateway config and update workflow", () => {
    expect(validateGatewayDeploymentSafety()).toEqual({
      agentModel: "openai/gpt-5.4-mini",
      heapLimitMiB: 1536,
      vmMemoryMiB: 4096,
    });
  });

  it("rejects unreviewed model or memory drift", () => {
    const valid = [
      'OPENCLAW_AGENT_MODEL = "openai/gpt-5.4-mini"',
      'NODE_OPTIONS = "--max-old-space-size=1536"',
      'OPENCLAW_PUBLIC_GATEWAY_PATHS = "/facebook/webhook,/healthz"',
      'memory = "4096"',
    ].join("\n");

    expect(() => validateFlyGatewayConfig(valid.replace("gpt-5.4-mini", "placeholder"))).toThrow(
      "provider-qualified"
    );
    expect(() => validateFlyGatewayConfig(valid.replace("1536", "3072"))).toThrow(
      "heap limit"
    );
  });

  it("rejects update automation that deploys or skips draft approval", () => {
    const valid = [
      "managed-redeploy-handoff.md",
      "approval_status: pending",
      "gh pr create --draft",
    ].join("\n");

    expect(() => validateManagedUpdateWorkflow(`${valid}\nfly deploy`)).toThrow(
      "must never deploy"
    );
    expect(() => validateManagedUpdateWorkflow(valid.replace("--draft", ""))).toThrow(
      "created as drafts"
    );
  });
});
