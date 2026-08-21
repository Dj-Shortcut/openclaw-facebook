import type express from "express";

const PUBLIC_CONFIG_PATH = "/api/public/config";

type PublicOAuthConfig = {
  configured: boolean;
  portalUrl: string | null;
  appId: string | null;
  loginUrl: string | null;
};

export type PublicRuntimeConfig = {
  oauth: PublicOAuthConfig;
};

function readPublicOAuthPortalUrl(env: NodeJS.ProcessEnv): string | null {
  for (const candidate of [env.OAUTH_PORTAL_URL, env.OAUTH_SERVER_URL]) {
    const raw = (candidate ?? "").trim();
    if (!raw) continue;

    try {
      const url = new URL(raw);
      const localHttp =
        url.protocol === "http:" &&
        (url.hostname === "localhost" || url.hostname === "127.0.0.1");
      if (url.protocol !== "https:" && !localHttp) continue;
      if (url.username || url.password) continue;

      url.search = "";
      url.hash = "";
      return url.toString().replace(/\/$/, "");
    } catch {
      continue;
    }
  }

  return null;
}

function isDirectFacebookOAuthConfigured(env: NodeJS.ProcessEnv): boolean {
  if (!env.FB_APP_ID?.trim() || !env.FB_APP_SECRET?.trim()) return false;
  try {
    const url = new URL(env.APP_BASE_URL?.trim() ?? "");
    const localHttp =
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1");
    return (
      (url.protocol === "https:" || localHttp) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function getPublicRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): PublicRuntimeConfig {
  const directFacebookConfigured = isDirectFacebookOAuthConfigured(env);
  const portalUrl = readPublicOAuthPortalUrl(env);
  const appId = (env.VITE_APP_ID ?? "").trim() || null;
  const externalOAuthConfigured = Boolean(portalUrl && appId);
  const configured = directFacebookConfigured || externalOAuthConfigured;

  return {
    oauth: {
      configured,
      portalUrl: externalOAuthConfigured ? portalUrl : null,
      appId: externalOAuthConfigured ? appId : null,
      loginUrl: directFacebookConfigured ? "/api/oauth/facebook/start" : null,
    },
  };
}

export function registerPublicConfigRoute(
  app: express.Express,
  readConfig: () => PublicRuntimeConfig = getPublicRuntimeConfig
) {
  app.get(PUBLIC_CONFIG_PATH, (_req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(readConfig());
  });
}
