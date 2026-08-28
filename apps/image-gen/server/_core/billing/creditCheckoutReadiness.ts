import { and, eq, sql } from "drizzle-orm";

import {
  billingExecutionControls,
  billingIntents,
  billingProviderOperations,
  billingSchedulerTenants,
  creditLedger,
  creditReservations,
  creditWallets,
  paymentLedger,
} from "../../../drizzle/schema";
import { getDatabaseOrThrow } from "../../db";
import type { MollieMode } from "./config";

type CreditControlRow = Readonly<{
  workspaceId: number;
  commercialEnabled: boolean;
  authorizationEpoch: number;
}>;

type CreditOutboxLaneRow = Readonly<{
  workspaceId: number;
  kind: string;
  enabled: boolean;
  executionEpoch: number;
  deadLetterCount: number;
}>;

export function assertCreditCheckoutBoundaryReadiness(input: {
  workspaceId: number;
  commercialExposureEnabled: boolean;
  controls: readonly CreditControlRow[];
  outboxLanes: readonly CreditOutboxLaneRow[];
}): void {
  const control = input.controls[0];
  const outbox = input.outboxLanes[0];
  if (
    input.controls.length !== 1 ||
    !control ||
    control.workspaceId !== input.workspaceId ||
    !Number.isSafeInteger(control.authorizationEpoch) ||
    control.authorizationEpoch < 1
  ) {
    throw new Error("Credit checkout execution control is not ready");
  }
  if (input.commercialExposureEnabled && !control.commercialEnabled) {
    throw new Error("Credit checkout commercial control is disabled");
  }
  if (
    input.outboxLanes.length !== 1 ||
    !outbox ||
    outbox.workspaceId !== input.workspaceId ||
    outbox.kind !== "outbox" ||
    !outbox.enabled ||
    outbox.executionEpoch !== control.authorizationEpoch
  ) {
    throw new Error("Credit checkout safety lane is not ready");
  }
  if (input.commercialExposureEnabled && Number(outbox.deadLetterCount) > 0) {
    throw new Error("Credit checkout safety lane has unresolved dead letters");
  }
}

/**
 * Probes the final credit schema and the exact pinned execution boundary
 * without reading Messenger identities or customer content.
 */
export async function assertCreditCheckoutDatabaseReadiness(input: {
  mode: MollieMode;
  workspaceId: number;
  commercialExposureEnabled: boolean;
}): Promise<void> {
  if (!Number.isSafeInteger(input.workspaceId) || input.workspaceId < 1) {
    throw new Error("Credit checkout workspace is not configured");
  }
  const database = await getDatabaseOrThrow();
  await Promise.all([
    database
      .select({
        walletId: creditWallets.walletId,
        channelConnectionId: creditWallets.channelConnectionId,
        bindingEpoch: creditWallets.bindingEpoch,
        privacyEpoch: creditWallets.privacyEpoch,
        financialSubjectRef: creditWallets.financialSubjectRef,
        creditBalance: creditWallets.creditBalance,
        reservedCredits: creditWallets.reservedCredits,
      })
      .from(creditWallets)
      .where(sql`1 = 0`),
    database
      .select({
        reservationId: creditReservations.reservationId,
        walletId: creditReservations.walletId,
        ownerTokenHash: creditReservations.ownerTokenHash,
        status: creditReservations.status,
        resolutionDueAt: creditReservations.resolutionDueAt,
      })
      .from(creditReservations)
      .where(sql`1 = 0`),
    database
      .select({
        entryId: creditLedger.entryId,
        walletId: creditLedger.walletId,
        entryKind: creditLedger.entryKind,
        providerPaymentId: creditLedger.providerPaymentId,
        reservationId: creditLedger.reservationId,
        evidenceHash: creditLedger.evidenceHash,
      })
      .from(creditLedger)
      .where(sql`1 = 0`),
    database
      .select({
        kind: billingIntents.kind,
        walletId: billingIntents.creditWalletId,
        creditCount: billingIntents.creditCount,
        metadataHash: billingIntents.creditMetadataHash,
        capabilityHash: billingIntents.checkoutCapabilityHash,
      })
      .from(billingIntents)
      .where(sql`1 = 0`),
    database
      .select({
        creditPurpose: paymentLedger.creditPurpose,
        creditIntentId: paymentLedger.creditIntentId,
        creditWalletId: paymentLedger.creditWalletId,
        paidEffectApplied: paymentLedger.paidEffectApplied,
      })
      .from(paymentLedger)
      .where(sql`1 = 0`),
    database
      .select({
        state: billingProviderOperations.state,
        intentId: billingProviderOperations.intentId,
        providerResourceId: billingProviderOperations.providerResourceId,
        authorizationEpoch: billingProviderOperations.authorizationEpoch,
      })
      .from(billingProviderOperations)
      .where(sql`1 = 0`),
  ]);

  const [controls, outboxLanes] = await Promise.all([
    database
      .select({
        workspaceId: billingExecutionControls.workspaceId,
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
      .limit(2),
    database
      .select({
        workspaceId: billingSchedulerTenants.workspaceId,
        kind: billingSchedulerTenants.kind,
        enabled: billingSchedulerTenants.enabled,
        executionEpoch: billingSchedulerTenants.executionEpoch,
        deadLetterCount: billingSchedulerTenants.deadLetterCount,
      })
      .from(billingSchedulerTenants)
      .where(
        and(
          eq(billingSchedulerTenants.workspaceId, input.workspaceId),
          eq(billingSchedulerTenants.mode, input.mode),
          eq(billingSchedulerTenants.kind, "outbox")
        )
      )
      .limit(2),
  ]);
  assertCreditCheckoutBoundaryReadiness({
    workspaceId: input.workspaceId,
    commercialExposureEnabled: input.commercialExposureEnabled,
    controls,
    outboxLanes,
  });
}
