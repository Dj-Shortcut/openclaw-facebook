import "dotenv/config";
import { initSentry } from "./observability/sentry";

initSentry();

import express from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import path from "path";
import { createServer } from "http";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { assertAuthConfig, registerOAuthRoutes } from "./auth";
import { assertWhatsAppConfig } from "./env";
import { captureBotWebhookRawBody, getBotStartupConfig } from "./bot";
import { assertProductionImageStorageConfig } from "./image-generation/imageServiceConfig";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic } from "./vite";
import { assertPrivacyConfig } from "./privacy";
import { assertConversationIdentityConfig } from "./conversationIdentityConfig";
import { applySecurityHeaders } from "./securityHeaders";
import {
  getGeneratedImage,
  hashGeneratedImageToken,
} from "./generatedImageStore";
import {
  assertProductionStateStoreConfig,
  ensureStateStoreReady,
} from "./stateStore";
import {
  assertProductionWebhookReplayProtectionConfig,
  ensureWebhookReplayProtectionReady,
} from "./webhookReplayProtection";
import { ensureWebhookIngressQueueReady } from "./meta/webhookIngressQueue";
import { bodyParserErrorHandler } from "./bodyParserErrorHandler";
import {
  createGlobalHttpRateLimiter,
  ensureHttpRateLimiterReady,
  getHttpRateLimitGuardMaxRequests,
  getHttpRateLimitWindowMs,
  isRedisHttpRateLimitEnabled,
  shouldSkipHttpRateLimit,
} from "./httpRateLimit";
import {
  attachRequestTracing,
  createRequestMetricsMiddleware,
  getRequestId,
  registerMetricsRoute,
} from "./observability";
import {
  registerFaceMemoryAdminRoutes,
  scheduleFaceMemoryExpiry,
} from "./faceMemory";
import { registerPortalRoutes } from "./portalRoutes";
import {
  assertMessengerGenerationQueueConfig,
  ensureMessengerGenerationQueueReady,
  isMessengerGenerationWorkerMode,
  isMessengerGenerationWorkerOnlyMode,
} from "./messengerGenerationQueue";
import { ensureMessengerGenerationCompletionReady } from "./messengerGenerationCompletion";
import {
  assertMollieBillingEnabled,
  assertMollieNonSecretLaunchConfig,
  assertTenantBillingWorkerConfigured,
  getMollieConfig,
  getConfiguredBillingMode,
  isMollieBillingEnabled,
  isMollieBillingPreflightEnabled,
  isMollieEntitlementEnforcementEnabled,
} from "./billing/config";
import {
  assertBillingNotificationConfig,
  isBillingNotificationPlaneEnabled,
} from "./billing/billingNotificationDelivery";
import { registerBillingNotificationReceiverRoute } from "./billing/billingNotificationReceiver";
import {
  assertAiAnswerFinalizationReadiness,
  assertBillingDatabaseReadiness,
  assertMollieAccountingSchemaReadiness,
} from "./billing/billingReadiness";
import { startMessengerGenerationWorker } from "./messengerGenerationWorker";
import { reconcileMessengerProfileOnStartup } from "./messengerProfile";
import { safeLog } from "./logger";
import {
  buildVersionPayload,
  registerDebugRoutes,
  registerSentryDebugRoute,
  registerVersionRoute,
} from "./runtime/debugRoutes";
import { registerHealthRoutes } from "./runtime/healthRoutes";
import { registerLegalRoutes } from "./runtime/legalRoutes";
import { registerPublicConfigRoute } from "./runtime/publicConfig";
import { registerWebhookRuntime } from "./runtime/webhookRuntime";
import { registerMollieWebhookRoute } from "./billing/webhookRoutes";
import { registerBillingPortalRoutes } from "./billing/portalRoutes";
import { startBillingOutboxWorker } from "./billing/outboxWorker";
import { startDailyBillingReconciliation } from "./billing/reconciliation";
import { startAiAnswerFinalizationWorker } from "./billing/aiAnswerFinalizationWorker";
import { startBillingProfileExpiryWorker } from "./billing/billingProfileExpiryWorker";
import { startBillingNotificationReceiverWorker } from "./billing/billingNotificationReceiverWorker";
import {
  getMollieAccountingImportConfig,
  isMollieAccountingImportEnabled,
  startMollieAccountingImportWorker,
} from "./billing/accountingWorker";

