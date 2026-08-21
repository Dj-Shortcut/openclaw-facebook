import type express from "express";
import { assertProductionImageStorageConfig } from "./image-generation/imageServiceConfig";
import {
  assertMessengerGenerationQueueConfig,
  ensureMessengerGenerationQueueReady,
  getMessengerGenerationQueueStats,
  isMessengerGenerationQueueEnabled,
} from "./messengerGenerationQueue";
import { ensureHttpRateLimiterReady } from "./httpRateLimit";
import { ensureStateStoreReady } from "./stateStore";
import { ensureWebhookIngressQueueReady } from "./meta/webhookIngressQueue";
import { ensureWebhookReplayProtectionReady } from "./webhookReplayProtection";
import { assertPortalDatabaseConfig } from "./env";
import { assertConversationIdentityConfig } from "./conversationIdentityConfig";
import {
  ensureMessengerPrivacyErasureQueueReadable,
  ensureMessengerPrivacyErasureWorkerReady,
} from "./messengerPrivacyErasureQueue";
import {
  assertMollieBillingEnabled,
  assertMollieNonSecretLaunchConfig,
  assertTenantBillingWorkerConfigured,
  getConfiguredBillingMode,
  isMollieBillingPreflightEnabled,
  isMollieBillingEnabled,
  isMollieEntitlementEnforcementEnabled,
} from "./billing/config";
import {
  assertBillingNotificationConfig,
  isBillingNotificationPlaneEnabled,
} from "./billing/billingNotificationDelivery";
import { assertBillingDatabaseReadiness } from "./billing/billingReadiness";
import { assertBillingNotificationRuntimeReadiness } from "./billing/billingReadiness";
import { assertAiAnswerFinalizationReadiness } from "./billing/billingReadiness";
import { assertMollieAccountingWorkerReadiness } from "./billing/billingReadiness";
import { ensureMessengerGenerationCompletionReady } from "./messengerGenerationCompletion";
import {
  getMollieAccountingImportConfig,
  isMollieAccountingImportEnabled,
} from "./billing/accountingWorker";
import { assertCostLedgerV2Ready } from "./costLedger";

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
  const aiFinalizationDrainEnabled =
    process.env.AI_ANSWER_FINALIZATION_DRAIN_ENABLED === "true";
  const aiAnswerQuotaPreflightEnabled =
    process.env.AI_ANSWER_QUOTA_PREFLIGHT_ENABLED === "true";
  return [
    {
      name: "conversation_identity_config",
      check: assertConversationIdentityConfig,
    },
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
      name: "tenant_scoped_cost_ledger",
      check: assertCostLedgerV2Ready,
    },
    {
      name: "generation_artifact_cleanup",
      check: ensureMessengerGenerationCompletionReady,
    },
    {
      name: "messenger_privacy_erasure_encryption",
      check: ensureMessengerPrivacyErasureQueueReadable,
    },
    {
      name: "messenger_privacy_erasure_worker",
      check: ensureMessengerPrivacyErasureWorkerReady,
    },
    {
      name: "portal_database_config",
      check: assertPortalDatabaseConfig,
    },
    {
      name: "mollie_billing_config",
      check: () => {
        if (isMollieBillingEnabled()) {
          assertMollieBillingEnabled();
          assertTenantBillingWorkerConfigured();
        }
      },
    },
    {
      name: "billing_notification_plane",
      check: () => {
        if (isBillingNotificationPlaneEnabled()) {
          assertBillingNotificationConfig();
        }
      },
    },
    {
      name: "billing_notification_runtime",
      check: async () => {
        if (isBillingNotificationPlaneEnabled()) {
          await assertBillingNotificationRuntimeReadiness(
            getConfiguredBillingMode()
          );
        }
      },
    },
    {
      name: "mollie_launch_nonsecret_preflight",
      check: async () => {
        if (isMollieBillingPreflightEnabled()) {
          assertMollieNonSecretLaunchConfig();
          await assertBillingDatabaseReadiness(getConfiguredBillingMode());
        }
      },
    },
    {
      name: "ai_answer_finalization",
      check: async () => {
        const admissionEnabled = isMollieEntitlementEnforcementEnabled();
        if (
          (admissionEnabled || aiAnswerQuotaPreflightEnabled) &&
          !aiFinalizationDrainEnabled
        ) {
          throw new Error(
            "AI answer quota admission/preflight requires the durable finalization drain"
          );
        }
        if (
          admissionEnabled ||
          aiFinalizationDrainEnabled ||
          aiAnswerQuotaPreflightEnabled
        ) {
          await assertAiAnswerFinalizationReadiness(getConfiguredBillingMode());
        }
      },
    },
    {
      name: "mollie_accounting_import",
      check: async () => {
        if (isMollieAccountingImportEnabled()) {
          const config = getMollieAccountingImportConfig();
          await assertMollieAccountingWorkerReadiness(config);
        }
      },
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

        await ensureMessengerGenerationQueueReady();
        await getMessengerGenerationQueueStats();
      },
    },
  ];
}
