import { and, eq, inArray } from "drizzle-orm";

import {
  billingIntents,
  channelConnections,
  messengerPrivacySubjects,
  messengerProviderAttemptFences,
} from "../../drizzle/schema";
import { getDatabaseOrThrow } from "../db";
import {
  PREMIUM_IMAGE_CREDITS_PER_PURCHASE,
  PREMIUM_IMAGE_CREDITS_PLAN_CODE,
} from "./billing/catalog";
import { getConfiguredBillingMode, type MollieMode } from "./billing/config";
import {
  buildMessengerProviderAttemptKeyHash,
  claimMessengerProviderAttemptFence,
  finalizeMessengerProviderAttemptFence,
  markMessengerProviderAttemptStarted,
  type MessengerProviderAttemptFence,
} from "./messengerProviderAttemptFence";
import type { MessengerGenerationJob } from "./messengerGenerationJob";

export const PREMIUM_CREDIT_PROVIDER_OPERATION = "premium_image_credit_v1";
const ACTIVE_CREDIT_STATUSES = [
  "reserved",
  "started",
  "ambiguous",
  "succeeded",
] as const;

export type PremiumCreditBalance = Readonly<{
  purchased: number;
  committedOrReserved: number;
  remaining: number;
}>;

export type PremiumCreditReservationDecision =
  | {
      status: "reserved";
      fence: MessengerProviderAttemptFence;
      balance: PremiumCreditBalance;
    }
  | { status: "already_committed"; balance: PremiumCreditBalance }
  | { status: "busy" }
  | { status: "exhausted"; balance: PremiumCreditBalance };

export function isPremiumCreditEnforcementEnabled(): boolean {
  return process.env.PREMIUM_CREDIT_ENFORCEMENT_ENABLED === "true";
}

export function calculatePremiumCreditBalance(
  paidPurchaseCount: number,
  activeCreditCount: number
): PremiumCreditBalance {
  if (
    !Number.isSafeInteger(paidPurchaseCount) ||
    paidPurchaseCount < 0 ||
    !Number.isSafeInteger(activeCreditCount) ||
    activeCreditCount < 0
  ) {
    throw new Error("premium credit balance inputs are invalid");
  }
  const purchased = paidPurchaseCount * PREMIUM_IMAGE_CREDITS_PER_PURCHASE;
  return Object.freeze({
    purchased,
    committedOrReserved: activeCreditCount,
    remaining: Math.max(0, purchased - activeCreditCount),
  });
}

export async function reservePremiumImageCredit(
  job: MessengerGenerationJob,
  now = new Date()
): Promise<PremiumCreditReservationDecision> {
  assertPremiumJob(job);
  const claim = await claimMessengerProviderAttemptFence(
    job,
    PREMIUM_CREDIT_PROVIDER_OPERATION,
    1,
    now,
    { takeOverReserved: false }
  );
  if (claim.kind === "busy") return { status: "busy" };
  if (claim.kind === "blocked") {
    return {
      status: "exhausted",
      balance: await getPremiumCreditBalance(job),
    };
  }
  if (claim.kind === "unsafe_or_done") {
    if (claim.status === "succeeded") {
      return {
        status: "already_committed",
        balance: await getPremiumCreditBalance(job),
      };
    }
    return { status: "busy" };
  }

  const admitted = await adjudicatePremiumCreditFence(
    job,
    claim.fence,
    getConfiguredBillingMode()
  );
  if (!admitted.allowed) {
    return { status: "exhausted", balance: admitted.balance };
  }
  return { status: "reserved", fence: claim.fence, balance: admitted.balance };
}

export async function markPremiumImageCreditStarted(
  fence: MessengerProviderAttemptFence
): Promise<void> {
  await markMessengerProviderAttemptStarted(fence);
}

export async function releasePremiumImageCredit(
  fence: MessengerProviderAttemptFence
): Promise<void> {
  await finalizeMessengerProviderAttemptFence(fence, "known_failed");
}

export async function holdAmbiguousPremiumImageCredit(
  fence: MessengerProviderAttemptFence
): Promise<void> {
  await finalizeMessengerProviderAttemptFence(fence, "ambiguous");
}

