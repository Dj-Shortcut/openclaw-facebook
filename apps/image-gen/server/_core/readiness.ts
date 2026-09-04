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
import { assertDatabaseConfig } from "./env";
import { assertConversationIdentityConfig } from "./conversationIdentityConfig";
import {
  assertMollieBillingEnabled,
  assertMollieNonSecretLaunchConfig,
  assertTenantBillingWorkerConfigured,
  getConfiguredBillingMode,
  getMollieConfig,
  getMollieReadinessPhase,
  isMollieBillingDrainEnabled,
  isMollieBillingPreflightEnabled,
  isMollieBillingEnabled,
  isMollieEntitlementEnforcementEnabled,
} from "./billing/config";
import {
  assertMollieBillingDrainLifecycle,
  assertOwnerMessengerBillingRuntimeCompatible,
} from "./billing/billingDrainLifecycle";
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
import {
  getCreditCheckoutPilotConfig,
  withCreditCheckoutHmacKeyring,
} from "./billing/creditCheckoutConfig";
import { assertCreditCheckoutDatabaseReadiness } from "./billing/creditCheckoutReadiness";
import { assertFacebookPageTokenConfig } from "./facebookPageToken";

export type ReadinessCheck = {
  name: string;
  check: () => Promise<void> | void;
};

export type ReadinessPhase = "core" | "offline" | "operational";

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
  checks: readonly ReadinessCheck[],
  options: { getPhase?: () => ReadinessPhase } = {}
): express.RequestHandler {
  return (_req, res, next) => {
    void runReadinessChecks(checks)
      .then(checkResults => {
        const ok = checkResults.every(result => result.ok);
        res.status(ok ? 200 : 503).json({
          ok,
          ...(options.getPhase ? { phase: options.getPhase() } : {}),
          checks: checkResults,
        });
      })
      .catch(next);
  };
}

export function buildRuntimeReadinessChecks(): ReadinessCheck[] {
  const mollieReadinessPhase = getMollieReadinessPhase();
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
      name: "messenger_page_credential_config",
      check: assertFacebookPageTokenConfig,
    },
    {
      name: "state_store",
      check: ensureStateStoreReady,
    },
    {
      name: "database_config",
      check: assertDatabaseConfig,
    },
    {
      name: "mollie_billing_config",
      check: () => {
        if (isMollieBillingEnabled()) {
          assertMollieBillingEnabled();
          assertTenantBillingWorkerConfigured();
        } else if (isMollieBillingDrainEnabled()) {
          void getMollieConfig();
          assertTenantBillingWorkerConfigured();
        }
      },
    },
    {
      name: "mollie_billing_drain_lifecycle",
      check: assertMollieBillingDrainLifecycle,
    },
    {
      name: "owner_messenger_billing_runtime",
      check: assertOwnerMessengerBillingRuntimeCompatible,
    },
    {
      name: "credit_checkout",
      check: async () => {
        const config = getCreditCheckoutPilotConfig();
        if (!config.paidCreditsEnabled && !config.checkoutEnabled) return;
        withCreditCheckoutHmacKeyring(() => undefined);
        await assertCreditCheckoutDatabaseReadiness({
          mode: config.mode,
          workspaceId: config.workspaceId!,
          commercialExposureEnabled: config.checkoutEnabled,
        });
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
          const requireOperationalFlags =
            mollieReadinessPhase === "operational";
          assertMollieNonSecretLaunchConfig({ requireOperationalFlags });
          await assertBillingDatabaseReadiness(getConfiguredBillingMode(), {
            requireRuntimeHeartbeat: requireOperationalFlags,
          });
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
        await ensureMessengerGenerationCompletionReady();
        await getMessengerGenerationQueueStats();
      },
    },
  ];
}
