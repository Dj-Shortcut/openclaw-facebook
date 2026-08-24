import { and, inArray, isNotNull, or } from "drizzle-orm";

import {
  billingIntents,
  billingProviderOperations,
  billingSubscriptions,
  billingWebhookRoutes,
  paymentLedger,
} from "../../../drizzle/schema";
import { getDatabaseOrThrow } from "../../db";
import { isMollieBillingDrainEnabled } from "./config";

/**
 * Provider activity remains externally mutable after checkout exposure: an
 * open Payment can complete, and a retained Payment can later be refunded or
 * charged back. Once any such durable binding exists, silently removing the
 * webhook/reconciliation plane is unsafe.
 */
export async function hasDurableMollieProviderActivity(): Promise<boolean> {
  const database = await getDatabaseOrThrow();
  const [intent, operation, subscription, route, ledger] = await Promise.all([
    database
      .select({ id: billingIntents.intentId })
      .from(billingIntents)
      .where(isNotNull(billingIntents.molliePaymentId))
      .limit(1),
    database
      .select({ id: billingProviderOperations.operationId })
      .from(billingProviderOperations)
      .where(
        and(
          inArray(billingProviderOperations.operationType, [
            "create_payment",
            "create_subscription",
          ]),
          or(
            isNotNull(billingProviderOperations.firstStartedAt),
            isNotNull(billingProviderOperations.providerResourceId)
          )
        )
      )
      .limit(1),
    database
      .select({ id: billingSubscriptions.id })
      .from(billingSubscriptions)
      .where(isNotNull(billingSubscriptions.mollieSubscriptionId))
      .limit(1),
    database
      .select({ id: billingWebhookRoutes.molliePaymentId })
      .from(billingWebhookRoutes)
      .limit(1),
    database.select({ id: paymentLedger.id }).from(paymentLedger).limit(1),
  ]);
  return Boolean(
    intent[0] || operation[0] || subscription[0] || route[0] || ledger[0]
  );
}

export function assertMollieBillingDrainLifecycleState(
  hasDurableProviderActivity: boolean,
  drainEnabled = isMollieBillingDrainEnabled()
): void {
  if (hasDurableProviderActivity && !drainEnabled) {
    throw new Error(
      "MOLLIE_BILLING_DRAIN_ENABLED must remain true after provider transport or checkout exposure"
    );
  }
}

export async function assertMollieBillingDrainLifecycle(): Promise<void> {
  assertMollieBillingDrainLifecycleState(
    await hasDurableMollieProviderActivity()
  );
}
