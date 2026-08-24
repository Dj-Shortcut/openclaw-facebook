import { requireActiveBillingPlan, formatAmountMinor } from "./catalog";
import {
  assertMollieBillingEnabled,
  assertTenantBillingWorkerWorkspace,
  getMollieConfig,
  getConfiguredBillingMode,
  getBillingSchedulerRollout,
  assertMollieNonSecretLaunchConfig,
  isMollieBillingEnabled,
} from "./config";
import {
  attachMollieCustomer,
  attachMolliePayment,
  claimCustomerProviderCreation,
  claimIntentPaymentCreation,
  finalizePaymentProviderOperation,
  getBillingCustomer,
  getBillingIntent,
  isCheckoutUrlExposureAllowed,
  markBillingCustomerManualReview,
  markIntentApiUnknown,
  markIntentPaymentMismatch,
  markPaymentProviderTransportStarted,
  reserveBillingCustomer,
  reserveCheckoutIntent,
  type CheckoutKind,
} from "./checkoutStore";
import {
  assertMollieId,
  checkMolliePaymentMethods,
  checkMollieOneTimePaymentMethod,
  MollieClient,
} from "./mollieClient";
import {
  getWorkspaceBillingSubscription,
  requestWorkspaceSubscriptionCancellation,
} from "./subscriptionStore";
import { assertWorkspaceBillingProfileEligible } from "./billingProfileStore";
import {
  assertBillingExecutionBoundary,
  assertBillingSchedulerTenantEnabled,
  wakeBillingSchedulerTenant,
} from "./billingSchedulerStore";
import { assertBillingNotificationConfig } from "./billingNotificationDelivery";
import { assertBillingDatabaseReadiness } from "./billingReadiness";

const PAYMENT_METHOD_CHANGE_GUARD_DAYS = 7;

export type CheckoutRequest = {
  workspaceId: number;
  planCode: string;
  kind: CheckoutKind;
  businessCheckout?: boolean;
  messengerSenderUserKey?: string | null;
  messengerPageId?: string | null;
  messengerChannelConnectionId?: number | null;
  messengerPrivacyEpoch?: number | null;
};

