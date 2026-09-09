import { and, eq, inArray, isNotNull, ne, or } from "drizzle-orm";

import {
  billingIntents,
  billingOutbox,
  billingProviderOperations,
  billingSubscriptions,
  billingWebhookRoutes,
  paymentLedger,
} from "../../../drizzle/schema";
import { getDatabaseOrThrow } from "../../db";
import { isMollieBillingDrainEnabled } from "./config";

export type OwnerMessengerLegacyWorkState = Readonly<{
  unresolvedProviderIntent: boolean;
  unresolvedProviderOperation: boolean;
  activeSubscription: boolean;
  retiredOutboxDelivery: boolean;
}>;

export class OwnerMessengerLegacyBillingWorkError extends Error {
  constructor(readonly workKind: keyof OwnerMessengerLegacyWorkState) {
    super(
      `Owner-operated Messenger runtime cannot start while legacy billing work remains: ${workKind}`
    );
    this.name = "OwnerMessengerLegacyBillingWorkError";
  }
}

/**
 * The simplified runtime deliberately omits legacy subscription and portal
 * workers. Only executable legacy work blocks startup; terminal rows remain
 * available for accounting and audit retention without becoming a runtime
 * prerequisite.
 */
export function assertOwnerMessengerLegacyWorkState(
  state: OwnerMessengerLegacyWorkState
): void {
  const workKind = (
    Object.keys(state) as (keyof OwnerMessengerLegacyWorkState)[]
  ).find(key => state[key]);
  if (workKind) {
    throw new OwnerMessengerLegacyBillingWorkError(workKind);
  }
}

export async function getOwnerMessengerLegacyWorkState(): Promise<OwnerMessengerLegacyWorkState> {
  const database = await getDatabaseOrThrow();
  const [intent, operation, subscription, outbox] = await Promise.all([
    database
      .select({ id: billingIntents.intentId })
      .from(billingIntents)
      .where(
        and(
          ne(billingIntents.kind, "credit_purchase"),
          isNotNull(billingIntents.molliePaymentId),
          inArray(billingIntents.status, [
            "creating_payment",
            "open",
            "paid",
            "mismatch",
            "api_unknown",
          ])
        )
      )
      .limit(1),
    database
      .select({ id: billingProviderOperations.operationId })
      .from(billingProviderOperations)
      .innerJoin(
        billingIntents,
        and(
          eq(billingIntents.intentId, billingProviderOperations.intentId),
          eq(billingIntents.workspaceId, billingProviderOperations.workspaceId),
          eq(billingIntents.mode, billingProviderOperations.mode),
          eq(
            billingIntents.billingProfileVersion,
            billingProviderOperations.billingProfileVersion
          ),
          eq(
            billingIntents.authorizationEpoch,
            billingProviderOperations.authorizationEpoch
          )
        )
      )
      .where(
        and(
          ne(billingIntents.kind, "credit_purchase"),
          inArray(billingIntents.status, [
            "created",
            "creating_payment",
            "open",
            "paid",
            "mismatch",
            "api_unknown",
          ]),
          inArray(billingProviderOperations.state, [
            "reserved",
            "transport_started",
            "succeeded",
            "ambiguous",
            "reconciliation_only",
          ])
        )
      )
      .limit(1),
    database
      .select({ id: billingSubscriptions.id })
      .from(billingSubscriptions)
      .where(
        inArray(billingSubscriptions.status, [
          "provisioning",
          "active",
          "past_due",
          "suspended",
          "manual_review",
        ])
      )
      .limit(1),
    database
      .select({ id: billingOutbox.id })
      .from(billingOutbox)
      .where(
        and(
          inArray(billingOutbox.eventType, [
            "ensure_subscription",
            "send_portal_handoff",
          ]),
          inArray(billingOutbox.status, ["pending", "processing"])
        )
      )
      .limit(1),
  ]);
  return Object.freeze({
    unresolvedProviderIntent: Boolean(intent[0]),
    unresolvedProviderOperation: Boolean(operation[0]),
    activeSubscription: Boolean(subscription[0]),
    retiredOutboxDelivery: Boolean(outbox[0]),
  });
}

export async function assertOwnerMessengerBillingRuntimeCompatible(): Promise<void> {
  assertOwnerMessengerLegacyWorkState(await getOwnerMessengerLegacyWorkState());
}

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
