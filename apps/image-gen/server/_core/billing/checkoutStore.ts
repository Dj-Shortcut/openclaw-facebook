import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  billingCustomers,
  billingIntents,
  billingOutbox,
  billingSubscriptions,
  workspaces,
  type BillingCustomer,
  type BillingIntent,
} from "../../../drizzle/schema";
import { getDatabaseOrThrow } from "../../db";
import type { BillingPlan } from "./catalog";
import { formatAmountMinor } from "./catalog";
import type { MollieMode } from "./config";
import {
  createExternalBillingReference,
  createOpaqueBillingId,
  deterministicIdempotencyKey,
} from "./ids";

export type CheckoutKind =
  | "subscription_start"
  | "payment_method_change"
  | "startpilot_purchase";

export type BillingCustomerReservation = {
  customer: BillingCustomer;
  creationClaimed: boolean;
};

const REUSABLE_INTENT_STATUSES = [
  "created",
  "creating_payment",
  "open",
  "api_unknown",
] as const;

export function blocksSubscriptionStart(
  subscription:
    | Pick<typeof billingSubscriptions.$inferSelect, "status" | "paidThrough">
    | null
    | undefined,
  now: Date
): boolean {
  if (!subscription) return false;
  if (
    [
      "provisioning",
      "active",
      "past_due",
      "suspended",
      "manual_review",
    ].includes(subscription.status)
  ) {
    return true;
  }
  return Boolean(
    subscription.paidThrough &&
    subscription.paidThrough.getTime() > now.getTime()
  );
}

export async function reserveCheckoutIntent(input: {
  workspaceId: number;
  mode: MollieMode;
  plan: BillingPlan;
  kind: CheckoutKind;
  messengerSenderUserKey?: string | null;
  messengerPageId?: string | null;
}): Promise<BillingIntent> {
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const workspaceRows = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .limit(1)
      .for("update");
    if (!workspaceRows[0]) {
      throw new Error("workspace not found");
    }

    const existingSubscription = await tx
      .select()
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.workspaceId, input.workspaceId),
          eq(billingSubscriptions.mode, input.mode)
        )
      )
      .limit(1);
    const subscription = existingSubscription[0];
    if (
      input.kind === "subscription_start" &&
      blocksSubscriptionStart(subscription, new Date())
    ) {
      throw new Error("workspace already has a billing subscription");
    }
    if (
      input.kind === "payment_method_change" &&
      (!subscription || subscription.status !== "active")
    ) {
      throw new Error("workspace has no subscription to update");
    }
    if (
      input.kind === "startpilot_purchase" &&
      blocksSubscriptionStart(subscription, new Date())
    ) {
      throw new Error("workspace already has paid billing access");
    }

    if (input.kind === "startpilot_purchase") {
      const completedPilot = await tx
        .select({ intentId: billingIntents.intentId })
        .from(billingIntents)
        .where(
          and(
            eq(billingIntents.workspaceId, input.workspaceId),
            eq(billingIntents.mode, input.mode),
            eq(billingIntents.kind, "startpilot_purchase"),
            eq(billingIntents.status, "paid")
          )
        )
        .limit(1);
      if (completedPilot[0]) {
        throw new Error("workspace already used its Startpilot");
      }
    }

    const reusable = await tx
      .select()
      .from(billingIntents)
      .where(
        and(
          eq(billingIntents.workspaceId, input.workspaceId),
          eq(billingIntents.mode, input.mode),
          inArray(billingIntents.status, [...REUSABLE_INTENT_STATUSES])
        )
      )
      .orderBy(desc(billingIntents.createdAt))
      .limit(1);
    if (reusable[0]) {
      if (
        reusable[0].planCode !== input.plan.code ||
        reusable[0].kind !== input.kind ||
        (input.messengerSenderUserKey ?? null) !==
          (reusable[0].messengerSenderUserKey ?? null) ||
        (input.messengerPageId ?? null) !==
          (reusable[0].messengerPageId ?? null)
      ) {
        throw new Error("workspace already has a checkout in progress");
      }
      return reusable[0];
    }

    const intentId = createOpaqueBillingId();
    const idempotencyKey = deterministicIdempotencyKey("payment", intentId);
    await tx.insert(billingIntents).values({
      intentId,
      workspaceId: input.workspaceId,
      mode: input.mode,
      planCode: input.plan.code,
      kind: input.kind,
      expectedAmount: formatAmountMinor(input.plan.amountMinor),
      currency: input.plan.currency,
      interval: input.plan.interval,
      entitlements: input.plan.entitlements,
      mollieDescription: input.plan.mollieDescription,
      status: "created",
      idempotencyKey,
      checkoutScopeKey: `${input.mode}:${input.workspaceId}:${input.kind}:${intentId}`,
      messengerSenderUserKey: input.messengerSenderUserKey ?? null,
      messengerPageId: input.messengerPageId ?? null,
    });

    const created = await tx
      .select()
      .from(billingIntents)
      .where(eq(billingIntents.intentId, intentId))
      .limit(1);
    if (!created[0]) {
      throw new Error("billing intent was not persisted");
    }
    return created[0];
  });
}

