import type express from "express";
import { assertProductionImageStorageConfig } from "./image-generation/imageServiceConfig";
import {
  assertMessengerGenerationQueueConfig,
  getMessengerGenerationQueueStats,
  isMessengerGenerationQueueEnabled,
} from "./messengerGenerationQueue";
import { ensureHttpRateLimiterReady } from "./httpRateLimit";
import { ensureStateStoreReady } from "./stateStore";
import { ensureWebhookIngressQueueReady } from "./meta/webhookIngressQueue";
import { ensureWebhookReplayProtectionReady } from "./webhookReplayProtection";
import { assertPortalDatabaseConfig } from "./env";

export type ReadinessCheck = {
  name: string;
  check: () => Promise<void> | void;
};

type ReadinessCheckResult = {
  name: string;
  ok: boolean;
  error?: string;
};

function readinessErrorCode(error: unknown): string {
  if (error instanceof Error) {
    return error.constructor.name;
  }

  return "UnknownError";
}

async function runReadinessChecks(
  checks: readonly ReadinessCheck[]
): Promise<ReadinessCheckResult[]> {
  const results = await Promise.allSettled(
    checks.map(async readinessCheck => {
      await readinessCheck.check();
      return readinessCheck.name;
    })
  );

  return results.map((result, index) => {
    const name = checks[index]?.name ?? "unknown";
    if (result.status === "fulfilled") {
      return { name, ok: true };
    }

    return {
      name,
      ok: false,
      error: readinessErrorCode(result.reason),
    };
  });
}

export function createReadinessHandler(
  checks: readonly ReadinessCheck[]
): express.RequestHandler {
  return (_req, res, next) => {
    void runReadinessChecks(checks)
      .then(checkResults => {
        const ok = checkResults.every(result => result.ok);
        res.status(ok ? 200 : 503).json({
          ok,
          checks: checkResults,
        });
      })
      .catch(next);
  };
}

export function buildRuntimeReadinessChecks(): ReadinessCheck[] {
  return [
    {
      name: "image_storage_config",
      check: () => {
        assertProductionImageStorageConfig();
      },
    },
    {
      name: "state_store",
      check: ensureStateStoreReady,
    },
    {
      name: "portal_database_config",
      check: assertPortalDatabaseConfig,
    },
    {
      name: "webhook_replay_protection",
      check: ensureWebhookReplayProtectionReady,
    },
    {
      name: "webhook_ingress_queue",
      check: ensureWebhookIngressQueueReady,
    },
    {
      name: "http_rate_limiter",
      check: ensureHttpRateLimiterReady,
    },
    {
      name: "messenger_generation_queue_config",
      check: () => {
        assertMessengerGenerationQueueConfig();
      },
    },
    {
      name: "messenger_generation_queue",
      check: async () => {
        if (!isMessengerGenerationQueueEnabled()) {
          return;
        }

        await getMessengerGenerationQueueStats();
      },
    },
  ];
}