export async function startMollieCheckout(
  input: CheckoutRequest,
  clientOverride?: MollieClient
) {
  assertMollieBillingEnabled();
  assertTenantBillingWorkerWorkspace(input.workspaceId);
  const config = getMollieConfig();
  const executionBoundary = await assertBillingSchedulerTenantEnabled(
    input.workspaceId,
    config.mode
  );
  const billingProfile = await assertWorkspaceBillingProfileEligible(
    input.workspaceId
  );
  if (input.businessCheckout) {
    throw new Error(
      "B2B checkout is unavailable until Peppol invoicing is configured"
    );
  }

  const plan = requireActiveBillingPlan(input.planCode);
  if (!plan.publiclyAvailable && input.kind !== "payment_method_change") {
    throw new Error("billing plan is unavailable");
  }
  assertCheckoutKindMatchesPlan(plan.offerType, input.kind);
  const client = clientOverride ?? new MollieClient(config);
  await assertBillingExecutionBoundary(executionBoundary);
  if (plan.offerType === "one_time") {
    const methods = await checkMollieOneTimePaymentMethod(client);
    if (!methods.bancontact) {
      throw new Error("Mollie Bancontact must be enabled before checkout");
    }
  } else {
    const methods = await checkMolliePaymentMethods(client, config.mode);
    if (!methods.bancontact || !methods.sepaDirectDebit) {
      throw new Error(
        "Mollie Bancontact and SEPA Direct Debit must both be enabled before checkout"
      );
    }
  }
  if (input.kind === "payment_method_change") {
    await assertPaymentMethodChangeIsSafe(
      input.workspaceId,
      config.mode,
      client,
      new Date()
    );
  }

  const intent = await reserveCheckoutIntent({
    workspaceId: input.workspaceId,
    mode: config.mode,
    plan,
    kind: input.kind,
    messengerSenderUserKey: input.messengerSenderUserKey,
    messengerPageId: input.messengerPageId,
    messengerChannelConnectionId: input.messengerChannelConnectionId,
    messengerPrivacyEpoch: input.messengerPrivacyEpoch,
    billingProfileVersion: billingProfile.eligibilityVersion,
    authorizationEpoch: executionBoundary.authorizationEpoch,
  });
  if (!(await wakeBillingSchedulerTenant(input.workspaceId, config.mode))) {
    throw new Error("billing scheduler tenant is not enabled");
  }

  if (intent.molliePaymentId) {
    const storedCustomer = await getBillingCustomer(
      input.workspaceId,
      config.mode
    );
    if (!storedCustomer?.mollieCustomerId) {
      throw new Error("billing customer is not ready");
    }
    await assertBillingExecutionBoundary(executionBoundary);
    const existingPayment = await client.getPayment(intent.molliePaymentId);
    await assertBillingExecutionBoundary(executionBoundary);
    validatePaymentResponse({
      payment: existingPayment,
      intentId: intent.intentId,
      customerId: storedCustomer.mollieCustomerId,
      amount: formatAmountMinor(plan.amountMinor),
      mode: config.mode,
    });
    if (
      !(await isCheckoutUrlExposureAllowed({
        intentId: intent.intentId,
        workspaceId: input.workspaceId,
        mode: config.mode,
        molliePaymentId: intent.molliePaymentId,
        billingProfileVersion: billingProfile.eligibilityVersion,
        authorizationEpoch: executionBoundary.authorizationEpoch,
      }))
    ) {
      throw new Error("checkout was contained before URL exposure");
    }
    return {
      intentId: intent.intentId,
      checkoutUrl: client.getHostedCheckoutUrl(existingPayment),
      status: intent.status,
    };
  }
  if (intent.status === "creating_payment" || intent.status === "api_unknown") {
    throw new Error(
      "checkout creation is being reconciled; no retry was issued"
    );
  }

  const customerReservation = await reserveBillingCustomer(
    input.workspaceId,
    config.mode
  );
  let customer = customerReservation.customer;
  if (!customer.mollieCustomerId) {
    if (!customerReservation.creationClaimed) {
      throw new Error(
        "billing customer creation requires manual reconciliation"
      );
    }
    let customerOperation: { operationId: string; leaseToken: string } | null =
      null;
    let customerTransportStarted = false;
    try {
      const currentProfile = await assertWorkspaceBillingProfileEligible(
        input.workspaceId
      );
      if (
        currentProfile.eligibilityVersion !== billingProfile.eligibilityVersion
      ) {
        throw new Error("billing profile changed during checkout");
      }
      const customerClaim = await claimCustomerProviderCreation({
        intentId: intent.intentId,
        workspaceId: input.workspaceId,
        mode: config.mode,
        billingProfileVersion: billingProfile.eligibilityVersion,
        authorizationEpoch: executionBoundary.authorizationEpoch,
        externalReference: customer.externalReference,
        idempotencyKey: customer.idempotencyKey,
      });
      if (!customerClaim.claimed) {
        throw new Error("customer creation is being reconciled");
      }
      customerOperation = customerClaim;
      if (
        !(await markPaymentProviderTransportStarted({
          operationId: customerClaim.operationId,
          leaseToken: customerClaim.leaseToken,
          workspaceId: input.workspaceId,
          mode: config.mode,
          authorizationEpoch: executionBoundary.authorizationEpoch,
        }))
      ) {
        throw new Error("customer provider operation fence was lost");
      }
      customerTransportStarted = true;
      const mollieCustomer = await client.createCustomer({
        externalReference: customer.externalReference,
        idempotencyKey: customer.idempotencyKey,
      });
      const customerFinalized = await finalizePaymentProviderOperation({
        operationId: customerClaim.operationId,
        leaseToken: customerClaim.leaseToken,
        outcome: "succeeded",
        providerResourceId: mollieCustomer.id,
        workspaceId: input.workspaceId,
        mode: config.mode,
        authorizationEpoch: executionBoundary.authorizationEpoch,
        intentId: intent.intentId,
      });
      if (!customerFinalized.recorded || !customerFinalized.authorized) {
        throw new Error("customer provider result fence was lost");
      }
      assertMollieId(mollieCustomer.id, "cst_");
      if (mollieCustomer.mode !== config.mode) {
        throw new Error("Mollie customer mode mismatch");
      }
      customer = await attachMollieCustomer(
        input.workspaceId,
        config.mode,
        mollieCustomer.id
      );
    } catch (error) {
      if (customerTransportStarted && customerOperation) {
        await finalizePaymentProviderOperation({
          operationId: customerOperation.operationId,
          leaseToken: customerOperation.leaseToken,
          outcome: "ambiguous",
          workspaceId: input.workspaceId,
          mode: config.mode,
          authorizationEpoch: executionBoundary.authorizationEpoch,
          intentId: intent.intentId,
        });
      }
      await markBillingCustomerManualReview(input.workspaceId, config.mode);
      throw error;
    }
  }

  const customerId = customer.mollieCustomerId;
  if (!customerId) {
    throw new Error("billing customer is not ready");
  }

  const paymentInput = {
    customerId,
    amount: {
      currency: plan.currency,
      value: formatAmountMinor(plan.amountMinor),
    },
    description: plan.mollieDescription,
    intentId: intent.intentId,
    redirectUrl: `${config.appBaseUrl}/?billing=return&intent=${encodeURIComponent(intent.intentId)}`,
    webhookUrl: config.paymentWebhookUrl,
    idempotencyKey: intent.idempotencyKey,
  };
  const paymentCreationClaim = await claimIntentPaymentCreation({
    intentId: intent.intentId,
    workspaceId: input.workspaceId,
    mode: config.mode,
    billingProfileVersion: billingProfile.eligibilityVersion,
    authorizationEpoch: executionBoundary.authorizationEpoch,
    providerRequest: { ...paymentInput, offerType: plan.offerType },
  });
  if (!paymentCreationClaim.claimed) {
    throw new Error(
      "checkout creation is being reconciled; no retry was issued"
    );
  }
  let payment: Awaited<ReturnType<MollieClient["createFirstPayment"]>>;
  let providerTransportStarted = false;
  try {
    await assertBillingExecutionBoundary(executionBoundary);
    if (
      !(await markPaymentProviderTransportStarted({
        operationId: paymentCreationClaim.operationId,
        leaseToken: paymentCreationClaim.leaseToken,
        workspaceId: input.workspaceId,
        mode: config.mode,
        authorizationEpoch: executionBoundary.authorizationEpoch,
      }))
    ) {
      throw new Error("checkout provider operation fence was lost");
    }
    providerTransportStarted = true;
    payment =
      plan.offerType === "one_time"
        ? await client.createOneTimePayment(paymentInput)
        : await client.createFirstPayment(paymentInput);
  } catch (error) {
    if (providerTransportStarted) {
      const ambiguousFinalized = await finalizePaymentProviderOperation({
        operationId: paymentCreationClaim.operationId,
        leaseToken: paymentCreationClaim.leaseToken,
        outcome: "ambiguous",
        workspaceId: input.workspaceId,
        mode: config.mode,
        authorizationEpoch: executionBoundary.authorizationEpoch,
        intentId: intent.intentId,
        targetCustomerId: customerId,
      });
      if (ambiguousFinalized.recorded && ambiguousFinalized.authorized) {
        await markIntentApiUnknown(intent.intentId);
      }
    }
    throw error;
  }
  const paymentFinalized = await finalizePaymentProviderOperation({
    operationId: paymentCreationClaim.operationId,
    leaseToken: paymentCreationClaim.leaseToken,
    outcome: "succeeded",
    providerResourceId: validMolliePaymentIdOrNull(payment.id) ?? undefined,
    workspaceId: input.workspaceId,
    mode: config.mode,
    authorizationEpoch: executionBoundary.authorizationEpoch,
    intentId: intent.intentId,
    targetCustomerId: customerId,
  });
  if (!paymentFinalized.recorded) {
    throw new Error("checkout provider result fence was lost");
  }
  if (!paymentFinalized.authorized) {
    throw new Error("checkout provider result was contained");
  }
  try {
    validatePaymentResponse({
      payment,
      intentId: intent.intentId,
      customerId,
      amount: formatAmountMinor(plan.amountMinor),
      mode: config.mode,
    });
  } catch (error) {
    await markIntentPaymentMismatch({
      intentId: intent.intentId,
      workspaceId: intent.workspaceId,
      mode: intent.mode,
      molliePaymentId: validMolliePaymentIdOrNull(payment.id),
      operationId: paymentCreationClaim.operationId,
      authorizationEpoch: executionBoundary.authorizationEpoch,
      targetCustomerId: customerId,
    });
    throw error;
  }
  const attached = await attachMolliePayment({
    intentId: intent.intentId,
    workspaceId: intent.workspaceId,
    mode: intent.mode,
    molliePaymentId: payment.id,
    billingProfileVersion: billingProfile.eligibilityVersion,
    authorizationEpoch: executionBoundary.authorizationEpoch,
    operationId: paymentCreationClaim.operationId,
    targetCustomerId: customerId,
  });
  if (!attached) {
    throw new Error("checkout was superseded before it could be opened");
  }
  if (
    !(await isCheckoutUrlExposureAllowed({
      intentId: intent.intentId,
      workspaceId: input.workspaceId,
      mode: config.mode,
      molliePaymentId: payment.id,
      billingProfileVersion: billingProfile.eligibilityVersion,
      authorizationEpoch: executionBoundary.authorizationEpoch,
    }))
  ) {
    throw new Error("checkout was contained before URL exposure");
  }
  return {
    intentId: intent.intentId,
    checkoutUrl: client.getHostedCheckoutUrl(payment),
    status: "open" as const,
  };
}

