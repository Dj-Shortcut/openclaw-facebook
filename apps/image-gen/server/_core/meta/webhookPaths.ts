export type MetaWebhookVerificationMode = "generic" | "whatsapp";

export const metaWebhookRoutes = [
  { path: "/webhook", mode: "generic" },
  { path: "/webhook/facebook", mode: "generic" },
  { path: "/webhook/whatsapp", mode: "whatsapp" },
  { path: "/facebook/webhook", mode: "generic" },
  { path: "/messenger/webhook", mode: "generic" },
] as const satisfies ReadonlyArray<{
  path: string;
  mode: MetaWebhookVerificationMode;
}>;

export const metaWebhookPublicPaths = metaWebhookRoutes.map(route => route.path);