const gitSha = process.env.GIT_SHA ?? process.env.SOURCE_VERSION ?? "dev";
const bootTimestamp = new Date().toISOString();
const REQUEST_BODY_LIMIT = "10mb";
const SHUTDOWN_GRACE_PERIOD_MS = 5_000;

function getHttpRateLimiterGuardKey(req: express.Request): string {
  const clientIp = req.ip || req.socket.remoteAddress;
  return `${req.method}:${clientIp ? ipKeyGenerator(clientIp) : "unknown"}`;
}

const redisBackedHttpRateLimiterGuard = rateLimit({
  windowMs: getHttpRateLimitWindowMs(),
  max: getHttpRateLimitGuardMaxRequests,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: getHttpRateLimiterGuardKey,
  skip: req => shouldSkipHttpRateLimit(req) || !isRedisHttpRateLimitEnabled(),
  message: {
    error: "Too Many Requests",
    message: "Global HTTP rate limit exceeded. Please retry shortly.",
  },
});

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

    safeLog("server_fatal_shutdown_started", {
      level: "error",
      name: reasonError.name,
      message: reasonError.message,
      stack: reasonError.stack,
    });

    const forcedShutdownTimer = setTimeout(() => {
      safeLog("server_forced_shutdown_after_grace_period", {
        level: "error",
      });
      process.exit(1);
    }, SHUTDOWN_GRACE_PERIOD_MS);
    forcedShutdownTimer.unref();

    server.close(closeError => {
      if (closeError) {
        safeLog("server_close_failed", {
          level: "error",
          error: closeError,
        });
      }
      process.exit(1);
    });
  };

  process.on("unhandledRejection", reason => {
    shutdown(toError(reason));
  });
  process.on("uncaughtException", error => {
    shutdown(error);
  });

  process.on("SIGTERM", () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    server.close(closeError => {
      if (closeError) {
        safeLog("server_sigterm_close_failed", {
          level: "error",
          error: closeError,
        });
        process.exit(1);
      }
      process.exit(0);
    });
  });
}

