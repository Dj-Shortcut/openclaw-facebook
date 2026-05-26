import "dotenv/config";
import { initSentry } from "./observability/sentry";

initSentry();

import express from "express";
import path from "path";
import { createServer } from "http";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { assertAuthConfig, registerOAuthRoutes } from "./auth";
import { assertWhatsAppConfig } from "./env";
import {
  captureBotWebhookRawBody,
  getBotStartupConfig,
  registerBotRoutes,
  verifyBotWebhookSignature,
} from "./bot";
import { assertProductionImageStorageConfig } from "./image-generation/imageServiceConfig";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic } from "./vite";
import { assertPrivacyConfig } from "./privacy";
import { applySecurityHeaders } from "./securityHeaders";
import { getGeneratedImage } from "./generatedImageStore";
import { isDebugLogEnabled } from "./logLevel";
import {
  assertProductionStateStoreConfig,
  ensureStateStoreReady,
} from "./stateStore";
import {
  assertProductionWebhookReplayProtectionConfig,
  ensureWebhookReplayProtectionReady,
  isRedisReplayProtectionEnabled,
} from "./webhookReplayProtection";
import {
  ensureWebhookIngressQueueReady,
  scheduleWebhookIngressDrain,
} from "./meta/webhookIngressQueue";
import { bodyParserErrorHandler } from "./bodyParserErrorHandler";
import { z } from "zod";
import {
  createGlobalHttpRateLimiter,
  ensureHttpRateLimiterReady,
  isRedisHttpRateLimitEnabled,
} from "./httpRateLimit";
import {
  attachRequestTracing,
  getRequestId,
  getTraceContext,
  recordHttpRequestMetric,
  registerMetricsRoute,
} from "./observability";
import {
  assertIdentityGameVariantCatalog,
  registerIdentityGameShareRoutes,
} from "./identityGameVariants";
import {
  registerFaceMemoryAdminRoutes,
  scheduleFaceMemoryExpiry,
} from "./faceMemory";
import { createAdminAuthRateLimiter, verifyAdminToken } from "./adminAuth";
import { registerInternalImageRequestRoutes } from "./internalImageRequestRoutes";

const gitSha = process.env.GIT_SHA ?? process.env.SOURCE_VERSION ?? "dev";
const bootTimestamp = new Date().toISOString();
const REQUEST_BODY_LIMIT = "10mb";
const SHUTDOWN_GRACE_PERIOD_MS = 5_000;
const DEFAULT_PUBLIC_BASE_URL = "https://leaderbot.live";
type InviteOgImage = {
  path: string;
  width: string;
  height: string;
  alt: string;
};

type InvitePageConfig = {
  path: string;
  title: string;
  description: string;
  messengerUrl: string;
  ogImages: readonly InviteOgImage[];
};

const INVITE_PAGE_CONFIGS: readonly InvitePageConfig[] = [
  {
    path: "/invite/identity-ai-v1",
    title: "Welke AI ben jij?",
    description: "Ontdek het in 30 seconden 🤖",
    messengerUrl: "https://m.me/61587343141159?ref=identity-ai-v1",
    ogImages: [
      {
        path: "/og/identity-ai-v1-invite-v2.png",
        width: "1536",
        height: "1024",
        alt: "Welke AI ben jij? Ontdek het in 30 seconden.",
      },
      {
        path: "/og/identity-ai-v1-invite-v1.png",
        width: "1024",
        height: "1536",
        alt: "Welke AI ben jij? Ontdek het in 30 seconden.",
      },
    ],
  },
  {
    path: "/invite/dj-v1",
    title: "Welke DJ ben jij?",
    description: "Jouw stijl verraadt meer dan je denkt 🎧",
    messengerUrl: "https://m.me/61587343141159?ref=game:dj-v1",
    ogImages: [
      {
        path: "/og/dj-v1-1200x630.png",
        width: "1200",
        height: "630",
        alt: "Leaderbot DJ game preview",
      },
    ],
  },
] as const;

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function getPublicBaseUrl(_req: express.Request): string {
  const configuredBaseUrl = process.env.APP_BASE_URL;
  if (configuredBaseUrl) {
    return normalizeBaseUrl(configuredBaseUrl);
  }
  return DEFAULT_PUBLIC_BASE_URL;
}

