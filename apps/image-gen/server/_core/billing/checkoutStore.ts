import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import {
  billingCustomers,
  billingExecutionControls,
  billingIntents,
  billingOutbox,
  billingProviderOperations,
  billingSubscriptions,
  billingSchedulerTenants,
  billingWebhookRoutes,
  workspaceBillingProfiles,
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
  hashCanonicalSnapshot,
} from "./ids";

export type CheckoutKind =
  "subscription_start" | "payment_method_change" | "startpilot_purchase";

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
  billingProfileVersion: number;
  authorizationEpoch: number;
}): Promise<BillingIntent> {
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const controls = await tx
      .select({
        commercialEnabled: billingExecutionControls.commercialEnabled,
        authorizationEpoch: billingExecutionControls.authorizationEpoch,
      })
      .from(billingExecutionControls)
      .where(
        and(
          eq(billingExecutionControls.workspaceId, input.workspaceId),
          eq(billingExecutionControls.mode, input.mode)
        )
      )
      .limit(1)
      .for("update");
    if (
      !controls[0]?.commercialEnabled ||
      controls[0].authorizationEpoch !== input.authorizationEpoch
    ) {
      throw new Error("billing commercial execution changed");
    }
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
          (reusable[0].messengerPageId ?? null) ||
        reusable[0].billingProfileVersion !== input.billingProfileVersion ||
        reusable[0].authorizationEpoch !== input.authorizationEpoch
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
      billingProfileVersion: input.billingProfileVersion,
      authorizationEpoch: input.authorizationEpoch,
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

export async function claimCustomerProviderCreation(input: {
  intentId: string;
  workspaceId: number;
  mode: MollieMode;
  billingProfileVersion: number;
  authorizationEpoch: number;
  externalReference: string;
  idempotencyKey: string;
}): Promise<
  | { claimed: false }
  | { claimed: true; operationId: string; leaseToken: string }
> {
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const now = new Date();
    const controls = await tx
      .select({
        commercialEnabled: billingExecutionControls.commercialEnabled,
        authorizationEpoch: billingExecutionControls.authorizationEpoch,
      })
      .from(billingExecutionControls)
      .where(
        and(
          eq(billingExecutionControls.workspaceId, input.workspaceId),
          eq(billingExecutionControls.mode, input.mode)
        )
      )
      .limit(1)
      .for("update");
    if (
      !controls[0]?.commercialEnabled ||
      controls[0].authorizationEpoch !== input.authorizationEpoch
    ) {
      return { claimed: false };
    }
    const intents = await tx
      .select({
        billingProfileVersion: billingIntents.billingProfileVersion,
        authorizationEpoch: billingIntents.authorizationEpoch,
      })
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
    if (
      intents[0]?.billingProfileVersion !== input.billingProfileVersion ||
      intents[0].authorizationEpoch !== input.authorizationEpoch
    ) {
      return { claimed: false };
    }
    const credentialGenerationId =
      process.env.MOLLIE_CREDENTIAL_GENERATION_ID?.trim() ||
      (process.env.NODE_ENV === "test" ? "test-generation" : "");
    if (!credentialGenerationId) {
      throw new Error("Mollie credential generation id is required");
    }
    const requestFingerprint = hashCanonicalSnapshot({
      externalReference: input.externalReference,
      idempotencyKey: input.idempotencyKey,
    });
    const idempotencyKeyHash = createHash("sha256")
      .update(input.idempotencyKey)
      .digest("hex");
    const existing = await tx
      .select()
      .from(billingProviderOperations)
      .where(
        and(
          eq(billingProviderOperations.mode, input.mode),
          eq(billingProviderOperations.operationType, "create_customer"),
          eq(billingProviderOperations.operationKey, String(input.workspaceId))
        )
      )
      .limit(1)
      .for("update");
    const prior = existing[0];
    const leaseToken = randomUUID();
    if (prior) {
      if (
        prior.state !== "known_failed" ||
        prior.firstStartedAt ||
        prior.requestFingerprint !== requestFingerprint ||
        prior.idempotencyKeyHash !== idempotencyKeyHash ||
        prior.credentialGenerationId !== credentialGenerationId ||
        prior.billingProfileVersion !== input.billingProfileVersion ||
        prior.authorizationEpoch !== input.authorizationEpoch
      ) {
        return { claimed: false };
      }
      const resumed = await tx
        .update(billingProviderOperations)
        .set({
          state: "reserved",
          leaseToken,
          leaseUntil: new Date(now.getTime() + 60_000),
          resolutionDueAt: new Date(now.getTime() + 5 * 60_000),
        })
        .where(
          and(
            eq(billingProviderOperations.operationId, prior.operationId),
            eq(billingProviderOperations.state, "known_failed")
          )
        );
      return providerOperationAffectedRows(resumed) === 1
        ? { claimed: true, operationId: prior.operationId, leaseToken }
        : { claimed: false };
    }
    const operationId = randomUUID();
    await tx.insert(billingProviderOperations).values({
      operationId,
      workspaceId: input.workspaceId,
      mode: input.mode,
      operationType: "create_customer",
      operationKey: String(input.workspaceId),
      intentId: input.intentId,
      billingProfileVersion: input.billingProfileVersion,
      authorizationEpoch: input.authorizationEpoch,
      state: "reserved",
      requestFingerprint,
      idempotencyKeyHash,
      credentialGenerationId,
      leaseToken,
      leaseUntil: new Date(now.getTime() + 60_000),
      resolutionDueAt: new Date(now.getTime() + 5 * 60_000),
    });
    return { claimed: true, operationId, leaseToken };
  });
}

