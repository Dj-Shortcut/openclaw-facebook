import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import { buildRemoteNodeCommand } from "./openclaw-login-command.mjs";

describe("buildRemoteNodeCommand", () => {
  it("runs multiline JavaScript without placing source or newlines in the shell command", () => {
    const source = `
const value = "operator-auth";
process.stdout.write(value);
`;

    const command = buildRemoteNodeCommand(source);

    expect(command).not.toContain("\n");
    expect(command).not.toContain("operator-auth");
    expect(execFileSync("sh", ["-c", command], { encoding: "utf8" })).toBe("operator-auth");
  });
});
