import {
  buildChannelConfigSchema,
  requireOpenAllowFrom,
} from "openclaw/plugin-sdk/channel-config-schema";
import { requireChannelOpenAllowFrom } from "openclaw/plugin-sdk/extension-shared";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { z } from "zod";
import type { ResolvedMessengerAccount } from "./types.js";

const DmPolicySchema = z.enum(["open", "allowlist", "pairing", "disabled"]);

const MessengerCommonConfigSchemaBase = z.object({
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
  responsePrefix: z.string().optional(),
  webhookPath: z.string().optional(),
  defaultTo: z.string().optional(),
  graphApiVersion: z.string().optional(),
});

const MessengerAccountConfigSchema = MessengerCommonConfigSchemaBase.strict().superRefine(
  (value, ctx) => {
    requireChannelOpenAllowFrom({
      channel: "facebook",
      policy: value.dmPolicy,
      allowFrom: value.allowFrom,
      ctx,
      requireOpenAllowFrom,
    });
  },
);

export const MessengerConfigSchema = MessengerCommonConfigSchemaBase.extend({
  accounts: z.record(z.string(), MessengerAccountConfigSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
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

export const MessengerChannelConfigSchema: NonNullable<
  ChannelPlugin<ResolvedMessengerAccount>["configSchema"]
> = buildChannelConfigSchema(MessengerConfigSchema);

export type MessengerConfigSchemaType = z.infer<typeof MessengerConfigSchema>;