export async function claimIntentPaymentCreation(input: {
  intentId: string;
  workspaceId: number;
  mode: MollieMode;
  billingProfileVersion: number;
  authorizationEpoch: number;
  providerRequest: {
    customerId: string;
    amount: { currency: string; value: string };
    description: string;
    intentId: string;
    redirectUrl: string;
    webhookUrl: string;
    idempotencyKey: string;
    offerType: "one_time" | "subscription";
  };
}): Promise<
  | { claimed: false }
  | { claimed: true; operationId: string; leaseToken: string }
> {
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const now = new Date();
    const controls = await tx
      .select()
      .from(billingExecutionControls)
      .where(
        and(
          eq(billingExecutionControls.workspaceId, input.workspaceId),
          eq(billingExecutionControls.mode, input.mode)
        )
      )
      .limit(1)
      .for("update");
    if (
      !controls[0]?.commercialEnabled ||
      controls[0].authorizationEpoch !== input.authorizationEpoch
    ) {
      return { claimed: false };
    }
    const profiles = await tx
      .select()
      .from(workspaceBillingProfiles)
      .where(eq(workspaceBillingProfiles.workspaceId, input.workspaceId))
      .limit(1)
      .for("update");
    if (
      !isBillingProfileVersionEligible(
        profiles[0],
        input.billingProfileVersion,
        now
      )
    ) {
      return { claimed: false };
    }
    const intents = await tx
      .select({
        status: billingIntents.status,
        workspaceId: billingIntents.workspaceId,
        mode: billingIntents.mode,
        billingProfileVersion: billingIntents.billingProfileVersion,
        expectedAmount: billingIntents.expectedAmount,
        currency: billingIntents.currency,
        mollieDescription: billingIntents.mollieDescription,
        idempotencyKey: billingIntents.idempotencyKey,
      })
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
    if (
      intents[0]?.status !== "created" ||
      intents[0].billingProfileVersion !== input.billingProfileVersion ||
      input.providerRequest.intentId !== input.intentId ||
      input.providerRequest.amount.value !== intents[0].expectedAmount ||
      input.providerRequest.amount.currency !== intents[0].currency ||
      input.providerRequest.description !== intents[0].mollieDescription ||
      input.providerRequest.idempotencyKey !== intents[0].idempotencyKey
    ) {
      return { claimed: false };
    }
    const leaseToken = randomUUID();
    const credentialGenerationId =
      process.env.MOLLIE_CREDENTIAL_GENERATION_ID?.trim() ||
      (process.env.NODE_ENV === "test" ? "test-generation" : "");
    if (!credentialGenerationId) {
      throw new Error("Mollie credential generation id is required");
    }
    const requestFingerprint = hashCanonicalSnapshot(input.providerRequest);
    const idempotencyKeyHash = createHash("sha256")
      .update(intents[0].idempotencyKey)
      .digest("hex");
    const existingOperations = await tx
      .select()
      .from(billingProviderOperations)
      .where(
        and(
          eq(billingProviderOperations.mode, input.mode),
          eq(billingProviderOperations.operationType, "create_payment"),
          eq(billingProviderOperations.operationKey, input.intentId)
        )
      )
      .limit(1)
      .for("update");
    const existing = existingOperations[0];
    if (existing) {
      if (
        existing.state !== "known_failed" ||
        existing.firstStartedAt ||
        existing.requestFingerprint !== requestFingerprint ||
        existing.billingProfileVersion !== input.billingProfileVersion ||
        existing.authorizationEpoch !== input.authorizationEpoch ||
        existing.credentialGenerationId !== credentialGenerationId ||
        existing.idempotencyKeyHash !== idempotencyKeyHash
      ) {
        return { claimed: false };
      }
      const resumed = await tx
        .update(billingProviderOperations)
        .set({
          state: "reserved",
          leaseToken,
          leaseUntil: new Date(now.getTime() + 60_000),
          resolutionDueAt: new Date(now.getTime() + 5 * 60_000),
        })
        .where(
          and(
            eq(billingProviderOperations.operationId, existing.operationId),
            eq(billingProviderOperations.state, "known_failed")
          )
        );
      if (providerOperationAffectedRows(resumed) !== 1) {
        return { claimed: false };
      }
      await tx
        .update(billingIntents)
        .set({ status: "creating_payment" })
        .where(
          and(
            eq(billingIntents.intentId, input.intentId),
            eq(billingIntents.status, "created")
          )
        );
      return { claimed: true, operationId: existing.operationId, leaseToken };
    }
    const operationId = randomUUID();
    await tx.insert(billingProviderOperations).values({
      operationId,
      workspaceId: input.workspaceId,
      mode: input.mode,
      operationType: "create_payment",
      operationKey: input.intentId,
      intentId: input.intentId,
      providerCustomerId: input.providerRequest.customerId,
      billingProfileVersion: input.billingProfileVersion,
      authorizationEpoch: input.authorizationEpoch,
      state: "reserved",
      requestFingerprint,
      idempotencyKeyHash,
      credentialGenerationId,
      leaseToken,
      leaseUntil: new Date(now.getTime() + 60_000),
      resolutionDueAt: new Date(now.getTime() + 5 * 60_000),
    });
    await tx
      .update(billingIntents)
      .set({ status: "creating_payment" })
      .where(
        and(
          eq(billingIntents.intentId, input.intentId),
          eq(billingIntents.workspaceId, input.workspaceId),
          eq(billingIntents.mode, input.mode),
          eq(billingIntents.billingProfileVersion, input.billingProfileVersion),
          eq(billingIntents.status, "created")
        )
      );
    return { claimed: true, operationId, leaseToken };
  });
}

