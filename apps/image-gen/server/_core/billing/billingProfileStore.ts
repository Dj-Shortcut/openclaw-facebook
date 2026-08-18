import { createHash, createHmac } from "node:crypto";
import { and, eq, inArray, lte, sql } from "drizzle-orm";

import {
  auditLog,
  billingIntents,
  billingOutbox,
  billingProviderOperations,
  billingProfileOperatorActions,
  billingSchedulerTenants,
  billingSubscriptions,
  users,
  workspaceEntitlements,
  workspaceBillingProfiles,
} from "../../../drizzle/schema";
import { getDatabaseOrThrow } from "../../db";

export class BillingProfileEligibilityError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BillingProfileEligibilityError";
  }
}

export async function assertWorkspaceBillingProfileEligible(
  workspaceId: number,
  now = new Date()
): Promise<{ eligibilityVersion: number }> {
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) {
    throw new BillingProfileEligibilityError(
      "billing_profile_invalid_workspace"
    );
  }
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({
      workspaceId: workspaceBillingProfiles.workspaceId,
      countryCode: workspaceBillingProfiles.countryCode,
      customerType: workspaceBillingProfiles.customerType,
      verificationStatus: workspaceBillingProfiles.verificationStatus,
      verificationMethod: workspaceBillingProfiles.verificationMethod,
      evidenceReferenceHash: workspaceBillingProfiles.evidenceReferenceHash,
      verifiedAt: workspaceBillingProfiles.verifiedAt,
      verificationExpiresAt: workspaceBillingProfiles.verificationExpiresAt,
      revokedAt: workspaceBillingProfiles.revokedAt,
      verifiedByUserId: workspaceBillingProfiles.verifiedByUserId,
      peppolReady: workspaceBillingProfiles.peppolReady,
      eligibilityVersion: workspaceBillingProfiles.eligibilityVersion,
    })
    .from(workspaceBillingProfiles)
    .where(eq(workspaceBillingProfiles.workspaceId, workspaceId))
    .limit(2);
  if (rows.length !== 1) {
    throw new BillingProfileEligibilityError("billing_profile_missing");
  }
  const profile = rows[0];
  if (profile.workspaceId !== workspaceId) {
    throw new BillingProfileEligibilityError("billing_profile_tenant_boundary");
  }
  if (
    profile.verificationStatus !== "verified" ||
    !profile.verificationMethod ||
    !profile.evidenceReferenceHash ||
    !profile.verifiedAt ||
    !profile.verifiedByUserId ||
    profile.revokedAt ||
    !profile.verificationExpiresAt ||
    profile.verifiedAt.getTime() > now.getTime() ||
    profile.verificationExpiresAt.getTime() <= now.getTime()
  ) {
    throw new BillingProfileEligibilityError("billing_profile_unverified");
  }
  if (profile.countryCode !== "BE") {
    throw new BillingProfileEligibilityError("billing_country_not_eligible");
  }
  if (profile.customerType === "business" || profile.peppolReady) {
    throw new BillingProfileEligibilityError("b2b_checkout_disabled");
  }
  if (
    !Number.isSafeInteger(profile.eligibilityVersion) ||
    profile.eligibilityVersion <= 0
  ) {
    throw new BillingProfileEligibilityError("billing_profile_unverified");
  }
  return { eligibilityVersion: profile.eligibilityVersion };
}