/** A durable generation completion is the authority to consume one credit. */
export async function commitPremiumImageCreditForCompletion(
  job: MessengerGenerationJob,
  now = new Date()
): Promise<PremiumCreditBalance> {
  assertPremiumJob(job);
  const attemptKeyHash = buildMessengerProviderAttemptKeyHash(
    job,
    PREMIUM_CREDIT_PROVIDER_OPERATION,
    1
  );
  const database = await getDatabaseOrThrow();
  await database.transaction(async tx => {
    await lockPremiumSubject(tx, job);
    const result = await tx
      .update(messengerProviderAttemptFences)
      .set({ status: "succeeded", completedAt: now, leaseUntil: now })
      .where(
        and(
          eq(messengerProviderAttemptFences.attemptKeyHash, attemptKeyHash),
          eq(messengerProviderAttemptFences.workspaceId, job.workspaceId!),
          eq(
            messengerProviderAttemptFences.channelConnectionId,
            job.channelConnectionId!
          ),
          eq(messengerProviderAttemptFences.userKey, job.userId),
          eq(messengerProviderAttemptFences.privacyEpoch, job.privacyEpoch!),
          eq(
            messengerProviderAttemptFences.providerOperation,
            PREMIUM_CREDIT_PROVIDER_OPERATION
          ),
          inArray(messengerProviderAttemptFences.status, [
            "reserved",
            "started",
            "ambiguous",
          ])
        )
      );
    if (affectedRows(result) === 0) {
      const existing = await tx
        .select({ status: messengerProviderAttemptFences.status })
        .from(messengerProviderAttemptFences)
        .where(
          and(
            eq(messengerProviderAttemptFences.attemptKeyHash, attemptKeyHash),
            eq(messengerProviderAttemptFences.status, "succeeded")
          )
        )
        .limit(1)
        .for("update");
      if (!existing[0]) throw new Error("premium credit commit was lost");
    }
  });
  return await getPremiumCreditBalance(job);
}

export async function getPremiumCreditBalance(
  job: Pick<
    MessengerGenerationJob,
    "workspaceId" | "channelConnectionId" | "privacyEpoch" | "userId" | "pageId"
  >,
  mode: MollieMode = getConfiguredBillingMode()
): Promise<PremiumCreditBalance> {
  assertPremiumJob(job);
  const database = await getDatabaseOrThrow();
  const [purchases, credits] = await Promise.all([
    database
      .select({ intentId: billingIntents.intentId })
      .from(billingIntents)
      .where(paidPurchaseScope(job, mode)),
    database
      .select({ id: messengerProviderAttemptFences.id })
      .from(messengerProviderAttemptFences)
      .where(activeCreditScope(job)),
  ]);
  return calculatePremiumCreditBalance(purchases.length, credits.length);
}

async function adjudicatePremiumCreditFence(
  job: MessengerGenerationJob,
  fence: MessengerProviderAttemptFence,
  mode: MollieMode
): Promise<{ allowed: boolean; balance: PremiumCreditBalance }> {
  const database = await getDatabaseOrThrow();
  return database.transaction(async tx => {
    await lockPremiumSubject(tx, job);
    const purchases = await tx
      .select({ intentId: billingIntents.intentId })
      .from(billingIntents)
      .where(paidPurchaseScope(job, mode))
      .for("update");
    const credits = await tx
      .select({
        id: messengerProviderAttemptFences.id,
        attemptKeyHash: messengerProviderAttemptFences.attemptKeyHash,
      })
      .from(messengerProviderAttemptFences)
      .where(activeCreditScope(job))
      .orderBy(messengerProviderAttemptFences.id)
      .for("update");
    const balance = calculatePremiumCreditBalance(
      purchases.length,
      credits.length
    );
    const rank = credits.findIndex(
      row => row.attemptKeyHash === fence.attemptKeyHash
    );
    const allowed =
      rank >= 0 && rank < purchases.length * PREMIUM_IMAGE_CREDITS_PER_PURCHASE;
    if (!allowed) {
      const result = await tx
        .update(messengerProviderAttemptFences)
        .set({
          status: "contained",
          completedAt: new Date(),
          leaseUntil: new Date(),
        })
        .where(
          and(
            eq(
              messengerProviderAttemptFences.attemptKeyHash,
              fence.attemptKeyHash!
            ),
            eq(messengerProviderAttemptFences.status, "reserved")
          )
        );
      if (affectedRows(result) !== 1) {
        throw new Error("premium credit containment was lost");
      }
    }
    return { allowed, balance };
  });
}

