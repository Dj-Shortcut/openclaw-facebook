import { getMollieConfig, type MollieConfig } from "./config";
import {
  PREMIUM_IMAGE_CREDIT_OFFER_ID,
  PREMIUM_IMAGE_CREDIT_OFFER_VERSION,
  PREMIUM_IMAGE_CREDIT_REFUND_POLICY_ID,
  PREMIUM_IMAGE_CREDIT_REFUND_POLICY_VERSION,
  getCreditOffer,
} from "./creditCatalog";
import {
  getCreditCheckoutPilotConfig,
  isCreditCheckoutMessengerScopeAllowed,
  type CreditCheckoutPilotConfig,
} from "./creditCheckoutConfig";
import {
  claimCreditPaymentCreation,
  exposeCreditPaymentCheckout,
  finalizeCreditPaymentProviderOperation,
  markCreditPaymentTransportStarted,
  type CreditCheckoutProviderScope,
  type CreditPaymentProviderOutcome,
} from "./creditCheckoutProviderStore";
import type { CreditCheckoutPublicOffer } from "./creditCheckoutSession";
import type { CreditCheckoutSessionRecord } from "./creditCheckoutSessionStore";
import {
  MollieApiError,
  MollieClient,
  type MolliePayment,
} from "./mollieClient";
import { validateCreditPaymentContract } from "./creditPaymentContract";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAYMENT_ID_PATTERN = /^tr_[A-Za-z0-9]{1,60}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const USER_KEY_PATTERN =
  /^(?:[0-9a-f]{64}|u2[.]k[1-9][0-9]{0,5}[.][0-9a-f]{64})$/;

export type CreditCheckoutPaymentSession = Readonly<{
  intentId: string;
  record: CreditCheckoutSessionRecord;
  offer: CreditCheckoutPublicOffer;
}>;

export class CreditCheckoutPaymentError extends Error {
  constructor() {
    super("Credit checkout payment is unavailable");
    this.name = "CreditCheckoutPaymentError";
  }
}

type CreditPaymentClient = Pick<
  MollieClient,
  "createCreditPayment" | "getPayment" | "getHostedCheckoutUrl"
>;

type Dependencies = Readonly<{
  mollieConfig: () => MollieConfig;
  pilotConfig: () => CreditCheckoutPilotConfig;
  createClient: (config: MollieConfig) => CreditPaymentClient;
  claim: typeof claimCreditPaymentCreation;
  markTransportStarted: typeof markCreditPaymentTransportStarted;
  finalize: typeof finalizeCreditPaymentProviderOperation;
  expose: typeof exposeCreditPaymentCheckout;
}>;

const defaultDependencies: Dependencies = Object.freeze({
  mollieConfig: getMollieConfig,
  pilotConfig: getCreditCheckoutPilotConfig,
  createClient: config => new MollieClient(config),
  claim: claimCreditPaymentCreation,
  markTransportStarted: markCreditPaymentTransportStarted,
  finalize: finalizeCreditPaymentProviderOperation,
  expose: exposeCreditPaymentCheckout,
});

function fail(): never {
  throw new CreditCheckoutPaymentError();
}

/**
 * Starts the one provider mutation in this flow. It must only be called after
 * the browser capability has been consumed and the user explicitly confirms.
 */
export async function confirmCreditCheckoutPayment(
  session: CreditCheckoutPaymentSession,
  dependencies: Dependencies = defaultDependencies
): Promise<Readonly<{ checkoutUrl: string }>> {
  const pilot = dependencies.pilotConfig();
  const scope = requireProviderScope(session, pilot);
  const mollieConfig = dependencies.mollieConfig();
  if (mollieConfig.mode !== scope.mode) fail();

  const offer = getCreditOffer(scope.offerId, scope.offerVersion);
  if (!offer) fail();
  const client = dependencies.createClient(mollieConfig);
  const claim = await dependencies.claim(scope);
  if (!claim.claimed) fail();

  const operation = Object.freeze({
    ...scope,
    operationId: claim.operationId,
    leaseToken: claim.leaseToken,
  });
  let transportStarted = false;
  let payment: MolliePayment;
  try {
    if (claim.recoveryPaymentId) {
      payment = await client.getPayment(claim.recoveryPaymentId);
      if (payment.id !== claim.recoveryPaymentId) fail();
    } else {
      if (!(await dependencies.markTransportStarted(operation))) fail();
      transportStarted = true;
      payment = await client.createCreditPayment({
        amount: offer.amount,
        description: offer.mollieDescription,
        billingIntentId: scope.intentId,
        metadataHash: scope.metadataHash,
        redirectUrl: new URL(
          "/credits/checkout/return",
          mollieConfig.appBaseUrl
        ).toString(),
        webhookUrl: mollieConfig.paymentWebhookUrl,
        idempotencyKey: `credit-payment:${scope.intentId}`,
      });
    }
  } catch (error) {
    if (transportStarted) {
      await persistFailedTransport(dependencies, operation, error);
    }
    return fail();
  }

  const contract = validateCreditPaymentContract(
    payment,
    {
      intentId: scope.intentId,
      mode: scope.mode,
      metadataHash: scope.metadataHash,
      offer,
    },
    "creation"
  );
  let checkoutUrl: string | null = null;
  if (contract.exact) {
    try {
      checkoutUrl = client.getHostedCheckoutUrl(payment);
    } catch {
      checkoutUrl = null;
    }
  }

  const outcome = providerOutcomeForResponse(
    payment,
    contract.exact && !!checkoutUrl
  );
  if (!claim.recoveryPaymentId) {
    const finalized = await dependencies.finalize({
      ...operation,
      outcome,
    });
    if (!finalized.recorded || !finalized.authorized) fail();
  }
  if (
    outcome.kind !== "known_succeeded" ||
    !checkoutUrl ||
    (claim.recoveryPaymentId && outcome.paymentId !== claim.recoveryPaymentId)
  ) {
    fail();
  }

  const exposed = await dependencies.expose({
    ...operation,
    paymentId: outcome.paymentId,
  });
  if (!exposed) fail();
  return Object.freeze({ checkoutUrl });
}