export async function attestWorkspaceBillingProfile(input: {
  requestId: string;
  workspaceId: number;
  actorUserId: number;
  expectedVersion: number;
  countryCode: string;
  customerType: "consumer" | "business";
  evidenceReference: string;
  verificationMethod: "manual_legal_review" | "provider_attestation";
  expiresAt: Date;
  peppolReady?: boolean;
  now?: Date;
}): Promise<{ eligibilityVersion: number }> {
  const now = input.now ?? new Date();
  const evidenceReference = input.evidenceReference.trim();
  const evidenceSecret =
    process.env.BILLING_PROFILE_EVIDENCE_HMAC_SECRET?.trim();
  if (
    !Number.isSafeInteger(input.workspaceId) ||
    !Number.isSafeInteger(input.actorUserId) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.workspaceId <= 0 ||
    input.actorUserId <= 0 ||
    input.expectedVersion < 0 ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.requestId
    ) ||
    !/^[A-Z]{2}$/.test(input.countryCode) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,255}$/.test(evidenceReference) ||
    !evidenceSecret ||
    evidenceSecret.length < 32 ||
    input.expiresAt.getTime() <= now.getTime() ||
    input.expiresAt.getTime() > now.getTime() + 366 * 24 * 60 * 60_000
  ) {
    throw new BillingProfileEligibilityError(
      "billing_profile_attestation_invalid"
    );
  }
  const database = await getDatabaseOrThrow();
  const evidenceReferenceHash = `hmac-sha256:${createHmac(
    "sha256",
    evidenceSecret
  )
    .update(evidenceReference)
    .digest("hex")}`;
  const requestFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        expectedVersion: input.expectedVersion,
        countryCode: input.countryCode,
        customerType: input.customerType,
        evidenceReferenceHash,
        verificationMethod: input.verificationMethod,
        expiresAt: input.expiresAt.toISOString(),
        peppolReady: input.peppolReady ?? false,
      })
    )
    .digest("hex");
  return database.transaction(async tx => {
    const actors = await tx
      .select({ userId: users.id })
      .from(users)
      .where(and(eq(users.id, input.actorUserId), eq(users.role, "admin")))
      .limit(1)
      .for("update");
    if (!actors[0]) {
      throw new BillingProfileEligibilityError(
        "billing_profile_actor_forbidden"
      );
    }
    const repeated = await findOperatorAction(tx, input.requestId);
    if (repeated) {
      assertMatchingOperatorReplay(
        repeated,
        input,
        "attest",
        requestFingerprint
      );
      return { eligibilityVersion: repeated.resultingVersion };
    }
    await tx
      .insert(workspaceBillingProfiles)
      .values({
        workspaceId: input.workspaceId,
        countryCode: input.countryCode,
        customerType: input.customerType,
        verificationStatus: "unverified",
        peppolReady: false,
        eligibilityVersion: 0,
      })
      .onDuplicateKeyUpdate({ set: { workspaceId: input.workspaceId } });
    const profiles = await tx
      .select({
        id: workspaceBillingProfiles.id,
        eligibilityVersion: workspaceBillingProfiles.eligibilityVersion,
        verificationStatus: workspaceBillingProfiles.verificationStatus,
      })
      .from(workspaceBillingProfiles)
      .where(eq(workspaceBillingProfiles.workspaceId, input.workspaceId))
      .limit(1)
      .for("update");
    if (!profiles[0]) throw new Error("billing profile upsert failed");
    if (profiles[0].eligibilityVersion !== input.expectedVersion) {
      throw new BillingProfileEligibilityError(
        "billing_profile_version_conflict"
      );
    }
    const liveSubscriptions = await tx
      .select({ id: billingSubscriptions.id })
      .from(billingSubscriptions)
      .where(
        and(
          eq(billingSubscriptions.workspaceId, input.workspaceId),
          inArray(billingSubscriptions.status, [
            "provisioning",
            "active",
            "past_due",
            "manual_review",
          ])
        )
      )
      .limit(1)
      .for("update");
    if (liveSubscriptions[0]) {
      throw new BillingProfileEligibilityError(
        "billing_profile_live_subscription_requires_containment"
      );
    }
    const resultingVersion = input.expectedVersion + 1;
    await tx
      .update(workspaceBillingProfiles)
      .set({
        countryCode: input.countryCode,
        customerType: input.customerType,
        verificationStatus: "verified",
        verificationMethod: input.verificationMethod,
        evidenceReferenceHash,
        verifiedAt: now,
        verificationExpiresAt: input.expiresAt,
        revokedAt: null,
        verifiedByUserId: input.actorUserId,
        peppolReady: input.peppolReady ?? false,
        eligibilityVersion: resultingVersion,
      })
      .where(
        and(
          eq(workspaceBillingProfiles.id, profiles[0].id),
          eq(workspaceBillingProfiles.eligibilityVersion, input.expectedVersion)
        )
      );
    await tx.insert(billingProfileOperatorActions).values({
      requestId: input.requestId,
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      action: "attest",
      expectedVersion: input.expectedVersion,
      resultingVersion,
      requestFingerprint,
      reason: input.verificationMethod,
    });
    await tx.insert(auditLog).values({
      workspaceId: input.workspaceId,
      userId: input.actorUserId,
      event: "billing_profile.attested",
      metadata: {
        actorKind: "platform_admin",
        verificationMethod: input.verificationMethod,
        evidenceReferenceStoredAsHash: true,
        requestId: input.requestId,
        oldVersion: input.expectedVersion,
        newVersion: resultingVersion,
        oldStatus: profiles[0].verificationStatus,
        newStatus: "verified",
        expiresAt: input.expiresAt.toISOString(),
      },
    });
    await tx
      .update(billingSchedulerTenants)
      .set({ nextDueAt: input.expiresAt })
      .where(
        and(
          eq(billingSchedulerTenants.workspaceId, input.workspaceId),
          eq(billingSchedulerTenants.kind, "profile_expiry"),
          eq(billingSchedulerTenants.enabled, true)
        )
      );
    return { eligibilityVersion: resultingVersion };
  });
}