function getFacebookAppId(): string {
  return (process.env.FB_APP_ID ?? process.env.VITE_APP_ID ?? "").trim();
}

function assertInviteShareConfig(): void {
  if (process.env.NODE_ENV !== "production") {
    return;
  }

  const fbAppId = getFacebookAppId();
  if (!fbAppId) {
    throw new Error(
      "FB_APP_ID (or VITE_APP_ID) must be configured in production for invite Open Graph metadata."
    );
  }
}

function renderInvitePageHtml(input: {
  baseUrl: string;
  invitePath: string;
  title: string;
  description: string;
  messengerUrl: string;
  ogImages: readonly InviteOgImage[];
  fbAppId: string;
}): string {
  const inviteUrl = `${input.baseUrl}${input.invitePath}`;
  const ogImageMeta = input.ogImages
    .map((image) => {
      const imageUrl = `${input.baseUrl}${image.path}`;
      const lines = [
        `<meta property="og:image" content="${imageUrl}" />`,
        `<meta property="og:image:url" content="${imageUrl}" />`,
        `<meta property="og:image:secure_url" content="${imageUrl}" />`,
        `<meta property="og:image:alt" content="${image.alt}" />`,
      ];

      if (image.width) {
        lines.push(`<meta property="og:image:width" content="${image.width}" />`);
      }
      if (image.height) {
        lines.push(`<meta property="og:image:height" content="${image.height}" />`);
      }

      return lines.join("\n    ");
    })
    .join("\n    ");

  return `
<!doctype html>
<html lang="nl">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${input.title}</title>
    <meta property="og:title" content="${input.title}" />
    <meta property="og:description" content="${input.description}" />
    ${ogImageMeta}
    <meta property="og:url" content="${inviteUrl}" />
    <meta property="og:type" content="website" />
    ${input.fbAppId ? `<meta property="fb:app_id" content="${input.fbAppId}" />` : ""}
    <style>
      :root { color-scheme: light; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        font-family: Arial, sans-serif;
        background: linear-gradient(180deg, #f7fafc 0%, #edf2f7 100%);
        color: #111827;
      }
      main {
        text-align: center;
        padding: 24px;
      }
      a.cta {
        display: inline-block;
        text-decoration: none;
        font-weight: 700;
        background: #1877f2;
        color: #fff;
        padding: 12px 20px;
        border-radius: 10px;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>${input.title}</h1>
      <p>${input.description}</p>
      <a class="cta" href="${input.messengerUrl}">Start in Messenger</a>
    </main>
  </body>
</html>`;
}

function toError(reason: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }

  return new Error(typeof reason === "string" ? reason : "Unknown error");
}

function setupGlobalErrorHandlers(server: ReturnType<typeof createServer>) {
  let shuttingDown = false;

  const shutdown = (reason: unknown) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    const reasonError = toError(reason);

    console.error("[fatal] shutting down server", {
      name: reasonError.name,
      message: reasonError.message,
      stack: reasonError.stack,
    });

    const forcedShutdownTimer = setTimeout(() => {
      console.error("[fatal] forced shutdown after grace period elapsed");
      process.exit(1);
    }, SHUTDOWN_GRACE_PERIOD_MS);
    forcedShutdownTimer.unref();

    server.close((closeError) => {
      if (closeError) {
        console.error("[fatal] failed to close server cleanly", closeError);
      }
      process.exit(1);
    });
  };

  process.on("unhandledRejection", (reason) => {
    shutdown(toError(reason));
  });
  process.on("uncaughtException", (error) => {
    shutdown(error);
  });

  process.on("SIGTERM", () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    server.close((closeError) => {
      if (closeError) {
        console.error("[shutdown] SIGTERM close failed", closeError);
        process.exit(1);
      }
      process.exit(0);
    });
  });
}

const debugBuildHeadersSchema = z.object({
  "x-admin-token": z.string().min(1).optional(),
});

