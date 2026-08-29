import { eq } from "drizzle-orm";

import { billingIntents } from "../../../drizzle/schema";
import { getDatabaseOrThrow } from "../../db";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type CreditCheckoutSessionRecord = Readonly<{
  intentId: string;
  workspaceId: number;
  mode: "test" | "live";
  planCode: string;
  kind: string;
  expectedAmount: string;
  currency: string;
  interval: string;
  entitlements: unknown;
  mollieDescription: string;
  status: string;
  molliePaymentId: string | null;
  messengerSenderUserKey: string | null;
  messengerChannelConnectionId: number | null;
  messengerBindingEpoch: number | null;
  messengerPrivacyEpoch: number | null;
  creditWalletId: string | null;
  creditFinancialSubjectRef: string | null;
  creditCount: number | null;
  creditMetadataHash: string | null;
  checkoutCapabilityHash: string | null;
  checkoutCapabilityExpiresAt: Date | null;
  checkoutCapabilityConsumedAt: Date | null;
  checkoutCapabilitySessionNonceHash: string | null;
  creditIdentityErasedAt: Date | null;
  billingProfileVersion: number;
  authorizationEpoch: number;
  urlExposedAt: Date | null;
  paidAt: Date | null;
}>;

export async function readCreditCheckoutSessionRecord(
  intentId: string
): Promise<CreditCheckoutSessionRecord | null> {
  if (!UUID_PATTERN.test(intentId)) return null;
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({
      intentId: billingIntents.intentId,
      workspaceId: billingIntents.workspaceId,
      mode: billingIntents.mode,
      planCode: billingIntents.planCode,
      kind: billingIntents.kind,
      expectedAmount: billingIntents.expectedAmount,
      currency: billingIntents.currency,
      interval: billingIntents.interval,
      entitlements: billingIntents.entitlements,
      mollieDescription: billingIntents.mollieDescription,
      status: billingIntents.status,
      molliePaymentId: billingIntents.molliePaymentId,
      messengerSenderUserKey: billingIntents.messengerSenderUserKey,
      messengerChannelConnectionId: billingIntents.messengerChannelConnectionId,
      messengerBindingEpoch: billingIntents.messengerBindingEpoch,
      messengerPrivacyEpoch: billingIntents.messengerPrivacyEpoch,
      creditWalletId: billingIntents.creditWalletId,
      creditFinancialSubjectRef: billingIntents.creditFinancialSubjectRef,
      creditCount: billingIntents.creditCount,
      creditMetadataHash: billingIntents.creditMetadataHash,
      checkoutCapabilityHash: billingIntents.checkoutCapabilityHash,
      checkoutCapabilityExpiresAt: billingIntents.checkoutCapabilityExpiresAt,
      checkoutCapabilityConsumedAt: billingIntents.checkoutCapabilityConsumedAt,
      checkoutCapabilitySessionNonceHash:
        billingIntents.checkoutCapabilitySessionNonceHash,
      creditIdentityErasedAt: billingIntents.creditIdentityErasedAt,
      billingProfileVersion: billingIntents.billingProfileVersion,
      authorizationEpoch: billingIntents.authorizationEpoch,
      urlExposedAt: billingIntents.urlExposedAt,
      paidAt: billingIntents.paidAt,
    })
    .from(billingIntents)
    .where(eq(billingIntents.intentId, intentId))
    .limit(2);
  return rows.length === 1 ? rows[0] : null;
}