export async function revokeWorkspaceBillingProfile(input: {
  requestId: string;
  workspaceId: number;
  actorUserId: number;
  expectedVersion: number;
  reason: string;
  now?: Date;
}): Promise<{ eligibilityVersion: number }> {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      input.requestId
    ) ||
    !Number.isSafeInteger(input.expectedVersion) ||
    input.expectedVersion <= 0 ||
    !/^[A-Za-z0-9][A-Za-z0-9 _./:-]{7,159}$/.test(input.reason)
  ) {
    throw new BillingProfileEligibilityError(
      "billing_profile_revocation_invalid"
    );
  }
  const database = await getDatabaseOrThrow();
  const now = input.now ?? new Date();
  const requestFingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        workspaceId: input.workspaceId,
        actorUserId: input.actorUserId,
        expectedVersion: input.expectedVersion,
        reason: input.reason,
      })
    )
    .digest("hex");
  return database.transaction(async tx => {
    const actors = await tx
      .select({ userId: users.id })
      .from(users)
      .where(and(eq(users.id, input.actorUserId), eq(users.role, "admin")))
      .limit(1)
      .for("update");
    if (!actors[0]) {
      throw new BillingProfileEligibilityError(
        "billing_profile_actor_forbidden"
      );
    }
    const repeated = await findOperatorAction(tx, input.requestId);
    if (repeated) {
      assertMatchingOperatorReplay(
        repeated,
        input,
        "revoke",
        requestFingerprint
      );
      return { eligibilityVersion: repeated.resultingVersion };
    }
    const profiles = await tx
      .select({
        evidenceReferenceHash: workspaceBillingProfiles.evidenceReferenceHash,
        eligibilityVersion: workspaceBillingProfiles.eligibilityVersion,
        verificationStatus: workspaceBillingProfiles.verificationStatus,
      })
      .from(workspaceBillingProfiles)
      .where(eq(workspaceBillingProfiles.workspaceId, input.workspaceId))
      .limit(1)
      .for("update");
    if (!profiles[0]) {
      throw new BillingProfileEligibilityError("billing_profile_missing");
    }
    if (profiles[0].eligibilityVersion !== input.expectedVersion) {
      throw new BillingProfileEligibilityError(
        "billing_profile_version_conflict"
      );
    }
    const resultingVersion = input.expectedVersion + 1;
    await tx
      .update(workspaceBillingProfiles)
      .set({
        verificationStatus: "revoked",
        revokedAt: now,
        eligibilityVersion: resultingVersion,
      })
      .where(
        and(
          eq(workspaceBillingProfiles.workspaceId, input.workspaceId),
          eq(workspaceBillingProfiles.eligibilityVersion, input.expectedVersion)
        )
      );
    const paymentIntents = await tx
      .select({
        intentId: billingIntents.intentId,
        mode: billingIntents.mode,
        molliePaymentId: billingIntents.molliePaymentId,
      })
      .from(billingIntents)
      .where(
        and(
          eq(billingIntents.workspaceId, input.workspaceId),
          inArray(billingIntents.status, ["open", "api_unknown"])
        )
      )
      .for("update");
    await tx
      .update(billingIntents)
      .set({ status: "contained" })
      .where(
        and(
          eq(billingIntents.workspaceId, input.workspaceId),
          inArray(billingIntents.status, [
            "created",
            "creating_payment",
            "open",
            "api_unknown",
          ])
        )
      );
    await tx
      .update(billingProviderOperations)
      .set({ state: "contained", resolutionDueAt: now })
      .where(
        and(
          eq(billingProviderOperations.workspaceId, input.workspaceId),
          eq(billingProviderOperations.state, "reserved")
        )
      );
    for (const intent of paymentIntents) {
      if (!intent.molliePaymentId) continue;
      await tx
        .insert(billingOutbox)
        .values({
          workspaceId: input.workspaceId,
          mode: intent.mode,
          eventType: "cancel_payment",
          deduplicationKey: `profile_revoked_payment_cancel:${intent.molliePaymentId}`,
          payload: {
            reason: "billing_profile_revoked",
            intentId: intent.intentId,
            targetPaymentId: intent.molliePaymentId,
          },
          status: "pending",
        })
        .onDuplicateKeyUpdate({
          set: { deduplicationKey: sql`deduplication_key` },
        });
    }
    await tx
      .update(billingOutbox)
      .set({
        status: "failed",
        leaseToken: null,
        lockedAt: null,
        lastErrorCode: "billing_profile_revoked",
      })
      .where(
        and(
          eq(billingOutbox.workspaceId, input.workspaceId),
          eq(billingOutbox.eventType, "send_portal_handoff"),
          inArray(billingOutbox.status, ["pending", "processing"])
        )
      );
    await tx
      .update(billingOutbox)
      .set({
        status: "pending",
        leaseToken: null,
        lockedAt: null,
        availableAt: now,
        lastErrorCode: "billing_profile_revoked_containment_required",
      })
      .where(
        and(
          eq(billingOutbox.workspaceId, input.workspaceId),
          eq(billingOutbox.eventType, "ensure_subscription"),
          inArray(billingOutbox.status, ["pending", "processing", "failed"])
        )
      );
    const subscriptions = await tx
      .select()
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.workspaceId, input.workspaceId))
      .for("update");
    await tx
      .update(billingSubscriptions)
      .set({ status: "manual_review" })
      .where(
        and(
          eq(billingSubscriptions.workspaceId, input.workspaceId),
          inArray(billingSubscriptions.status, [
            "provisioning",
            "active",
            "past_due",
          ])
        )
      );
    for (const subscription of subscriptions) {
      if (
        subscription.mollieCustomerId &&
        subscription.mollieSubscriptionId &&
        ["active", "past_due", "provisioning", "manual_review"].includes(
          subscription.status
        )
      ) {
        await tx
          .insert(billingOutbox)
          .values({
            workspaceId: input.workspaceId,
            mode: subscription.mode,
            eventType: "cancel_subscription",
            deduplicationKey: `profile_revoked_cancel:${subscription.mollieSubscriptionId}`,
            payload: {
              reason: "billing_profile_revoked",
              expectedSourceIntentId: subscription.sourceIntentId,
              targetCustomerId: subscription.mollieCustomerId,
              targetSubscriptionId: subscription.mollieSubscriptionId,
            },
            status: "pending",
          })
          .onDuplicateKeyUpdate({
            set: { deduplicationKey: sql`deduplication_key` },
          });
      }
    }
    await tx
      .update(workspaceEntitlements)
      .set({ status: "manual_review" })
      .where(eq(workspaceEntitlements.workspaceId, input.workspaceId));
    await tx.insert(billingProfileOperatorActions).values({
      requestId: input.requestId,
      workspaceId: input.workspaceId,
      actorUserId: input.actorUserId,
      action: "revoke",
      expectedVersion: input.expectedVersion,
      resultingVersion,
      requestFingerprint,
      reason: input.reason,
    });
    await tx.insert(auditLog).values({
      workspaceId: input.workspaceId,
      userId: input.actorUserId,
      event: "billing_profile.revoked",
      metadata: {
        actorKind: "platform_admin",
        requestId: input.requestId,
        reason: input.reason,
        oldVersion: input.expectedVersion,
        newVersion: resultingVersion,
        oldStatus: profiles[0].verificationStatus,
        newStatus: "revoked",
        evidenceDigestPreserved: Boolean(profiles[0].evidenceReferenceHash),
      },
    });
    await tx
      .update(billingSchedulerTenants)
      .set({
        nextDueAt: sql`LEAST(${billingSchedulerTenants.nextDueAt}, ${now})`,
      })
      .where(
        and(
          eq(billingSchedulerTenants.workspaceId, input.workspaceId),
          eq(billingSchedulerTenants.kind, "outbox"),
          eq(billingSchedulerTenants.enabled, true)
        )
      );
    return { eligibilityVersion: resultingVersion };
  });
}