async function persistFailedTransport(
  dependencies: Dependencies,
  operation: CreditCheckoutProviderScope &
    Readonly<{ operationId: string; leaseToken: string }>,
  error: unknown
): Promise<void> {
  const outcome: CreditPaymentProviderOutcome =
    error instanceof MollieApiError && error.status >= 400 && error.status < 500
      ? { kind: "known_failed" }
      : { kind: "ambiguous" };
  await dependencies.finalize({ ...operation, outcome });
}

function providerOutcomeForResponse(
  payment: MolliePayment,
  exact: boolean
): CreditPaymentProviderOutcome {
  if (exact) {
    return { kind: "known_succeeded", paymentId: payment.id };
  }
  return PAYMENT_ID_PATTERN.test(payment.id)
    ? { kind: "known_mismatch", paymentId: payment.id }
    : { kind: "ambiguous" };
}

function requireProviderScope(
  session: CreditCheckoutPaymentSession,
  pilot: CreditCheckoutPilotConfig
): CreditCheckoutProviderScope {
  const record = session.record;
  const channelConnectionId = record.messengerChannelConnectionId;
  const bindingEpoch = record.messengerBindingEpoch;
  const privacyEpoch = record.messengerPrivacyEpoch;
  const userKey = record.messengerSenderUserKey;
  const walletId = record.creditWalletId;
  const financialSubjectRef = record.creditFinancialSubjectRef;
  const sessionNonceHash = record.checkoutCapabilitySessionNonceHash;
  const metadataHash = record.creditMetadataHash;
  if (
    !pilot.checkoutEnabled ||
    !pilot.paidCreditsEnabled ||
    pilot.workspaceId === null ||
    record.workspaceId !== pilot.workspaceId ||
    record.mode !== pilot.mode ||
    session.intentId !== record.intentId ||
    !UUID_PATTERN.test(record.intentId) ||
    record.kind !== "credit_purchase" ||
    record.planCode !== PREMIUM_IMAGE_CREDIT_OFFER_ID ||
    record.expectedAmount !== "4.99" ||
    record.currency !== "EUR" ||
    record.interval !== "oneoff" ||
    record.mollieDescription !== "Leaderbot - 8 premium beeldcredits" ||
    record.creditCount !== 8 ||
    record.billingProfileVersion !== 0 ||
    !Number.isSafeInteger(record.authorizationEpoch) ||
    record.authorizationEpoch < 1 ||
    !Number.isSafeInteger(channelConnectionId) ||
    channelConnectionId === null ||
    channelConnectionId < 1 ||
    !Number.isSafeInteger(bindingEpoch) ||
    bindingEpoch === null ||
    bindingEpoch < 1 ||
    !Number.isSafeInteger(privacyEpoch) ||
    privacyEpoch === null ||
    privacyEpoch < 1 ||
    !userKey ||
    !USER_KEY_PATTERN.test(userKey) ||
    !walletId ||
    !UUID_PATTERN.test(walletId) ||
    !financialSubjectRef ||
    !SHA256_PATTERN.test(financialSubjectRef) ||
    !sessionNonceHash ||
    !SHA256_PATTERN.test(sessionNonceHash) ||
    !metadataHash ||
    !SHA256_PATTERN.test(metadataHash) ||
    record.creditIdentityErasedAt !== null ||
    session.offer.mode !== record.mode ||
    session.offer.amount !== "4.99" ||
    session.offer.currency !== "EUR" ||
    session.offer.creditCount !== 8 ||
    session.offer.imageQuality !== "medium" ||
    session.offer.expires ||
    session.offer.automaticRenewal ||
    session.offer.refundPolicyId !== PREMIUM_IMAGE_CREDIT_REFUND_POLICY_ID ||
    session.offer.refundPolicyVersion !==
      PREMIUM_IMAGE_CREDIT_REFUND_POLICY_VERSION
  ) {
    return fail();
  }
  if (
    !isCreditCheckoutMessengerScopeAllowed(pilot, {
      workspaceId: record.workspaceId,
      channelConnectionId,
      bindingEpoch,
      privacyEpoch,
      userKey,
    })
  ) {
    return fail();
  }
  return Object.freeze({
    workspaceId: record.workspaceId,
    mode: record.mode,
    channelConnectionId,
    bindingEpoch,
    privacyEpoch,
    userKey,
    walletId,
    financialSubjectRef,
    intentId: record.intentId,
    authorizationEpoch: record.authorizationEpoch,
    sessionNonceHash,
    metadataHash,
    offerId: PREMIUM_IMAGE_CREDIT_OFFER_ID,
    offerVersion: PREMIUM_IMAGE_CREDIT_OFFER_VERSION,
  });
}