export async function reserveBillingCustomer(
  workspaceId: number,
  mode: MollieMode
): Promise<BillingCustomerReservation> {
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const workspaceRows = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1)
      .for("update");
    if (!workspaceRows[0]) {
      throw new Error("workspace not found");
    }
    const existing = await tx
      .select()
      .from(billingCustomers)
      .where(
        and(
          eq(billingCustomers.workspaceId, workspaceId),
          eq(billingCustomers.mode, mode)
        )
      )
      .limit(1);
    if (existing[0]) {
      if (existing[0].status !== "provisioning") {
        return { customer: existing[0], creationClaimed: false };
      }
      await tx
        .update(billingCustomers)
        .set({ status: "creating_customer" })
        .where(
          and(
            eq(billingCustomers.workspaceId, workspaceId),
            eq(billingCustomers.mode, mode),
            eq(billingCustomers.status, "provisioning")
          )
        );
      const claimed = await tx
        .select()
        .from(billingCustomers)
        .where(
          and(
            eq(billingCustomers.workspaceId, workspaceId),
            eq(billingCustomers.mode, mode)
          )
        )
        .limit(1);
      if (!claimed[0]) {
        throw new Error("billing customer claim was not persisted");
      }
      return { customer: claimed[0], creationClaimed: true };
    }

    const externalReference = createExternalBillingReference();
    const idempotencyKey = deterministicIdempotencyKey(
      "customer",
      externalReference
    );
    await tx.insert(billingCustomers).values({
      workspaceId,
      mode,
      externalReference,
      idempotencyKey,
      status: "creating_customer",
    });
    const created = await tx
      .select()
      .from(billingCustomers)
      .where(
        and(
          eq(billingCustomers.workspaceId, workspaceId),
          eq(billingCustomers.mode, mode)
        )
      )
      .limit(1);
    if (!created[0]) {
      throw new Error("billing customer reservation was not persisted");
    }
    return { customer: created[0], creationClaimed: true };
  });
}

export async function attachMollieCustomer(
  workspaceId: number,
  mode: MollieMode,
  mollieCustomerId: string
): Promise<BillingCustomer> {
  const database = await getDatabaseOrThrow();
  const result = await database.transaction(async tx => {
    await tx
      .update(billingCustomers)
      .set({ mollieCustomerId, status: "active" })
      .where(
        and(
          eq(billingCustomers.workspaceId, workspaceId),
          eq(billingCustomers.mode, mode),
          eq(billingCustomers.status, "creating_customer")
        )
      );
    const customers = await tx
      .select()
      .from(billingCustomers)
      .where(
        and(
          eq(billingCustomers.workspaceId, workspaceId),
          eq(billingCustomers.mode, mode)
        )
      )
      .limit(1)
      .for("update");
    const customer = customers[0];
    if (!customer?.mollieCustomerId) {
      throw new Error("Mollie customer was not attached");
    }
    if (customer.mollieCustomerId === mollieCustomerId) {
      return { customer, conflict: false as const };
    }

    await tx
      .update(billingCustomers)
      .set({ status: "manual_review" })
      .where(
        and(
          eq(billingCustomers.workspaceId, workspaceId),
          eq(billingCustomers.mode, mode),
          eq(billingCustomers.mollieCustomerId, customer.mollieCustomerId)
        )
      );
    await tx
      .insert(billingOutbox)
      .values({
        workspaceId,
        mode,
        eventType: "manual_review",
        deduplicationKey: `customer_conflict:${mollieCustomerId}`,
        payload: {
          reason: "billing_customer_id_conflict",
          providerCustomerId: mollieCustomerId,
        },
        status: "pending",
      })
      .onDuplicateKeyUpdate({
        set: { deduplicationKey: sql`deduplication_key` },
      });
    return { customer, conflict: true as const };
  });

  if (result.conflict) {
    throw new Error("Mollie customer conflict for workspace billing");
  }
  return result.customer;
}

export async function markBillingCustomerManualReview(
  workspaceId: number,
  mode: MollieMode
): Promise<void> {
  const database = await getDatabaseOrThrow();
  await database
    .update(billingCustomers)
    .set({ status: "manual_review" })
    .where(
      and(
        eq(billingCustomers.workspaceId, workspaceId),
        eq(billingCustomers.mode, mode),
        eq(billingCustomers.status, "creating_customer")
      )
    );
}

export async function getBillingCustomer(
  workspaceId: number,
  mode: MollieMode
): Promise<BillingCustomer | null> {
  const database = await getDatabaseOrThrow();
  const result = await database
    .select()
    .from(billingCustomers)
    .where(
      and(
        eq(billingCustomers.workspaceId, workspaceId),
        eq(billingCustomers.mode, mode)
      )
    )
    .limit(1);
  return result[0] ?? null;
}