export async function resolveDuePaymentProviderOperations(
  workspaceId: number,
  mode: MollieMode,
  now = new Date(),
  limit = 50
): Promise<number> {
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    // Match the emergency-disable order: execution control -> intents ->
    // provider operations. Locking provider operations first would deadlock
    // with disable, which owns the intent locks before it contains operations.
    await tx
      .select({ workspaceId: billingExecutionControls.workspaceId })
      .from(billingExecutionControls)
      .where(
        and(
          eq(billingExecutionControls.workspaceId, workspaceId),
          eq(billingExecutionControls.mode, mode)
        )
      )
      .limit(1)
      .for("update");
    await tx
      .select({ intentId: billingIntents.intentId })
      .from(billingIntents)
      .where(
        and(
          eq(billingIntents.workspaceId, workspaceId),
          eq(billingIntents.mode, mode)
        )
      )
      .orderBy(billingIntents.intentId)
      .for("update");
    const rows = await tx
      .select({
        operationId: billingProviderOperations.operationId,
        intentId: billingProviderOperations.intentId,
        state: billingProviderOperations.state,
        firstStartedAt: billingProviderOperations.firstStartedAt,
      })
      .from(billingProviderOperations)
      .where(
        and(
          eq(billingProviderOperations.workspaceId, workspaceId),
          eq(billingProviderOperations.mode, mode),
          eq(billingProviderOperations.operationType, "create_payment"),
          inArray(billingProviderOperations.state, [
            "reserved",
            "transport_started",
            "ambiguous",
          ]),
          lte(billingProviderOperations.resolutionDueAt, now)
        )
      )
      .orderBy(billingProviderOperations.operationId)
      .limit(Math.max(1, Math.min(100, limit)))
      .for("update");
    for (const row of rows) {
      const safePreTransport = row.state === "reserved" && !row.firstStartedAt;
      await tx
        .update(billingProviderOperations)
        .set({
          state: safePreTransport ? "known_failed" : "reconciliation_only",
        })
        .where(
          and(
            eq(billingProviderOperations.operationId, row.operationId),
            eq(billingProviderOperations.state, row.state)
          )
        );
      await tx
        .update(billingIntents)
        .set({ status: safePreTransport ? "created" : "api_unknown" })
        .where(
          and(
            eq(billingIntents.intentId, row.intentId),
            inArray(billingIntents.status, ["creating_payment", "api_unknown"])
          )
        );
    }
    return rows.length;
  });
}

