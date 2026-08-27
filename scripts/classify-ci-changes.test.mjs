import { describe, expect, it } from "vitest";

import { classifyCiChanges } from "./classify-ci-changes.mjs";

describe("CI change classification", () => {
  it("skips image and migration suites for OpenClaw-only changes", () => {
    expect(
      classifyCiChanges([
        "src/channel.ts",
        "openclaw.plugin.json",
        "docs/clawhub-listing.md",
      ]),
    ).toEqual({ imageGen: false, migration: false });
  });

  it("runs image checks but not database migration smoke for storage-only changes", () => {
    expect(
      classifyCiChanges([
        "apps/image-gen/storage-proxy/index.ts",
        "apps/image-gen/storage-proxy/deadline.test.ts",
      ]),
    ).toEqual({ imageGen: true, migration: false });
  });

  it("runs both suites for image-gen runtime changes", () => {
    expect(
      classifyCiChanges(["apps/image-gen/server/_core/messengerWebhook.ts"]),
    ).toEqual({ imageGen: true, migration: true });
  });

  it("fails safe when the classifier itself changes", () => {
    expect(classifyCiChanges(["scripts/classify-ci-changes.mjs"])).toEqual({
      imageGen: true,
      migration: true,
    });
  });
});