function buildVersionPayload() {
  return {
    gitSha,
    timestamp: bootTimestamp,
  };
}

async function startServer() {
  console.log("BOOT", { pid: process.pid });
  console.log("VERSION", buildVersionPayload());
  const generatorStartupConfig = getBotStartupConfig();
  console.log("GENERATOR_STARTUP_CONFIG", generatorStartupConfig);
  assertProductionImageStorageConfig();
  assertAuthConfig();
  assertWhatsAppConfig();
  assertPrivacyConfig();
  assertInviteShareConfig();
  assertProductionStateStoreConfig();
  assertProductionWebhookReplayProtectionConfig();
  assertIdentityGameVariantCatalog();
  await ensureStateStoreReady();
  await ensureWebhookReplayProtectionReady();
  await ensureWebhookIngressQueueReady();
  await ensureHttpRateLimiterReady();

  const app = express();
  app.set("trust proxy", 1);
  const server = createServer(app);
  setupGlobalErrorHandlers(server);

  applySecurityHeaders(app);
  app.use(attachRequestTracing());
  app.use(createGlobalHttpRateLimiter());

  if (process.env.NODE_ENV !== "production") {
    app.get("/debug/sentry", () => {
      throw new Error("Sentry smoke test");
    });
  }

  app.use(
    express.json({
      limit: REQUEST_BODY_LIMIT,
      verify: captureBotWebhookRawBody,
    })
  );
  app.use(express.urlencoded({ limit: REQUEST_BODY_LIMIT, extended: true }));

  app.use("/webhook", (req, _res, next) => {
    if (req.method === "POST") {
      console.info("[meta webhook] inbound post hit", {
        path: req.path,
        contentType: req.headers["content-type"],
        hasSignatureHeader: typeof req.headers["x-hub-signature-256"] === "string",
      });
    }
    next();
  });

  // Verify webhook signature for all Meta webhook deliveries.
  app.use("/webhook", verifyBotWebhookSignature);

  // Register webhook routes AFTER signature verification middleware
  // but BEFORE static files and catch-all routes.
  registerBotRoutes(app);
  registerInternalImageRequestRoutes(app);
  scheduleWebhookIngressDrain();

  app.use((req, res, next) => {
    const startTime = process.hrtime.bigint();

    res.on("finish", () => {
      const durationMs =
        Number(process.hrtime.bigint() - startTime) / 1_000_000;
      const log = {
        reqId: getRequestId(req),
        traceId: getTraceContext(req)?.traceId,
        spanId: getTraceContext(req)?.spanId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Number(durationMs.toFixed(1)),
      };
      recordHttpRequestMetric(req.method, req.path, res.statusCode, durationMs);

      // Keep info logs compact: skip webhook and health checks unless debug logging is enabled.
      const shouldLogAtInfo =
        !req.path.startsWith("/webhook") &&
        req.path !== "/healthz" &&
        req.path !== "/health" &&
        req.path !== "/metrics";
      if (isDebugLogEnabled() || shouldLogAtInfo) {
        console.log(JSON.stringify(log));
      }
    });

    next();
  });

  // Support both /health and /healthz for compatibility with Fly.io and other platforms
  const healthHandler = (_req: express.Request, res: express.Response) => {
    res.status(200).send("ok");
  };
  app.get("/health", healthHandler);
  app.get("/healthz", healthHandler);

  app.get("/__version", (_req, res) => {
    res.status(200).json(buildVersionPayload());
  });
  registerMetricsRoute(app);
  registerFaceMemoryAdminRoutes(app);

  app.get(
    "/debug/build",
    createAdminAuthRateLimiter({ eventName: "debug_build_auth_rate_limited" }),
    (req, res) => {
    const parsedHeaders = debugBuildHeadersSchema.safeParse(req.headers);
    const providedToken = parsedHeaders.success
      ? parsedHeaders.data["x-admin-token"]
      : undefined;

    if (
      !verifyAdminToken({
        providedToken,
        eventName: "debug_build_auth_failed",
      })
    ) {
      return res.sendStatus(403);
    }

      return res.status(200).json({
      name: "leaderbot-images",
      version: gitSha,
      uptime_s: Math.floor(process.uptime()),
      node: process.version,
      envFlags: {
        hasFbVerifyToken: Boolean(process.env.FB_VERIFY_TOKEN),
        hasFbPageAccessToken: Boolean(process.env.FB_PAGE_ACCESS_TOKEN),
        hasFbAppSecret: Boolean(process.env.FB_APP_SECRET),
        hasAdminToken: Boolean(process.env.ADMIN_TOKEN),
        hasAppBaseUrl: Boolean(process.env.APP_BASE_URL),
      },
      securityStatus: {
        webhookSignatureVerificationEnabled: Boolean(process.env.FB_APP_SECRET),
        verifyTokenConfigured: Boolean(process.env.FB_VERIFY_TOKEN),
        webhookReplayProtectionEnabled: true,
        webhookReplayProtectionRedisBacked: isRedisReplayProtectionEnabled(),
        globalHttpRateLimiterEnabled: true,
        globalHttpRateLimiterRedisBacked: isRedisHttpRateLimitEnabled(),
        metricsEndpointEnabled: true,
        requestTracingEnabled: true,
        traceparentPropagationEnabled: true,
      },
      });
    }
  );

  app.get("/privacy", (_req, res) => {
    res.type("html").send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Privacy Policy – Leaderbot</title>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        :root { color-scheme: dark; }
        body {
          font-family: Arial, sans-serif;
          max-width: 700px;
          margin: 40px auto;
          line-height: 1.6;
          padding: 24px;
          color: #e5e7eb;
          background: #0b1220;
        }
        h1, h2 { color: #f9fafb; }
        ul { padding-left: 20px; }
        a { color: #93c5fd; }
      </style>
    </head>
    <body>
      <h1>Privacy Policy – Leaderbot</h1>
      <p><strong>Last updated:</strong> 21 April 2026</p>
      <p>Leaderbot ("we", "our") is a Messenger-based service that transforms user-submitted images using AI styles.</p>

      <h2>What data we collect</h2>
      <p>When you interact with Leaderbot through Facebook Messenger, we may receive:</p>
      <ul>
        <li>Messages you send to the Page</li>
        <li>Images you submit for transformation</li>
        <li>Basic messaging metadata necessary to deliver the service (e.g., sender ID, timestamps)</li>
      </ul>
      <p>We do not request your password or access your private Facebook profile data beyond what Messenger delivers for this integration.</p>

      <h2>How we use data</h2>
      <p>We use your data only to:</p>
      <ul>
        <li>Receive your request</li>
        <li>Process and transform your submitted image</li>
        <li>Send the transformed image back to you in Messenger</li>
        <li>Maintain service reliability, prevent abuse, and troubleshoot issues</li>
      </ul>

      <h2>Image handling and retention</h2>
      <p>Images are processed for the purpose of generating the requested transformation.</p>
      <p><strong>Optional photo memory:</strong> If you give explicit permission, we keep your uploaded photo for a maximum of 30 days so you do not have to upload it again each time. This is optional. You can withdraw consent at any time by sending "delete my data" in Messenger. Dutch-speaking users may send "verwijder mijn data". After 30 days or withdrawal, the retained photo is permanently deleted. We use it only to generate new images for you.</p>
      <p>We do not sell your images.</p>
      <p>We do not use your images to market to you.</p>
      <p>We do not share your images with third parties except as required to provide the service (e.g., image processing providers).</p>
      <p>Images and generated outputs are retained only as long as needed to deliver the result and ensure basic operational stability, then deleted or anonymized.</p>

      <h2>Sharing and third parties</h2>
      <p>We may use third-party infrastructure providers (hosting, logging, and image processing) solely to operate the service. We do not share personal data for advertising purposes.</p>

      <h2>Security</h2>
      <p>We take reasonable measures to protect data in transit and at rest. No system is 100% secure, but we aim to minimize data exposure and access.</p>

      <h2>Your choices</h2>
      <p>You can stop using the service at any time by not messaging the Page.</p>

      <h2>Data deletion requests</h2>
      <p>If you want us to delete data associated with your interactions, contact us at: privacy@leaderbot.live</p>
      <p>Include your Facebook profile name and the approximate time you messaged the Page so we can locate your conversation context.</p>

      <h2>Contact</h2>
      <p>Email: privacy@leaderbot.live</p>
    </body>
    </html>
  `);
  });

  app.get("/data-deletion", (_req, res) => {
    res.type("html").send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>User Data Deletion Instructions – Leaderbot</title>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        :root { color-scheme: dark; }
        body {
          font-family: Arial, sans-serif;
          max-width: 700px;
          margin: 40px auto;
          line-height: 1.6;
          padding: 24px;
          color: #e5e7eb;
          background: #0b1220;
        }
        h1, h2 { color: #f9fafb; }
        ul { padding-left: 20px; }
        a { color: #93c5fd; }
      </style>
    </head>
    <body>
      <h1>User Data Deletion Instructions – Leaderbot</h1>
      <p>If you want your data removed from Leaderbot, you can request deletion at any time.</p>

      <h2>Data that can be deleted</h2>
      <ul>
        <li>Conversation identifiers and message logs associated with your interaction history</li>
        <li>Retained images and generated outputs, if any are still stored</li>
      </ul>

      <h2>How to request deletion</h2>
      <p>Email your request to: <strong>privacy@leaderbot.live</strong></p>
      <p>To help us identify your records accurately, include:</p>
      <ul>
        <li>Your Facebook profile name</li>
        <li>The approximate time you messaged the Page</li>
      </ul>

      <h2>Processing timeframe</h2>
      <p>After we verify your request details, deletion is completed within a reasonable timeframe.</p>
    </body>
    </html>
  `);
  });

  for (const inviteConfig of INVITE_PAGE_CONFIGS) {
    app.get(inviteConfig.path, (req, res) => {
      const baseUrl = getPublicBaseUrl(req);
      const fbAppId = getFacebookAppId();

      res
        .status(200)
        .type("text/html; charset=utf-8")
        .send(
          renderInvitePageHtml({
            baseUrl,
            invitePath: inviteConfig.path,
            title: inviteConfig.title,
            description: inviteConfig.description,
            messengerUrl: inviteConfig.messengerUrl,
            ogImages: inviteConfig.ogImages,
            fbAppId,
          })
        );
    });
  }

  scheduleFaceMemoryExpiry();

  const oauthServerUrl = process.env.OAUTH_SERVER_URL;
  if (oauthServerUrl) {
    registerOAuthRoutes(app);
  } else {
    console.info(
      "[OAuth] OAUTH_SERVER_URL not set, skipping OAuth route initialization"
    );
  }
  registerIdentityGameShareRoutes(app);
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  app.use(bodyParserErrorHandler);

  const publicDir = path.join(process.cwd(), "public");
  app.get("/generated/:token.jpg", (req, res) => {
    const generatedImage = getGeneratedImage(req.params.token);
    if (!generatedImage) {
      console.warn("GENERATED_IMAGE_FETCH_MISS", {
        reqId: getRequestId(req),
        token: req.params.token,
        path: req.path,
        nodeEnv: process.env.NODE_ENV ?? "unknown",
      });
      res.status(404).send("Not found");
      return;
    }

    res.setHeader("Content-Type", generatedImage.contentType);
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.status(200).send(generatedImage.buffer);
  });
  app.use(express.static(publicDir));

  if (process.env.NODE_ENV !== "production") {
    const [{ setupVite }, { createServer }] = await Promise.all([
      import("./vite"),
      import("vite"),
    ]);
    await setupVite(app, server, createServer);
  } else {
    serveStatic(app);
  }

  const PORT = Number(process.env.PORT || 8080);
  const HOST = "0.0.0.0";

  server.listen(PORT, HOST, () => {
    console.log(`Server listening on port ${PORT} (${HOST})`);
  });
}

startServer().catch((error) => {
  console.error("[startup] failed to start server", error);
  process.exit(1);
});