export async function markPaymentProviderTransportStarted(input: {
  operationId: string;
  leaseToken: string;
  workspaceId: number;
  mode: MollieMode;
  authorizationEpoch: number;
}): Promise<boolean> {
  const database = await getDatabaseOrThrow();
  const now = new Date();
  return database.transaction(async tx => {
    const controls = await tx
      .select({
        commercialEnabled: billingExecutionControls.commercialEnabled,
        authorizationEpoch: billingExecutionControls.authorizationEpoch,
      })
      .from(billingExecutionControls)
      .where(
        and(
          eq(billingExecutionControls.workspaceId, input.workspaceId),
          eq(billingExecutionControls.mode, input.mode)
        )
      )
      .limit(1)
      .for("update");
    if (
      !controls[0]?.commercialEnabled ||
      controls[0].authorizationEpoch !== input.authorizationEpoch
    ) {
      return false;
    }
    const result = await tx
      .update(billingProviderOperations)
      .set({
        state: "transport_started",
        firstStartedAt: now,
        retryBefore: new Date(now.getTime() + 55 * 60_000),
        resolutionDueAt: new Date(now.getTime() + 5 * 60_000),
        attemptCount: sql`${billingProviderOperations.attemptCount} + 1`,
      })
      .where(
        and(
          eq(billingProviderOperations.operationId, input.operationId),
          eq(billingProviderOperations.workspaceId, input.workspaceId),
          eq(billingProviderOperations.mode, input.mode),
          eq(
            billingProviderOperations.authorizationEpoch,
            input.authorizationEpoch
          ),
          eq(billingProviderOperations.leaseToken, input.leaseToken),
          eq(billingProviderOperations.state, "reserved"),
          gt(billingProviderOperations.leaseUntil, now)
        )
      );
    return providerOperationAffectedRows(result) === 1;
  });
}

export async function finalizePaymentProviderOperation(input: {
  operationId: string;
  leaseToken: string;
  outcome: "succeeded" | "ambiguous";
  providerResourceId?: string;
  workspaceId: number;
  mode: MollieMode;
  authorizationEpoch: number;
  intentId: string;
  targetCustomerId?: string;
}): Promise<{
  recorded: boolean;
  authorized: boolean;
  revokedAuthorizationEpoch: number | null;
}> {
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const controls = await tx
      .select({
        commercialEnabled: billingExecutionControls.commercialEnabled,
        authorizationEpoch: billingExecutionControls.authorizationEpoch,
      })
      .from(billingExecutionControls)
      .where(
        and(
          eq(billingExecutionControls.workspaceId, input.workspaceId),
          eq(billingExecutionControls.mode, input.mode)
        )
      )
      .limit(1)
      .for("update");
    const authorized = Boolean(
      controls[0]?.commercialEnabled &&
      controls[0].authorizationEpoch === input.authorizationEpoch
    );
    const operations = await tx
      .select({
        operationType: billingProviderOperations.operationType,
        intentId: billingProviderOperations.intentId,
      })
      .from(billingProviderOperations)
      .where(
        and(
          eq(billingProviderOperations.operationId, input.operationId),
          eq(billingProviderOperations.workspaceId, input.workspaceId),
          eq(billingProviderOperations.mode, input.mode),
          eq(
            billingProviderOperations.authorizationEpoch,
            input.authorizationEpoch
          ),
          eq(billingProviderOperations.leaseToken, input.leaseToken),
          eq(billingProviderOperations.state, "transport_started")
        )
      )
      .limit(1)
      .for("update");
    if (!operations[0] || operations[0].intentId !== input.intentId) {
      return {
        recorded: false,
        authorized: false,
        revokedAuthorizationEpoch: null,
      };
    }
    const result = await tx
      .update(billingProviderOperations)
      .set({
        state: authorized
          ? input.outcome
          : input.providerResourceId
            ? "contained"
            : "reconciliation_only",
        providerResourceId: input.providerResourceId ?? null,
        completedAt: input.outcome === "succeeded" ? new Date() : null,
        resolutionDueAt: new Date(),
      })
      .where(
        and(
          eq(billingProviderOperations.operationId, input.operationId),
          eq(billingProviderOperations.workspaceId, input.workspaceId),
          eq(billingProviderOperations.mode, input.mode),
          eq(
            billingProviderOperations.authorizationEpoch,
            input.authorizationEpoch
          ),
          eq(billingProviderOperations.leaseToken, input.leaseToken),
          eq(billingProviderOperations.state, "transport_started")
        )
      );
    const recorded = providerOperationAffectedRows(result) === 1;
    if (recorded && !authorized) {
      await tx
        .update(billingIntents)
        .set({ status: "contained" })
        .where(
          and(
            eq(billingIntents.intentId, input.intentId),
            eq(billingIntents.workspaceId, input.workspaceId),
            eq(billingIntents.mode, input.mode),
            eq(billingIntents.authorizationEpoch, input.authorizationEpoch),
            inArray(billingIntents.status, [
              "created",
              "creating_payment",
              "open",
              "api_unknown",
            ])
          )
        );
      if (
        operations[0].operationType === "create_payment" &&
        input.providerResourceId &&
        input.targetCustomerId
      ) {
        await tx
          .insert(billingOutbox)
          .values({
            workspaceId: input.workspaceId,
            mode: input.mode,
            eventType: "cancel_payment",
            deduplicationKey: `execution_disabled_payment:${input.providerResourceId}`,
            payload: {
              reason: "billing_execution_disabled",
              intentId: input.intentId,
              targetCustomerId: input.targetCustomerId,
              targetPaymentId: input.providerResourceId,
              revokedAuthorizationEpoch: input.authorizationEpoch,
            },
            status: "pending",
          })
          .onDuplicateKeyUpdate({
            set: { deduplicationKey: sql`deduplication_key` },
          });
      } else {
        if (
          operations[0].operationType === "create_payment" &&
          input.targetCustomerId
        ) {
          await tx
            .insert(billingOutbox)
            .values({
              workspaceId: input.workspaceId,
              mode: input.mode,
              eventType: "cancel_payment",
              deduplicationKey: `payment_ambiguous_reconcile:${input.operationId}`,
              payload: {
                reason: "billing_execution_disabled",
                intentId: input.intentId,
                targetCustomerId: input.targetCustomerId,
                targetPaymentId: null,
                providerOperationId: input.operationId,
                revokedAuthorizationEpoch: input.authorizationEpoch,
              },
              status: "pending",
            })
            .onDuplicateKeyUpdate({
              set: { deduplicationKey: sql`deduplication_key` },
            });
        }
        await tx
          .insert(billingOutbox)
          .values({
            workspaceId: input.workspaceId,
            mode: input.mode,
            eventType: "manual_review",
            deduplicationKey: `provider_ambiguous_after_disable:${input.operationId}`,
            payload: {
              reason:
                operations[0].operationType === "create_payment"
                  ? "payment_provider_ambiguous_after_disable"
                  : "billing_customer_created_after_disable",
              intentId: input.intentId,
            },
            status: "pending",
          })
          .onDuplicateKeyUpdate({
            set: { deduplicationKey: sql`deduplication_key` },
          });
      }
    }
    return {
      recorded,
      authorized: recorded && authorized,
      revokedAuthorizationEpoch:
        recorded && !authorized ? input.authorizationEpoch : null,
    };
  });
}