/** Scheduler-owned expiry transition. It contains paid effects before remote reconciliation. */
export async function expireWorkspaceBillingProfileIfDue(
  workspaceId: number,
  now = new Date()
): Promise<boolean> {
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    const profiles = await tx
      .select({
        eligibilityVersion: workspaceBillingProfiles.eligibilityVersion,
        verificationExpiresAt: workspaceBillingProfiles.verificationExpiresAt,
      })
      .from(workspaceBillingProfiles)
      .where(
        and(
          eq(workspaceBillingProfiles.workspaceId, workspaceId),
          eq(workspaceBillingProfiles.verificationStatus, "verified"),
          lte(workspaceBillingProfiles.verificationExpiresAt, now)
        )
      )
      .limit(1)
      .for("update");
    const profile = profiles[0];
    if (!profile?.verificationExpiresAt) return false;
    const resultingVersion = profile.eligibilityVersion + 1;
    const profileUpdate = await tx
      .update(workspaceBillingProfiles)
      .set({
        verificationStatus: "revoked",
        revokedAt: now,
        eligibilityVersion: resultingVersion,
      })
      .where(
        and(
          eq(workspaceBillingProfiles.workspaceId, workspaceId),
          eq(
            workspaceBillingProfiles.eligibilityVersion,
            profile.eligibilityVersion
          ),
          eq(workspaceBillingProfiles.verificationStatus, "verified")
        )
      );
    if (affectedRows(profileUpdate) !== 1) {
      throw new Error("billing profile expiry fence was lost");
    }

    const intents = await tx
      .select({
        intentId: billingIntents.intentId,
        mode: billingIntents.mode,
        status: billingIntents.status,
        molliePaymentId: billingIntents.molliePaymentId,
      })
      .from(billingIntents)
      .where(eq(billingIntents.workspaceId, workspaceId))
      .for("update");
    const subscriptions = await tx
      .select()
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.workspaceId, workspaceId))
      .for("update");
    await tx
      .update(billingIntents)
      .set({ status: "contained" })
      .where(
        and(
          eq(billingIntents.workspaceId, workspaceId),
          inArray(billingIntents.status, [
            "created",
            "creating_payment",
            "open",
            "api_unknown",
          ])
        )
      );
    await tx
      .update(billingProviderOperations)
      .set({ state: "contained", resolutionDueAt: now })
      .where(
        and(
          eq(billingProviderOperations.workspaceId, workspaceId),
          eq(billingProviderOperations.state, "reserved")
        )
      );
    for (const intent of intents) {
      if (
        !intent.molliePaymentId ||
        (intent.status !== "open" && intent.status !== "api_unknown")
      ) {
        continue;
      }
      await tx
        .insert(billingOutbox)
        .values({
          workspaceId,
          mode: intent.mode,
          eventType: "cancel_payment",
          deduplicationKey: `profile_expired_payment_cancel:${intent.molliePaymentId}`,
          payload: {
            reason: "billing_profile_expired",
            intentId: intent.intentId,
            targetPaymentId: intent.molliePaymentId,
          },
          status: "pending",
        })
        .onDuplicateKeyUpdate({
          set: { deduplicationKey: sql`deduplication_key` },
        });
    }
    await tx
      .update(billingOutbox)
      .set({
        status: "failed",
        leaseToken: null,
        lockedAt: null,
        lastErrorCode: "billing_profile_expired",
      })
      .where(
        and(
          eq(billingOutbox.workspaceId, workspaceId),
          eq(billingOutbox.eventType, "send_portal_handoff"),
          inArray(billingOutbox.status, ["pending", "processing"])
        )
      );
    await tx
      .update(billingSubscriptions)
      .set({ status: "manual_review" })
      .where(
        and(
          eq(billingSubscriptions.workspaceId, workspaceId),
          inArray(billingSubscriptions.status, [
            "provisioning",
            "active",
            "past_due",
          ])
        )
      );
    await tx
      .update(workspaceEntitlements)
      .set({ status: "manual_review" })
      .where(eq(workspaceEntitlements.workspaceId, workspaceId));

    const modes = new Set(intents.map(intent => intent.mode));
    for (const subscription of subscriptions) {
      modes.add(subscription.mode);
      if (subscription.mollieCustomerId && subscription.mollieSubscriptionId) {
        await tx
          .insert(billingOutbox)
          .values({
            workspaceId,
            mode: subscription.mode,
            eventType: "cancel_subscription",
            deduplicationKey: `profile_expired_cancel:${subscription.mollieSubscriptionId}`,
            payload: {
              reason: "billing_profile_expired",
              expectedSourceIntentId: subscription.sourceIntentId,
              targetCustomerId: subscription.mollieCustomerId,
              targetSubscriptionId: subscription.mollieSubscriptionId,
            },
            status: "pending",
          })
          .onDuplicateKeyUpdate({
            set: { deduplicationKey: sql`deduplication_key` },
          });
      }
    }
    for (const mode of modes) {
      await tx
        .insert(billingOutbox)
        .values({
          workspaceId,
          mode,
          eventType: "manual_review",
          deduplicationKey: `billing_profile_expired:${workspaceId}:${resultingVersion}`,
          payload: {
            reason: "billing_profile_expired",
            profileVersion: resultingVersion,
          },
          status: "pending",
        })
        .onDuplicateKeyUpdate({
          set: { deduplicationKey: sql`deduplication_key` },
        });
    }
    await tx
      .update(billingSchedulerTenants)
      .set({
        nextDueAt: sql`LEAST(${billingSchedulerTenants.nextDueAt}, ${now})`,
      })
      .where(
        and(
          eq(billingSchedulerTenants.workspaceId, workspaceId),
          eq(billingSchedulerTenants.kind, "outbox"),
          eq(billingSchedulerTenants.enabled, true)
        )
      );
    return true;
  });
}