export function assertCheckoutKindMatchesPlan(
  offerType: "subscription" | "one_time",
  kind: CheckoutKind
): void {
  if (
    (offerType === "one_time" && kind !== "startpilot_purchase") ||
    (offerType === "subscription" && kind === "startpilot_purchase")
  ) {
    throw new Error("billing plan and checkout kind do not match");
  }
}

async function assertPaymentMethodChangeIsSafe(
  workspaceId: number,
  mode: "test" | "live",
  client: MollieClient,
  now: Date
): Promise<void> {
  const subscription = await getWorkspaceBillingSubscription(workspaceId, mode);
  if (
    !subscription ||
    subscription.status !== "active" ||
    !subscription.mollieSubscriptionId
  ) {
    throw new Error("payment method cannot be changed in the current state");
  }
  const remote = await client.getSubscription(
    subscription.mollieCustomerId,
    subscription.mollieSubscriptionId
  );
  if (
    remote.id !== subscription.mollieSubscriptionId ||
    remote.mode !== mode ||
    remote.status !== "active" ||
    !isOutsidePaymentMethodChangeCollectionWindow(remote.nextPaymentDate, now)
  ) {
    throw new Error("payment method change is too close to collection");
  }
  const payments = await client.listCustomerPayments(
    subscription.mollieCustomerId
  );
  if (
    hasExistingSubscriptionCollectionRisk(
      payments,
      subscription.mollieSubscriptionId,
      subscription.paidThrough
    )
  ) {
    throw new Error("an existing subscription collection is still in progress");
  }
}

