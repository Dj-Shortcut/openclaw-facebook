import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MessengerConfigSchema } from "./src/config-schema.js";

describe("openclaw plugin manifest", () => {
  it("publishes facebook as the only active channel", () => {
    const manifest = JSON.parse(readFileSync("openclaw.plugin.json", "utf8")) as {
      name?: unknown;
      description?: unknown;
      channels?: unknown;
      legacyPluginIds?: unknown;
      channelEnvVars?: Record<string, unknown>;
      channelConfigs?: Record<string, { schema?: unknown; preferOver?: unknown }>;
    };

    expect(manifest.name).toBe("Facebook");
    expect(manifest.description).toBe("Facebook Page Messenger direct messages via Meta webhooks.");
    expect(manifest.channels).toEqual(["facebook"]);
    expect(manifest.legacyPluginIds).toEqual(["messenger"]);
    expect(manifest.channelEnvVars).toBeUndefined();
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
        leaderbotBridgeEnabled?: { default?: unknown };
        defaultLang?: { default?: unknown; enum?: unknown };
        customerPortalUrl?: { default?: unknown; pattern?: unknown };
        sharedStateStore?: { default?: unknown; enum?: unknown };
        accounts?: {
          additionalProperties?: {
            properties?: {
              dmPolicy?: { default?: unknown };
              leaderbotBridgeEnabled?: { default?: unknown };
              defaultLang?: { default?: unknown; enum?: unknown };
              customerPortalUrl?: { default?: unknown; pattern?: unknown };
            };
          };
        };
      };
    };
    expect(facebookSchema.properties?.dmPolicy?.default).toBe("pairing");
    expect(
      facebookSchema.properties?.accounts?.additionalProperties?.properties?.dmPolicy?.default,
    ).toBe("pairing");
    expect(facebookSchema.properties?.leaderbotBridgeEnabled?.default).toBe(false);
    expect(facebookSchema.properties?.defaultLang).toMatchObject({
      default: "nl",
      enum: ["nl", "en"],
    });
    expect(facebookSchema.properties?.customerPortalUrl).toMatchObject({
      default: "https://leaderbot.live/",
      pattern: "^https://(?![^/]*@)",
    });
    expect(facebookSchema.properties?.sharedStateStore).toMatchObject({
      default: "memory",
      enum: ["memory", "redis"],
    });
    expect(
      facebookSchema.properties?.accounts?.additionalProperties?.properties
        ?.leaderbotBridgeEnabled?.default,
    ).toBeUndefined();
    expect(
      facebookSchema.properties?.accounts?.additionalProperties?.properties
        ?.defaultLang,
    ).toMatchObject({ enum: ["nl", "en"] });
    expect(
      facebookSchema.properties?.accounts?.additionalProperties?.properties
        ?.defaultLang?.default,
    ).toBeUndefined();
    expect(
      facebookSchema.properties?.accounts?.additionalProperties?.properties
        ?.customerPortalUrl?.default,
    ).toBeUndefined();
    expect(
      facebookSchema.properties?.accounts?.additionalProperties?.properties
        ?.customerPortalUrl?.pattern,
    ).toBe("^https://(?![^/]*@)");
    const portalPattern = new RegExp(
      String(facebookSchema.properties?.customerPortalUrl?.pattern),
    );
    expect(portalPattern.test("https://portal.example.test/account")).toBe(true);
    expect(portalPattern.test("https://user:secret@portal.example.test/")).toBe(false);
  });
});

describe("package openclaw metadata", () => {
  it("declares ClawHub install and compatibility metadata", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      name?: unknown;
      private?: unknown;
      engines?: unknown;
      openclaw?: {
        compat?: unknown;
        build?: unknown;
        extensions?: unknown;
        runtimeExtensions?: unknown;
        setupEntry?: unknown;
        runtimeSetupEntry?: unknown;
        install?: unknown;
        channel?: {
          exposure?: unknown;
          preferOver?: unknown;
        };
      };
    };

    expect(pkg.name).toBe("@dj-shortcut/facebook");
    expect(pkg.private).toBe(true);
    expect(pkg.engines).toEqual({
      node: ">=24.15.0",
    });
    expect(pkg.openclaw?.compat).toEqual({
      pluginApi: ">=2026.6.11",
      minGatewayVersion: "2026.6.11",
    });
    expect(pkg.openclaw?.build).toEqual({
      openclawVersion: "2026.7.2-beta.7",
      pluginSdkVersion: "2026.7.2-beta.7",
    });
    expect(pkg.openclaw?.install).toEqual({
      clawhubSpec: "clawhub:@dj-shortcut/facebook",
      defaultChoice: "clawhub",
      minHostVersion: ">=2026.6.11",
    });
    expect(pkg.openclaw?.extensions).toEqual(["./dist/index.js"]);
    expect(pkg.openclaw?.runtimeExtensions).toEqual(["./dist/index.js"]);
    expect(pkg.openclaw?.setupEntry).toBe("./dist/setup-entry.js");
    expect(pkg.openclaw?.runtimeSetupEntry).toBe("./dist/setup-entry.js");
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
    expect(parsed.leaderbotBridgeEnabled).toBe(false);
    expect(parsed.defaultLang).toBe("nl");
    expect(parsed.customerPortalUrl).toBe("https://leaderbot.live/");
    expect(parsed.sharedStateStore).toBe("memory");
    expect(parsed.allowFrom).toBeUndefined();
  });

  it("does not materialize a false Leaderbot bridge override for named accounts", () => {
    const parsed = MessengerConfigSchema.parse({
      leaderbotBridgeEnabled: true,
      accounts: {
        public: {
          dmPolicy: "pairing",
        },
      },
    });

    expect(parsed.leaderbotBridgeEnabled).toBe(true);
    expect(parsed.accounts?.public?.leaderbotBridgeEnabled).toBeUndefined();
    expect(parsed.accounts?.public?.defaultLang).toBeUndefined();
    expect(parsed.accounts?.public?.customerPortalUrl).toBeUndefined();
  });

  it("accepts English globally and as an explicit named-account override", () => {
    const parsed = MessengerConfigSchema.parse({
      defaultLang: "en",
      accounts: {
        dutch: { defaultLang: "nl" },
        inherited: {},
      },
    });

    expect(parsed.defaultLang).toBe("en");
    expect(parsed.accounts?.dutch?.defaultLang).toBe("nl");
    expect(parsed.accounts?.inherited?.defaultLang).toBeUndefined();
    expect(() => MessengerConfigSchema.parse({ defaultLang: "fr" })).toThrow();
  });

  it("accepts only safe HTTPS customer portal URLs", () => {
    expect(
      MessengerConfigSchema.parse({
        customerPortalUrl: "https://portal.example.test/account",
      }).customerPortalUrl,
    ).toBe("https://portal.example.test/account");
    expect(() =>
      MessengerConfigSchema.parse({
        customerPortalUrl: "http://portal.example.test/account",
      }),
    ).toThrow();
    expect(() =>
      MessengerConfigSchema.parse({
        customerPortalUrl: "https://user:secret@portal.example.test/account",
      }),
    ).toThrow();
  });

  it("supports Redis only as a root shared-state setting", () => {
    expect(MessengerConfigSchema.parse({ sharedStateStore: "redis" }).sharedStateStore)
      .toBe("redis");
    expect(() =>
      MessengerConfigSchema.parse({
        accounts: { invalid: { sharedStateStore: "redis" } },
      }),
    ).toThrow();
  });
});