export async function getWorkspaceBillingProfileExpiryDue(
  workspaceId: number,
  now = new Date()
): Promise<Date> {
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({
      verificationExpiresAt: workspaceBillingProfiles.verificationExpiresAt,
    })
    .from(workspaceBillingProfiles)
    .where(
      and(
        eq(workspaceBillingProfiles.workspaceId, workspaceId),
        eq(workspaceBillingProfiles.verificationStatus, "verified")
      )
    )
    .limit(1);
  return rows[0]?.verificationExpiresAt instanceof Date
    ? rows[0].verificationExpiresAt
    : new Date(now.getTime() + 24 * 60 * 60_000);
}

function affectedRows(result: unknown): number {
  const metadata: unknown = Array.isArray(result)
    ? (result as unknown[])[0]
    : result;
  return Number((metadata as { affectedRows?: number })?.affectedRows ?? 0);
}

type ProfileOperatorAction = typeof billingProfileOperatorActions.$inferSelect;

async function findOperatorAction(
  tx: Parameters<
    Parameters<Awaited<ReturnType<typeof getDatabaseOrThrow>>["transaction"]>[0]
  >[0],
  requestId: string
): Promise<ProfileOperatorAction | null> {
  const rows = await tx
    .select()
    .from(billingProfileOperatorActions)
    .where(eq(billingProfileOperatorActions.requestId, requestId))
    .limit(1)
    .for("update");
  return rows[0] ?? null;
}

function assertMatchingOperatorReplay(
  action: ProfileOperatorAction,
  input: { workspaceId: number; actorUserId: number; expectedVersion: number },
  expectedAction: "attest" | "revoke",
  requestFingerprint: string
): void {
  if (
    action.workspaceId !== input.workspaceId ||
    action.actorUserId !== input.actorUserId ||
    action.expectedVersion !== input.expectedVersion ||
    action.action !== expectedAction ||
    action.requestFingerprint !== requestFingerprint
  ) {
    throw new BillingProfileEligibilityError(
      "billing_profile_request_conflict"
    );
  }
}