async function startServer() {
  safeLog("boot", { pid: process.pid });
  safeLog("version", buildVersionPayload(gitSha, bootTimestamp));
  const generatorStartupConfig = getBotStartupConfig();
  const generationWorkerOnly = isMessengerGenerationWorkerOnlyMode();
  safeLog("generator_startup_config", generatorStartupConfig);
  assertProductionImageStorageConfig();
  assertAuthConfig();
  assertWhatsAppConfig();
  const mollieBillingEnabled = isMollieBillingEnabled();
  const mollieBillingPreflightEnabled = isMollieBillingPreflightEnabled();
  const aiAnswerEnforcementEnabled = isMollieEntitlementEnforcementEnabled();
  const aiFinalizationDrainEnabled =
    process.env.AI_ANSWER_FINALIZATION_DRAIN_ENABLED === "true";
  const accountingImportEnabled = isMollieAccountingImportEnabled();
  const notificationPlaneEnabled = isBillingNotificationPlaneEnabled();
  if (notificationPlaneEnabled && !generationWorkerOnly) {
    assertBillingNotificationConfig();
  }
  if (accountingImportEnabled && !generationWorkerOnly) {
    void getMollieAccountingImportConfig();
    await assertMollieAccountingSchemaReadiness();
  }
  if (mollieBillingPreflightEnabled && !generationWorkerOnly) {
    assertTenantBillingWorkerConfigured();
    assertMollieNonSecretLaunchConfig();
    assertBillingNotificationConfig();
    await assertBillingDatabaseReadiness(getConfiguredBillingMode(), {
      requireRuntimeHeartbeat: false,
    });
  }
  if (mollieBillingEnabled && !generationWorkerOnly) {
    assertMollieBillingEnabled();
    void getMollieConfig();
  } else {
    safeLog("mollie_billing_disabled");
  }
  if (
    (aiAnswerEnforcementEnabled || aiFinalizationDrainEnabled) &&
    !generationWorkerOnly
  ) {
    const mode = getConfiguredBillingMode();
    await assertAiAnswerFinalizationReadiness(mode);
  }
  assertPrivacyConfig();
  assertConversationIdentityConfig();
  assertProductionStateStoreConfig();
  assertProductionWebhookReplayProtectionConfig();
  await ensureStateStoreReady();
  await ensureWebhookReplayProtectionReady();
  await ensureWebhookIngressQueueReady();
  await ensureHttpRateLimiterReady();
  assertMessengerGenerationQueueConfig();
  await ensureMessengerGenerationQueueReady();
  await ensureMessengerGenerationCompletionReady();
  if (isMessengerGenerationWorkerMode() || generationWorkerOnly) {
    startMessengerGenerationWorker({ keepAlive: generationWorkerOnly });
  }
  if (generationWorkerOnly) {
    safeLog("messenger_generation_worker_only_mode_active");
    return;
  }

  await reconcileMessengerProfileOnStartup();

  const app = express();
  app.set("trust proxy", 1);
  const server = createServer(app);
  setupGlobalErrorHandlers(server);

  applySecurityHeaders(app);
  app.use(attachRequestTracing());
  app.use(redisBackedHttpRateLimiterGuard, createGlobalHttpRateLimiter());

  app.use(createRequestMetricsMiddleware());

  registerSentryDebugRoute(app);

  // The classic Mollie route owns a strict 2 KB form parser and must be
  // registered before the global 10 MB parsers used by Messenger/media APIs.
  if (mollieBillingEnabled) {
    registerMollieWebhookRoute(app);
  }
  if (notificationPlaneEnabled) {
    registerBillingNotificationReceiverRoute(app);
  }
  if (accountingImportEnabled) {
    startMollieAccountingImportWorker();
  }

  app.use(
    express.json({
      limit: REQUEST_BODY_LIMIT,
      verify: captureBotWebhookRawBody,
    })
  );
  app.use(express.urlencoded({ limit: REQUEST_BODY_LIMIT, extended: true }));

  registerWebhookRuntime(app);

  registerHealthRoutes(app);

  registerVersionRoute(app, () => buildVersionPayload(gitSha, bootTimestamp));
  registerMetricsRoute(app);
  registerFaceMemoryAdminRoutes(app);
  registerPortalRoutes(app);
  if (mollieBillingEnabled) {
    registerBillingPortalRoutes(app);
  }

  registerDebugRoutes(app, gitSha);

  registerPublicConfigRoute(app);
  registerLegalRoutes(app);

  scheduleFaceMemoryExpiry();
  if (aiAnswerEnforcementEnabled || aiFinalizationDrainEnabled) {
    startAiAnswerFinalizationWorker();
  }
  if (aiAnswerEnforcementEnabled) {
    startBillingProfileExpiryWorker();
  }
  if (notificationPlaneEnabled) {
    startBillingNotificationReceiverWorker();
  }
  if (mollieBillingEnabled) {
    startBillingOutboxWorker();
    startDailyBillingReconciliation();
  }

  const oauthServerUrl = process.env.OAUTH_SERVER_URL;
  if (oauthServerUrl) {
    registerOAuthRoutes(app);
  } else {
    safeLog("oauth_routes_skipped", { reason: "missing_oauth_server_url" });
  }
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  app.use(bodyParserErrorHandler);

  const publicDir = path.join(process.cwd(), "public");
  app.get("/generated/:token.:ext", (req, res) => {
    const generatedImage = getGeneratedImage(req.params.token);
    if (!generatedImage) {
      safeLog("generated_image_fetch_miss", {
        level: "warn",
        reqId: getRequestId(req),
        tokenHash: hashGeneratedImageToken(req.params.token),
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
    safeLog("server_listening", { port: PORT, host: HOST });
  });
}

startServer().catch(error => {
  safeLog("server_start_failed", {
    level: "error",
    error: toError(error),
  });
  process.exit(1);
});
