import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  canonicalPrettyJson,
} from "./production-schema-contract.mjs";

describe("production schema contract serialization", () => {
  it("produces identical pretty JSON regardless of object insertion order", () => {
    const mysqlOrder = {
      tables: {
        workspaces: "workspace-hash",
        workspaceUsageDaily: "usage-hash",
      },
      states: [{ resumeFrom: 0, schema: { zeta: 2, alpha: 1 } }],
    };
    const alternateOrder = {
      states: [{ schema: { alpha: 1, zeta: 2 }, resumeFrom: 0 }],
      tables: {
        workspaceUsageDaily: "usage-hash",
        workspaces: "workspace-hash",
      },
    };

    expect(canonicalPrettyJson(mysqlOrder)).toBe(
      canonicalPrettyJson(alternateOrder)
    );
    expect(canonicalPrettyJson(mysqlOrder)).toBe(`{
  "states": [
    {
      "resumeFrom": 0,
      "schema": {
        "alpha": 1,
        "zeta": 2
      }
    }
  ],
  "tables": {
    "workspaceUsageDaily": "usage-hash",
    "workspaces": "workspace-hash"
  }
}`);
  });

  it("ignores field insertion order without ignoring array row order", () => {
    expect(canonicalJson([{ id: 1, hash: "one" }])).toBe(
      canonicalJson([{ hash: "one", id: 1 }])
    );
    expect(
      canonicalJson([
        { id: 1, hash: "one" },
        { id: 2, hash: "two" },
      ])
    ).not.toBe(
      canonicalJson([
        { id: 2, hash: "two" },
        { id: 1, hash: "one" },
      ])
    );
  });
});