function providerOperationAffectedRows(result: unknown): number {
  const metadata: unknown = Array.isArray(result)
    ? (result as unknown[])[0]
    : result;
  return Number(
    (metadata as { affectedRows?: number } | undefined)?.affectedRows ?? 0
  );
}

export async function attachMolliePayment(input: {
  intentId: string;
  workspaceId: number;
  mode: MollieMode;
  molliePaymentId: string;
  billingProfileVersion: number;
  authorizationEpoch: number;
  operationId: string;
  targetCustomerId: string;
}): Promise<boolean> {
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const controls = await tx
      .select({
        commercialEnabled: billingExecutionControls.commercialEnabled,
        authorizationEpoch: billingExecutionControls.authorizationEpoch,
      })
      .from(billingExecutionControls)
      .where(
        and(
          eq(billingExecutionControls.workspaceId, input.workspaceId),
          eq(billingExecutionControls.mode, input.mode)
        )
      )
      .limit(1)
      .for("update");
    const profiles = await tx
      .select()
      .from(workspaceBillingProfiles)
      .where(eq(workspaceBillingProfiles.workspaceId, input.workspaceId))
      .limit(1)
      .for("update");
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
    await tx
      .insert(billingWebhookRoutes)
      .values({
        mode: input.mode,
        molliePaymentId: input.molliePaymentId,
        workspaceId: input.workspaceId,
        intentId: input.intentId,
      })
      .onDuplicateKeyUpdate({
        set: { molliePaymentId: sql`mollie_payment_id` },
      });
    const routes = await tx
      .select({
        workspaceId: billingWebhookRoutes.workspaceId,
        intentId: billingWebhookRoutes.intentId,
      })
      .from(billingWebhookRoutes)
      .where(
        and(
          eq(billingWebhookRoutes.mode, input.mode),
          eq(billingWebhookRoutes.molliePaymentId, input.molliePaymentId)
        )
      )
      .limit(1)
      .for("update");
    if (
      routes[0]?.workspaceId !== input.workspaceId ||
      routes[0]?.intentId !== input.intentId
    ) {
      throw new Error("Mollie webhook route ownership conflict");
    }
    // Keep the global billing mutation order control/profile/intent ->
    // scheduler -> provider operation -> outbox. The outbox wake trigger also
    // locks this scheduler row, so acquiring it explicitly prevents an
    // execution-disable/provider-result deadlock.
    await tx
      .select({ kind: billingSchedulerTenants.kind })
      .from(billingSchedulerTenants)
      .where(
        and(
          eq(billingSchedulerTenants.workspaceId, input.workspaceId),
          eq(billingSchedulerTenants.mode, input.mode),
          eq(billingSchedulerTenants.kind, "outbox")
        )
      )
      .limit(1)
      .for("update");
    if (
      !controls[0]?.commercialEnabled ||
      controls[0].authorizationEpoch !== input.authorizationEpoch ||
      !isBillingProfileVersionEligible(
        profiles[0],
        input.billingProfileVersion,
        new Date()
      ) ||
      intent.billingProfileVersion !== input.billingProfileVersion
    ) {
      const operationUpdate = await tx
        .update(billingProviderOperations)
        .set({ state: "contained", resolutionDueAt: new Date() })
        .where(
          and(
            eq(billingProviderOperations.operationId, input.operationId),
            eq(billingProviderOperations.workspaceId, input.workspaceId),
            eq(billingProviderOperations.mode, input.mode),
            eq(billingProviderOperations.operationType, "create_payment"),
            eq(billingProviderOperations.intentId, input.intentId),
            eq(
              billingProviderOperations.authorizationEpoch,
              input.authorizationEpoch
            ),
            eq(
              billingProviderOperations.providerResourceId,
              input.molliePaymentId
            ),
            eq(
              billingProviderOperations.providerCustomerId,
              input.targetCustomerId
            ),
            eq(billingProviderOperations.state, "succeeded")
          )
        );
      await tx
        .update(billingIntents)
        .set({
          status: "contained",
          molliePaymentId: input.molliePaymentId,
        })
        .where(
          and(
            eq(billingIntents.intentId, input.intentId),
            eq(billingIntents.workspaceId, input.workspaceId),
            eq(billingIntents.mode, input.mode)
          )
        );
      await tx
        .insert(billingOutbox)
        .values({
          workspaceId: input.workspaceId,
          mode: input.mode,
          eventType: "manual_review",
          deduplicationKey: `profile_contained_payment:${input.molliePaymentId}`,
          payload: {
            reason: "billing_profile_changed_during_payment_creation",
            intentId: input.intentId,
          },
          status: "pending",
        })
        .onDuplicateKeyUpdate({
          set: { deduplicationKey: sql`deduplication_key` },
        });
      await tx
        .insert(billingOutbox)
        .values({
          workspaceId: input.workspaceId,
          mode: input.mode,
          eventType: "cancel_payment",
          deduplicationKey: `profile_contained_payment_cancel:${input.molliePaymentId}`,
          payload: {
            reason: "billing_profile_ineligible_after_provider_response",
            intentId: input.intentId,
            targetCustomerId: input.targetCustomerId,
            targetPaymentId: input.molliePaymentId,
            revokedAuthorizationEpoch: input.authorizationEpoch,
            ...(providerOperationAffectedRows(operationUpdate) === 1
              ? {}
              : { providerOperationId: input.operationId }),
          },
          status: "pending",
        })
        .onDuplicateKeyUpdate({
          set: { deduplicationKey: sql`deduplication_key` },
        });
      return false;
    }
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

export async function resolveMollieWebhookWorkspace(
  mode: MollieMode,
  molliePaymentId: string,
  intentId: string
): Promise<number | null> {
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const existingRoutes = await tx
      .select({
        workspaceId: billingWebhookRoutes.workspaceId,
        intentId: billingWebhookRoutes.intentId,
      })
      .from(billingWebhookRoutes)
      .where(
        and(
          eq(billingWebhookRoutes.mode, mode),
          eq(billingWebhookRoutes.molliePaymentId, molliePaymentId)
        )
      )
      .limit(1)
      .for("update");
    if (existingRoutes[0]) {
      return existingRoutes[0].intentId === intentId
        ? existingRoutes[0].workspaceId
        : null;
    }

    // The provider metadata contains our globally unique opaque intent id. It
    // is used only to establish the tenant boundary; no customer payload is
    // read before the exact workspace is known.
    const intents = await tx
      .select({
        workspaceId: billingIntents.workspaceId,
        molliePaymentId: billingIntents.molliePaymentId,
      })
      .from(billingIntents)
      .where(
        and(
          eq(billingIntents.intentId, intentId),
          eq(billingIntents.mode, mode)
        )
      )
      .limit(1)
      .for("update");
    const intent = intents[0];
    if (
      !intent ||
      (intent.molliePaymentId && intent.molliePaymentId !== molliePaymentId)
    ) {
      return null;
    }
    await tx
      .insert(billingWebhookRoutes)
      .values({
        mode,
        molliePaymentId,
        workspaceId: intent.workspaceId,
        intentId,
      })
      .onDuplicateKeyUpdate({
        set: { molliePaymentId: sql`mollie_payment_id` },
      });
    const routes = await tx
      .select({
        workspaceId: billingWebhookRoutes.workspaceId,
        intentId: billingWebhookRoutes.intentId,
      })
      .from(billingWebhookRoutes)
      .where(
        and(
          eq(billingWebhookRoutes.mode, mode),
          eq(billingWebhookRoutes.molliePaymentId, molliePaymentId)
        )
      )
      .limit(1)
      .for("update");
    return routes[0]?.intentId === intentId
      ? (routes[0]?.workspaceId ?? null)
      : null;
  });
}