export function isOutsidePaymentMethodChangeCollectionWindow(
  nextPaymentDate: string | null | undefined,
  now: Date
): boolean {
  if (!nextPaymentDate || !/^\d{4}-\d{2}-\d{2}$/.test(nextPaymentDate)) {
    return false;
  }
  const parsed = new Date(`${nextPaymentDate}T00:00:00.000Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== nextPaymentDate
  ) {
    return false;
  }
  return (
    parsed.getTime() - now.getTime() >
    PAYMENT_METHOD_CHANGE_GUARD_DAYS * 24 * 60 * 60 * 1_000
  );
}

export function hasExistingSubscriptionCollectionRisk(
  payments: ReadonlyArray<{
    subscriptionId?: string | null;
    status: string;
    createdAt: string;
  }>,
  subscriptionId: string,
  paidThrough: Date | null
): boolean {
  const unsettled = new Set(["open", "pending", "authorized"]);
  return payments.some(payment => {
    if (payment.subscriptionId !== subscriptionId) return false;
    if (unsettled.has(payment.status)) return true;
    if (!paidThrough) return true;
    const createdAt = Date.parse(payment.createdAt);
    return !Number.isFinite(createdAt) || createdAt >= paidThrough.getTime();
  });
}

export async function cancelMollieSubscriptionAtPeriodEnd(workspaceId: number) {
  const config = getMollieConfig();
  assertTenantBillingWorkerWorkspace(workspaceId);
  return requestWorkspaceSubscriptionCancellation(workspaceId, config.mode);
}

export async function getMollieLaunchCheck(
  clientOverride?: MollieClient,
  options: { phase?: "offline" | "provider" } = {}
) {
  const phase = options.phase ?? "provider";
  const mode = getConfiguredBillingMode();
  const config = phase === "provider" ? getMollieConfig() : null;
  const methods = config
    ? await checkMollieOneTimePaymentMethod(
        clientOverride ?? new MollieClient(config)
      )
    : { bancontact: false, providerChecked: false };
  let credentialFreeGatesReady = false;
  try {
    const requireOperationalFlags = phase === "provider";
    assertMollieNonSecretLaunchConfig({ requireOperationalFlags });
    if (requireOperationalFlags) {
      assertBillingNotificationConfig();
    }
    await assertBillingDatabaseReadiness(mode, {
      requireRuntimeHeartbeat: requireOperationalFlags,
    });
    credentialFreeGatesReady = true;
  } catch {
    credentialFreeGatesReady = false;
  }
  const sandboxReady =
    phase === "provider" &&
    mode === "test" &&
    methods.bancontact &&
    credentialFreeGatesReady;
  const liveReady =
    phase === "provider" &&
    mode === "live" &&
    isMollieBillingEnabled() &&
    Boolean(config?.liveBillingEnabled) &&
    methods.bancontact &&
    credentialFreeGatesReady;
  return {
    ...methods,
    ok: phase === "offline" ? credentialFreeGatesReady : liveReady,
    phase,
    sandboxReady,
    liveReady,
    offerType: "one_time" as const,
    paymentSequenceType: "oneoff" as const,
    sepaDirectDebitRequired: false,
    mode,
    liveBillingEnabled: config?.liveBillingEnabled ?? false,
    billingScheduler: getBillingSchedulerRollout(),
    credentialFreeGatesReady,
    salesCountry: "BE" as const,
    currency: "EUR" as const,
    b2bCheckoutEnabled: false,
  };
}

function validatePaymentResponse(input: {
  payment: {
    id: string;
    mode: "test" | "live";
    amount: { value: string; currency: string };
    customerId?: string | null;
    metadata?: unknown;
  };
  intentId: string;
  customerId: string;
  amount: string;
  mode: "test" | "live";
}): void {
  assertMollieId(input.payment.id, "tr_");
  const metadata = input.payment.metadata;
  if (
    input.payment.mode !== input.mode ||
    input.payment.amount.currency !== "EUR" ||
    input.payment.amount.value !== input.amount ||
    input.payment.customerId !== input.customerId ||
    !metadata ||
    typeof metadata !== "object" ||
    (metadata as Record<string, unknown>).billingIntentId !== input.intentId
  ) {
    throw new Error("Mollie payment response did not match the billing intent");
  }
}

function validMolliePaymentIdOrNull(value: string): string | null {
  try {
    assertMollieId(value, "tr_");
    return value;
  } catch {
    return null;
  }
}

export async function getCheckoutReturnStatus(
  workspaceId: number,
  intentId: string
) {
  const config = getMollieConfig();
  const intent = await getBillingIntent(intentId, workspaceId, config.mode);
  if (!intent) {
    throw new Error("billing intent not found");
  }
  return {
    intentId: intent.intentId,
    status: intent.status,
    paid: intent.status === "paid",
  };
}
