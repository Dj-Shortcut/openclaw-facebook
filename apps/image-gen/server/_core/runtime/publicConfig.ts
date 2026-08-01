import type express from "express";

const PUBLIC_CONFIG_PATH = "/api/public/config";

type PublicOAuthConfig = {
  configured: boolean;
  portalUrl: string | null;
  appId: string | null;
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

export function getPublicRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env
): PublicRuntimeConfig {
  const portalUrl = readPublicOAuthPortalUrl(env);
  const appId = (env.VITE_APP_ID ?? "").trim() || null;
  const configured = Boolean(portalUrl && appId);

  return {
    oauth: {
      configured,
      portalUrl: configured ? portalUrl : null,
      appId: configured ? appId : null,
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
