import {
  buildChannelConfigSchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { requireChannelOpenAllowFrom } from "openclaw/plugin-sdk/extension-shared";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { z } from "zod";
import { DEFAULT_MESSENGER_CUSTOMER_PORTAL_URL } from "./messenger-i18n.js";
import type { ResolvedMessengerAccount } from "./types.js";

const DmPolicySchema = z.enum(["open", "allowlist", "pairing", "disabled"]);
const UnknownSenderModeSchema = z.enum(["pairing", "leaderbot_free_tier"]);
const MessengerLanguageSchema = z.enum(["nl", "en"]);
const MessengerSharedStateStoreSchema = z.enum(["memory", "redis"]);
const MessengerCustomerPortalUrlSchema = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  }, "Customer portal URL must use HTTPS without embedded credentials");

const MessengerCommonConfigShape = {
  enabled: z.boolean().optional(),
  pageId: z.string().optional(),
  pageAccessToken: z.string().optional(),
  tokenFile: z.string().optional(),
  appSecret: z.string().optional(),
  appSecretFile: z.string().optional(),
  verifyToken: z.string().optional(),
  verifyTokenFile: z.string().optional(),
  name: z.string().optional(),
  allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
  dmPolicy: DmPolicySchema.optional().default("pairing"),
  unknownSenderMode: UnknownSenderModeSchema.optional(),
  leaderbotBridgeEnabled: z.boolean().optional().default(false),
  defaultLang: MessengerLanguageSchema.optional(),
  customerPortalUrl: MessengerCustomerPortalUrlSchema.optional(),
  responsePrefix: z.string().optional(),
  webhookPath: z.string().optional(),
  defaultTo: z.string().optional(),
  graphApiVersion: z.string().optional(),
};

const MessengerCommonConfigSchemaBase = z.object({
  ...MessengerCommonConfigShape,
  defaultLang: MessengerLanguageSchema.optional().default("nl"),
  customerPortalUrl: MessengerCustomerPortalUrlSchema.optional().default(
    DEFAULT_MESSENGER_CUSTOMER_PORTAL_URL,
  ),
});

const MessengerAccountConfigSchema = z
  .object({
    ...MessengerCommonConfigShape,
    leaderbotBridgeEnabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    requireChannelOpenAllowFrom({
      channel: "facebook",
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      requireOpenAllowFrom,
    });
  });

export const MessengerConfigSchema = MessengerCommonConfigSchemaBase.extend({
  accounts: z.record(z.string(), MessengerAccountConfigSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
  sharedStateStore: MessengerSharedStateStoreSchema.optional().default("memory"),
})
  .strict()
  .superRefine((value, ctx) => {
    requireChannelOpenAllowFrom({
      channel: "facebook",
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      requireOpenAllowFrom,
    });
  });

// OpenClaw 2026.7.x bundles Zod's type graph in its published SDK declarations.
// The runtime schema still uses zod@4.4.3; bridge only the duplicate type identity.
const MessengerConfigSchemaForOpenClaw =
  MessengerConfigSchema as unknown as Parameters<
    typeof buildChannelConfigSchema
  >[0];

export const MessengerChannelConfigSchema: NonNullable<
  ChannelPlugin<ResolvedMessengerAccount>["configSchema"]
> = buildChannelConfigSchema(MessengerConfigSchemaForOpenClaw);

export type MessengerConfigSchemaType = z.infer<typeof MessengerConfigSchema>;
