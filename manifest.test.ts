import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("openclaw plugin manifest", () => {
  it("publishes facebook as the only active channel", () => {
    const manifest = JSON.parse(readFileSync("openclaw.plugin.json", "utf8")) as {
      channels?: unknown;
      legacyPluginIds?: unknown;
      channelEnvVars?: Record<string, unknown>;
      channelConfigs?: Record<string, { schema?: unknown; preferOver?: unknown }>;
    };

    expect(manifest.channels).toEqual(["facebook"]);
    expect(manifest.legacyPluginIds).toEqual(["messenger"]);
    expect(Object.keys(manifest.channelEnvVars ?? {})).toEqual(["facebook"]);
    expect(Object.keys(manifest.channelConfigs ?? {})).toEqual(["facebook"]);
    expect(manifest.channelConfigs?.facebook?.preferOver).toEqual(["messenger"]);
    expect(manifest.channelConfigs?.facebook?.schema).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        pageId: { type: "string" },
        pageAccessToken: { type: "string" },
        appSecret: { type: "string" },
        verifyToken: { type: "string" },
        accounts: { type: "object" },
      },
    });
    expect(manifest.channelEnvVars?.facebook).toEqual(
      expect.arrayContaining([
        "FACEBOOK_PAGE_ID",
        "FACEBOOK_PAGE_ACCESS_TOKEN",
        "FACEBOOK_APP_SECRET",
        "FACEBOOK_VERIFY_TOKEN",
        "MESSENGER_PAGE_ID",
        "MESSENGER_PAGE_ACCESS_TOKEN",
        "MESSENGER_APP_SECRET",
        "MESSENGER_VERIFY_TOKEN",
      ]),
    );
  });
});