export async function claimIntentPaymentCreation(
  intentId: string
): Promise<boolean> {
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const intents = await tx
      .select({ status: billingIntents.status })
      .from(billingIntents)
      .where(eq(billingIntents.intentId, intentId))
      .limit(1)
      .for("update");
    if (intents[0]?.status !== "created") {
      return false;
    }
    await tx
      .update(billingIntents)
      .set({ status: "creating_payment" })
      .where(
        and(
          eq(billingIntents.intentId, intentId),
          eq(billingIntents.status, "created")
        )
      );
    return true;
  });
}

export async function attachMolliePayment(input: {
  intentId: string;
  workspaceId: number;
  mode: MollieMode;
  molliePaymentId: string;
}): Promise<boolean> {
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const rows = await tx
      .select()
      .from(billingIntents)
      .where(
        and(
          eq(billingIntents.intentId, input.intentId),
          eq(billingIntents.workspaceId, input.workspaceId),
          eq(billingIntents.mode, input.mode)
        )
      )
      .limit(1)
      .for("update");
    const intent = rows[0];
    if (!intent) return false;
    if (
      intent.molliePaymentId === input.molliePaymentId &&
      intent.status === "open"
    ) {
      return true;
    }
    if (
      !intent.molliePaymentId &&
      (intent.status === "creating_payment" || intent.status === "open")
    ) {
      await tx
        .update(billingIntents)
        .set({ molliePaymentId: input.molliePaymentId, status: "open" })
        .where(
          and(
            eq(billingIntents.intentId, input.intentId),
            eq(billingIntents.workspaceId, input.workspaceId),
            eq(billingIntents.mode, input.mode),
            inArray(billingIntents.status, ["creating_payment", "open"])
          )
        );
      return true;
    }
    if (
      intent.kind === "payment_method_change" &&
      intent.status === "canceled" &&
      !intent.molliePaymentId
    ) {
      await tx
        .update(billingIntents)
        .set({ molliePaymentId: input.molliePaymentId })
        .where(
          and(
            eq(billingIntents.intentId, input.intentId),
            eq(billingIntents.workspaceId, input.workspaceId),
            eq(billingIntents.mode, input.mode),
            eq(billingIntents.status, "canceled")
          )
        );
      await tx
        .insert(billingOutbox)
        .values({
          workspaceId: input.workspaceId,
          mode: input.mode,
          eventType: "manual_review",
          deduplicationKey: `superseded_checkout:${input.molliePaymentId}`,
          payload: {
            reason: "provider_payment_created_after_checkout_superseded",
            intentId: input.intentId,
          },
          status: "pending",
        })
        .onDuplicateKeyUpdate({
          set: { deduplicationKey: sql`deduplication_key` },
        });
    }
    return false;
  });
}

export async function markIntentApiUnknown(intentId: string): Promise<void> {
  const database = await getDatabaseOrThrow();
  await database
    .update(billingIntents)
    .set({ status: "api_unknown" })
    .where(
      and(
        eq(billingIntents.intentId, intentId),
        eq(billingIntents.status, "creating_payment")
      )
    );
}

export async function markIntentPaymentMismatch(input: {
  intentId: string;
  workspaceId: number;
  mode: MollieMode;
  molliePaymentId: string | null;
}): Promise<void> {
  const database = await getDatabaseOrThrow();
  await database.transaction(async tx => {
    await tx
      .update(billingIntents)
      .set({ status: "mismatch" })
      .where(
        and(
          eq(billingIntents.intentId, input.intentId),
          eq(billingIntents.workspaceId, input.workspaceId),
          eq(billingIntents.mode, input.mode),
          eq(billingIntents.status, "creating_payment")
        )
      );
    await tx
      .insert(billingOutbox)
      .values({
        workspaceId: input.workspaceId,
        mode: input.mode,
        eventType: "manual_review",
        deduplicationKey: `checkout_response_mismatch:${input.intentId}`,
        payload: {
          reason: "checkout_provider_response_mismatch",
          intentId: input.intentId,
          ...(input.molliePaymentId
            ? { paymentId: input.molliePaymentId }
            : {}),
        },
        status: "pending",
      })
      .onDuplicateKeyUpdate({
        set: { deduplicationKey: sql`deduplication_key` },
      });
  });
}

export async function getBillingIntent(
  intentId: string,
  workspaceId: number,
  mode: MollieMode
): Promise<BillingIntent | null> {
  const database = await getDatabaseOrThrow();
  const result = await database
    .select()
    .from(billingIntents)
    .where(
      and(
        eq(billingIntents.intentId, intentId),
        eq(billingIntents.workspaceId, workspaceId),
        eq(billingIntents.mode, mode)
      )
    )
    .limit(1);
  return result[0] ?? null;
}
