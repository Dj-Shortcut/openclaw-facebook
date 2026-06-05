import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

type LifecycleRule = {
  id: string;
  enabled: boolean;
  conditions: {
    prefix: string;
  };
  deleteObjectsTransition?: {
    condition?: {
      type: string;
      maxAge: number;
    };
  };
};

type LifecyclePolicy = {
  rules: LifecycleRule[];
};

const THIRTY_DAYS_SECONDS = 30 * 24 * 60 * 60;

function loadPolicy(): LifecyclePolicy {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const policyPath = resolve(
    currentDir,
    "../infra/cloudflare/r2-lifecycle.json"
  );
  return JSON.parse(readFileSync(policyPath, "utf8")) as LifecyclePolicy;
}

describe("R2 lifecycle retention policy", () => {
  it("expires uploaded source images after the hard maximum retention window", () => {
    const policy = loadPolicy();
    const inboundSourceRule = policy.rules.find(
      rule => rule.conditions.prefix === "inbound-source/"
    );

    expect(inboundSourceRule).toEqual(
      expect.objectContaining({
        id: "expire-inbound-source-after-30-days",
        enabled: true,
      })
    );
    expect(
      inboundSourceRule?.deleteObjectsTransition?.condition
    ).toEqual({
      type: "Age",
      maxAge: THIRTY_DAYS_SECONDS,
    });
  });

  it("expires active generated image artifacts instead of retaining user outputs indefinitely", () => {
    const policy = loadPolicy();
    const generatedRule = policy.rules.find(
      rule => rule.conditions.prefix === "generated/images/"
    );

    expect(generatedRule).toEqual(
      expect.objectContaining({
        id: "expire-generated-images-after-30-days",
        enabled: true,
      })
    );
    expect(generatedRule?.deleteObjectsTransition?.condition).toEqual({
      type: "Age",
      maxAge: THIRTY_DAYS_SECONDS,
    });
  });

  it("does not apply a bucket-wide expiration rule", () => {
    const policy = loadPolicy();

    expect(policy.rules.map(rule => rule.conditions.prefix)).not.toContain("");
  });

  it("does not expire the whole generated namespace without a legacy inventory", () => {
    const policy = loadPolicy();

    expect(policy.rules.map(rule => rule.conditions.prefix)).not.toContain(
      "generated/"
    );
  });
});