export async function isCheckoutUrlExposureAllowed(input: {
  intentId: string;
  workspaceId: number;
  mode: MollieMode;
  molliePaymentId: string;
  billingProfileVersion: number;
  authorizationEpoch: number;
}): Promise<boolean> {
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const controls = await tx
      .select({
        commercialEnabled: billingExecutionControls.commercialEnabled,
        authorizationEpoch: billingExecutionControls.authorizationEpoch,
      })
      .from(billingExecutionControls)
      .where(
        and(
          eq(billingExecutionControls.workspaceId, input.workspaceId),
          eq(billingExecutionControls.mode, input.mode)
        )
      )
      .limit(1)
      .for("update");
    if (
      !controls[0]?.commercialEnabled ||
      controls[0].authorizationEpoch !== input.authorizationEpoch
    ) {
      return false;
    }
    const profiles = await tx
      .select()
      .from(workspaceBillingProfiles)
      .where(eq(workspaceBillingProfiles.workspaceId, input.workspaceId))
      .limit(1)
      .for("update");
    if (
      !isBillingProfileVersionEligible(
        profiles[0],
        input.billingProfileVersion,
        new Date()
      )
    ) {
      return false;
    }
    const intents = await tx
      .select({
        status: billingIntents.status,
        molliePaymentId: billingIntents.molliePaymentId,
        billingProfileVersion: billingIntents.billingProfileVersion,
        authorizationEpoch: billingIntents.authorizationEpoch,
      })
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
    const operations = await tx
      .select({
        state: billingProviderOperations.state,
        providerResourceId: billingProviderOperations.providerResourceId,
        authorizationEpoch: billingProviderOperations.authorizationEpoch,
      })
      .from(billingProviderOperations)
      .where(
        and(
          eq(billingProviderOperations.workspaceId, input.workspaceId),
          eq(billingProviderOperations.mode, input.mode),
          eq(billingProviderOperations.operationType, "create_payment"),
          eq(billingProviderOperations.operationKey, input.intentId)
        )
      )
      .limit(1)
      .for("update");
    const allowed = Boolean(
      intents[0]?.status === "open" &&
      intents[0].molliePaymentId === input.molliePaymentId &&
      intents[0].billingProfileVersion === input.billingProfileVersion &&
      intents[0].authorizationEpoch === input.authorizationEpoch &&
      operations[0]?.state === "succeeded" &&
      operations[0].providerResourceId === input.molliePaymentId &&
      operations[0].authorizationEpoch === input.authorizationEpoch
    );
    if (allowed) {
      await tx
        .update(billingIntents)
        .set({
          urlExposedAt: sql`COALESCE(${billingIntents.urlExposedAt}, NOW())`,
        })
        .where(
          and(
            eq(billingIntents.intentId, input.intentId),
            eq(billingIntents.workspaceId, input.workspaceId),
            eq(billingIntents.mode, input.mode),
            eq(billingIntents.status, "open"),
            eq(billingIntents.molliePaymentId, input.molliePaymentId),
            eq(
              billingIntents.billingProfileVersion,
              input.billingProfileVersion
            ),
            eq(billingIntents.authorizationEpoch, input.authorizationEpoch)
          )
        );
    }
    return allowed;
  });
}

