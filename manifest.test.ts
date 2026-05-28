import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MessengerConfigSchema } from "./src/config-schema.js";

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
    const facebookSchema = manifest.channelConfigs?.facebook?.schema as {
      properties?: {
        dmPolicy?: { default?: unknown };
        accounts?: {
          additionalProperties?: {
            properties?: {
              dmPolicy?: { default?: unknown };
            };
          };
        };
      };
    };
    expect(facebookSchema.properties?.dmPolicy?.default).toBe("pairing");
    expect(
      facebookSchema.properties?.accounts?.additionalProperties?.properties?.dmPolicy?.default,
    ).toBe("pairing");
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

describe("package openclaw metadata", () => {
  it("declares ClawHub install and compatibility metadata", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      name?: unknown;
      private?: unknown;
      openclaw?: {
        compat?: unknown;
        build?: unknown;
        install?: unknown;
        channel?: {
          exposure?: unknown;
          preferOver?: unknown;
        };
      };
    };

    expect(pkg.name).toBe("@dj-shortcut/facebook");
    expect(pkg.private).toBe(true);
    expect(pkg.openclaw?.compat).toEqual({
      pluginApi: ">=2026.5.19",
      minGatewayVersion: "2026.5.19",
    });
    expect(pkg.openclaw?.build).toEqual({
      openclawVersion: "2026.5.27",
      pluginSdkVersion: "2026.5.27",
    });
    expect(pkg.openclaw?.install).toEqual({
      clawhubSpec: "clawhub:@dj-shortcut/facebook",
      defaultChoice: "clawhub",
      minHostVersion: ">=2026.5.19",
    });
    expect(pkg.openclaw?.channel?.preferOver).toEqual(["messenger"]);
    expect(pkg.openclaw?.channel?.exposure).toEqual({
      configured: true,
      setup: true,
      docs: true,
    });
  });
});

describe("facebook config safety defaults", () => {
  it("keeps direct messages in pairing mode unless explicitly opened", () => {
    const parsed = MessengerConfigSchema.parse({});

    expect(parsed.dmPolicy).toBe("pairing");
    expect(parsed.allowFrom).toBeUndefined();
  });
});
