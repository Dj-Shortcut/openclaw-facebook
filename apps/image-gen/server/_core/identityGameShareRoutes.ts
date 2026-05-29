import type { Express, Request, Response } from "express";

import { GAME_VARIANTS, type GameVariantDefinition } from "./identityGameVariants";
import { assertIdentityGameVariantCatalog } from "./identityGameVariantValidation";

const IDENTITY_GAME_CANONICAL_DOMAIN = "leaderbot.live";
const DEFAULT_SHARE_TITLE = "Discover your AI archetype";
const DEFAULT_SHARE_DESCRIPTION =
  "Answer 3 quick questions and reveal your AI identity.";
const DEFAULT_SHARE_IMAGE_URL =
  "https://leaderbot.live/og/identity-games-default.jpg";

function normalizeVariantId(value: string): string {
  return value.trim().toLowerCase();
}

function getVariantById(
  variantId: string,
  variants: readonly GameVariantDefinition[] = GAME_VARIANTS
): GameVariantDefinition | null {
  const normalized = normalizeVariantId(variantId);
  return (
    variants.find(variant => normalizeVariantId(variant.variantId) === normalized) ??
    null
  );
}

export function buildMessengerEntryUrl(pageId: string, variantId: string): string {
  const normalizedVariantId = normalizeVariantId(variantId);
  const refValue = normalizedVariantId.startsWith("identity-")
    ? normalizedVariantId
    : `game:${normalizedVariantId}`;
  const ref = encodeURIComponent(refValue);
  return `https://m.me/${encodeURIComponent(pageId)}?ref=${ref}`;
}

export function resolveShareMeta(variant: GameVariantDefinition): {
  title: string;
  description: string;
  imageUrl: string;
} {
  return {
    title: variant.share?.title ?? DEFAULT_SHARE_TITLE,
    description: variant.share?.description ?? DEFAULT_SHARE_DESCRIPTION,
    imageUrl: variant.share?.imageUrl ?? DEFAULT_SHARE_IMAGE_URL,
  };
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;");
}

function toSafeInlineScriptString(value: string): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function renderSharePageHtml(input: {
  canonicalUrl: string;
  messengerUrl: string;
  title: string;
  description: string;
  imageUrl: string;
}): string {
  const safeCanonicalUrl = escapeHtml(input.canonicalUrl);
  const safeMessengerUrl = escapeHtml(input.messengerUrl);
  const safeTitle = escapeHtml(input.title);
  const safeDescription = escapeHtml(input.description);
  const safeImageUrl = escapeHtml(input.imageUrl);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${safeTitle}</title>
    <link rel="canonical" href="${safeCanonicalUrl}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${safeCanonicalUrl}" />
    <meta property="og:title" content="${safeTitle}" />
    <meta property="og:description" content="${safeDescription}" />
    <meta property="og:image" content="${safeImageUrl}" />
    <meta http-equiv="refresh" content="0;url=${safeMessengerUrl}" />
    <script>window.location.replace(${toSafeInlineScriptString(input.messengerUrl)});</script>
  </head>
  <body>
    <p>Redirecting to Messenger...</p>
    <p><a href="${safeMessengerUrl}">Continue</a></p>
  </body>
</html>`;
}

function getRequestHost(req: Request): string {
  return req.hostname.trim().toLowerCase();
}

function isProductionEnv(inputNodeEnv?: string): boolean {
  return (inputNodeEnv ?? process.env.NODE_ENV) === "production";
}

function resolvePageId(overridePageId?: string): string {
  const pageId = (overridePageId ?? process.env.MESSENGER_PAGE_ID ?? "").trim();
  if (!pageId) {
    throw new Error("MESSENGER_PAGE_ID is required for identity game share routes");
  }
  if (!/^\d+$/.test(pageId)) {
    throw new Error("MESSENGER_PAGE_ID must be a numeric Facebook page id");
  }
  return pageId;
}

type RegisterShareRoutesOptions = {
  variants?: readonly GameVariantDefinition[];
  canonicalDomain?: string;
  pageId?: string;
  nodeEnv?: string;
};

export function registerIdentityGameShareRoutes(
  app: Express,
  options: RegisterShareRoutesOptions = {}
): void {
  const variants = options.variants ?? GAME_VARIANTS;
  const canonicalDomain =
    (options.canonicalDomain ?? IDENTITY_GAME_CANONICAL_DOMAIN).toLowerCase();
  const pageId = resolvePageId(options.pageId);
  assertIdentityGameVariantCatalog(variants);

  app.get("/play/:variantId", (req: Request, res: Response) => {
    const variantId = normalizeVariantId(req.params.variantId ?? "");
    const variant = getVariantById(variantId, variants);
    if (!variant) {
      res.status(404).type("text/plain").send("Variant not found");
      return;
    }

    const canonicalVariantId = normalizeVariantId(variant.variantId);
    const canonicalUrl = `https://${canonicalDomain}/play/${canonicalVariantId}`;
    const currentHost = getRequestHost(req);
    if (
      isProductionEnv(options.nodeEnv) &&
      variant.status === "active" &&
      currentHost !== canonicalDomain
    ) {
      // Keep canonical-host redirects temporary because variant status/domain policy can evolve.
      res.redirect(307, canonicalUrl);
      return;
    }

    const messengerUrl = buildMessengerEntryUrl(pageId, canonicalVariantId);
    const shareMeta = resolveShareMeta(variant);

    res
      .status(200)
      .setHeader(
        "Cache-Control",
        variant.status === "active" ? "public, max-age=300" : "no-store"
      )
      .type("text/html; charset=utf-8")
      .send(
        renderSharePageHtml({
          canonicalUrl,
          messengerUrl,
          title: shareMeta.title,
          description: shareMeta.description,
          imageUrl: shareMeta.imageUrl,
        })
      );
  });
}