function isBillingProfileVersionEligible(
  profile: typeof workspaceBillingProfiles.$inferSelect | undefined,
  expectedVersion: number,
  now: Date
): boolean {
  return Boolean(
    profile &&
    profile.eligibilityVersion === expectedVersion &&
    profile.verificationStatus === "verified" &&
    profile.countryCode === "BE" &&
    profile.customerType === "consumer" &&
    !profile.peppolReady &&
    profile.verifiedAt &&
    profile.verifiedAt <= now &&
    profile.verificationExpiresAt &&
    profile.verificationExpiresAt > now &&
    !profile.revokedAt
  );
}

export async function markIntentApiUnknown(intentId: string): Promise<void> {
  const database = await getDatabaseOrThrow();
  await database.transaction(async tx => {
    const intents = await tx
      .select({
        workspaceId: billingIntents.workspaceId,
        mode: billingIntents.mode,
      })
      .from(billingIntents)
      .where(eq(billingIntents.intentId, intentId))
      .limit(1)
      .for("update");
    if (!intents[0]) return;
    await tx
      .update(billingIntents)
      .set({ status: "api_unknown" })
      .where(
        and(
          eq(billingIntents.intentId, intentId),
          eq(billingIntents.status, "creating_payment")
        )
      );
    await tx
      .update(billingSchedulerTenants)
      .set({ nextDueAt: new Date() })
      .where(
        and(
          eq(billingSchedulerTenants.workspaceId, intents[0].workspaceId),
          eq(billingSchedulerTenants.mode, intents[0].mode),
          eq(billingSchedulerTenants.kind, "reconciliation"),
          eq(billingSchedulerTenants.enabled, true)
        )
      );
  });
}

