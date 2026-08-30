import { describe, expect, it } from "vitest";

import {
  changedPathsFromGit,
  classifyCiChanges,
} from "./classify-ci-changes.mjs";

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

  it("skips expensive suites for image-gen documentation-only changes", () => {
    expect(classifyCiChanges(["apps/image-gen/README.md"])).toEqual({
      imageGen: false,
      migration: false,
    });
  });

  it("fails safe for unclassified Markdown inside the runtime tree", () => {
    expect(classifyCiChanges(["apps/image-gen/runtime-prompt.md"])).toEqual({
      imageGen: true,
      migration: true,
    });
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

  it.each([
    "scripts/image-gen-credit-provisioner-bootstrap-contract.mjs",
    "scripts/image-gen-credit-provisioner-bootstrap-contract.test.mjs",
    "scripts/provision-image-gen-credit-provisioner.mjs",
    "scripts/provision-image-gen-credit-provisioner.test.mjs",
  ])("runs image-gen and migration checks for %s", (file) => {
    expect(classifyCiChanges([file])).toEqual({
      imageGen: true,
      migration: true,
    });
  });

  it("fails safe when the classifier itself changes", () => {
    expect(classifyCiChanges(["scripts/classify-ci-changes.mjs"])).toEqual({
      imageGen: true,
      migration: true,
    });
  });

  it("disables rename detection so removals keep their original source path", () => {
    const calls = [];
    const base = "a".repeat(40);
    const head = "b".repeat(40);
    const changedPaths = changedPathsFromGit({
      base,
      head,
      run(command, args, options) {
        calls.push({ command, args, options });
        return {
          status: 0,
          stderr: Buffer.alloc(0),
          stdout: Buffer.from(
            "apps/image-gen/server/removed.ts\0src/removed.ts\0",
          ),
        };
      },
    });

    expect(calls[0]).toMatchObject({
      command: "git",
      args: ["diff", "--no-renames", "--name-only", "-z", base, head],
    });
    expect(changedPaths).toEqual([
      "apps/image-gen/server/removed.ts",
      "src/removed.ts",
    ]);
    expect(classifyCiChanges(changedPaths)).toEqual({
      imageGen: true,
      migration: true,
    });
  });
});