function paidPurchaseScope(
  job: Pick<
    MessengerGenerationJob,
    "workspaceId" | "channelConnectionId" | "privacyEpoch" | "userId" | "pageId"
  >,
  mode: MollieMode
) {
  return and(
    eq(billingIntents.workspaceId, job.workspaceId!),
    eq(billingIntents.mode, mode),
    eq(billingIntents.planCode, PREMIUM_IMAGE_CREDITS_PLAN_CODE),
    eq(billingIntents.kind, "startpilot_purchase"),
    eq(billingIntents.status, "paid"),
    eq(billingIntents.messengerSenderUserKey, job.userId),
    eq(billingIntents.messengerPageId, job.pageId!),
    eq(billingIntents.messengerChannelConnectionId, job.channelConnectionId!),
    eq(billingIntents.messengerPrivacyEpoch, job.privacyEpoch!)
  );
}

function activeCreditScope(
  job: Pick<
    MessengerGenerationJob,
    "workspaceId" | "channelConnectionId" | "privacyEpoch" | "userId"
  >
) {
  return and(
    eq(messengerProviderAttemptFences.workspaceId, job.workspaceId!),
    eq(
      messengerProviderAttemptFences.channelConnectionId,
      job.channelConnectionId!
    ),
    eq(messengerProviderAttemptFences.userKey, job.userId),
    eq(messengerProviderAttemptFences.privacyEpoch, job.privacyEpoch!),
    eq(
      messengerProviderAttemptFences.providerOperation,
      PREMIUM_CREDIT_PROVIDER_OPERATION
    ),
    inArray(messengerProviderAttemptFences.status, [...ACTIVE_CREDIT_STATUSES])
  );
}

async function lockPremiumSubject(
  tx: Parameters<
    Parameters<Awaited<ReturnType<typeof getDatabaseOrThrow>>["transaction"]>[0]
  >[0],
  job: MessengerGenerationJob
): Promise<void> {
  const owners = await tx
    .select({ id: channelConnections.id })
    .from(channelConnections)
    .where(
      and(
        eq(channelConnections.id, job.channelConnectionId!),
        eq(channelConnections.workspaceId, job.workspaceId!),
        eq(channelConnections.channel, "facebook_messenger"),
        eq(channelConnections.externalId, job.pageId!),
        eq(channelConnections.status, "connected"),
        eq(channelConnections.bindingEpoch, job.bindingEpoch!)
      )
    )
    .limit(1)
    .for("update");
  const subjects = await tx
    .select({ id: messengerPrivacySubjects.id })
    .from(messengerPrivacySubjects)
    .where(
      and(
        eq(messengerPrivacySubjects.workspaceId, job.workspaceId!),
        eq(
          messengerPrivacySubjects.channelConnectionId,
          job.channelConnectionId!
        ),
        eq(messengerPrivacySubjects.userKey, job.userId),
        eq(messengerPrivacySubjects.privacyEpoch, job.privacyEpoch!),
        eq(messengerPrivacySubjects.status, "active")
      )
    )
    .limit(1)
    .for("update");
  if (!owners[0] || !subjects[0]) {
    throw new Error("premium credit ownership changed");
  }
}

function assertPremiumJob(
  job: Pick<
    MessengerGenerationJob,
    | "workspaceId"
    | "channelConnectionId"
    | "bindingEpoch"
    | "privacyEpoch"
    | "userId"
    | "pageId"
  >
): void {
  if (
    !job.workspaceId ||
    !job.channelConnectionId ||
    !job.bindingEpoch ||
    !job.privacyEpoch ||
    !/^[a-f0-9]{64}$/i.test(job.userId) ||
    !job.pageId
  ) {
    throw new Error("premium credit scope is incomplete");
  }
}

function affectedRows(result: unknown): number {
  const metadata: unknown = Array.isArray(result)
    ? (result as unknown[])[0]
    : result;
  return Number(
    (metadata as { affectedRows?: number } | undefined)?.affectedRows ?? 0
  );
}