export async function markIntentPaymentMismatch(input: {
  intentId: string;
  workspaceId: number;
  mode: MollieMode;
  molliePaymentId: string | null;
  operationId: string;
  authorizationEpoch: number;
  targetCustomerId: string;
}): Promise<void> {
  const database = await getDatabaseOrThrow();
  await database.transaction(async tx => {
    await tx
      .select({
        authorizationEpoch: billingExecutionControls.authorizationEpoch,
      })
      .from(billingExecutionControls)
      .where(
        and(
          eq(billingExecutionControls.workspaceId, input.workspaceId),
          eq(billingExecutionControls.mode, input.mode)
        )
      )
      .limit(1)
      .for("update");
    await tx
      .select({ intentId: billingIntents.intentId })
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
    await tx
      .select({ kind: billingSchedulerTenants.kind })
      .from(billingSchedulerTenants)
      .where(
        and(
          eq(billingSchedulerTenants.workspaceId, input.workspaceId),
          eq(billingSchedulerTenants.mode, input.mode),
          eq(billingSchedulerTenants.kind, "outbox")
        )
      )
      .limit(1)
      .for("update");
    const operationUpdate = await tx
      .update(billingProviderOperations)
      .set({
        state: input.molliePaymentId ? "contained" : "reconciliation_only",
        providerResourceId: input.molliePaymentId,
        resolutionDueAt: new Date(),
      })
      .where(
        and(
          eq(billingProviderOperations.operationId, input.operationId),
          eq(billingProviderOperations.workspaceId, input.workspaceId),
          eq(billingProviderOperations.mode, input.mode),
          eq(billingProviderOperations.operationType, "create_payment"),
          eq(billingProviderOperations.intentId, input.intentId),
          eq(
            billingProviderOperations.authorizationEpoch,
            input.authorizationEpoch
          ),
          eq(
            billingProviderOperations.providerCustomerId,
            input.targetCustomerId
          ),
          eq(billingProviderOperations.state, "succeeded")
        )
      );
    const operationRecorded =
      providerOperationAffectedRows(operationUpdate) === 1;
    await tx
      .update(billingIntents)
      .set({
        status: "mismatch",
        molliePaymentId: input.molliePaymentId,
      })
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
    if (operationRecorded) {
      await tx
        .insert(billingOutbox)
        .values({
          workspaceId: input.workspaceId,
          mode: input.mode,
          eventType: "cancel_payment",
          deduplicationKey: input.molliePaymentId
            ? `checkout_response_mismatch_cancel:${input.molliePaymentId}`
            : `checkout_response_mismatch_reconcile:${input.operationId}`,
          payload: {
            reason: "checkout_provider_response_mismatch",
            intentId: input.intentId,
            targetCustomerId: input.targetCustomerId,
            targetPaymentId: input.molliePaymentId,
            providerOperationId: input.operationId,
            revokedAuthorizationEpoch: input.authorizationEpoch,
            operationRecorded: true,
          },
          status: "pending",
        })
        .onDuplicateKeyUpdate({
          set: { deduplicationKey: sql`deduplication_key` },
        });
    }
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
