import { requireActiveBillingPlan, formatAmountMinor } from "./catalog";
import {
  assertMollieBillingEnabled,
  assertTenantBillingWorkerWorkspace,
  getMollieConfig,
  getTenantBillingWorkerWorkspaceId,
} from "./config";
import {
  attachMollieCustomer,
  attachMolliePayment,
  claimIntentPaymentCreation,
  getBillingCustomer,
  getBillingIntent,
  markBillingCustomerManualReview,
  markIntentApiUnknown,
  markIntentPaymentMismatch,
  reserveBillingCustomer,
  reserveCheckoutIntent,
  type CheckoutKind,
} from "./checkoutStore";
import {
  assertMollieId,
  checkMolliePaymentMethods,
  MollieClient,
} from "./mollieClient";
import {
  getWorkspaceBillingSubscription,
  requestWorkspaceSubscriptionCancellation,
} from "./subscriptionStore";

const PAYMENT_METHOD_CHANGE_GUARD_DAYS = 7;

export type CheckoutRequest = {
  workspaceId: number;
  planCode: string;
  countryCode: "BE";
  kind: CheckoutKind;
  businessCheckout?: boolean;
};

export async function startMollieCheckout(
  input: CheckoutRequest,
  clientOverride?: MollieClient
) {
  assertMollieBillingEnabled();
  assertTenantBillingWorkerWorkspace(input.workspaceId);
  if (input.countryCode !== "BE") {
    throw new Error("Leaderbot billing is available in Belgium only");
  }
  if (input.businessCheckout) {
    throw new Error(
      "B2B checkout is unavailable until Peppol invoicing is configured"
    );
  }

  const plan = requireActiveBillingPlan(input.planCode);
  const config = getMollieConfig();
  const client = clientOverride ?? new MollieClient(config);
  const methods = await checkMolliePaymentMethods(client, config.mode);
  if (!methods.bancontact || !methods.sepaDirectDebit) {
    throw new Error(
      "Mollie Bancontact and SEPA Direct Debit must both be enabled before checkout"
    );
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
  });

  if (intent.molliePaymentId) {
    const storedCustomer = await getBillingCustomer(
      input.workspaceId,
      config.mode
    );
    if (!storedCustomer?.mollieCustomerId) {
      throw new Error("billing customer is not ready");
    }
    const existingPayment = await client.getPayment(intent.molliePaymentId);
    validatePaymentResponse({
      payment: existingPayment,
      intentId: intent.intentId,
      customerId: storedCustomer.mollieCustomerId,
      amount: formatAmountMinor(plan.amountMinor),
      mode: config.mode,
    });
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
    try {
      const mollieCustomer = await client.createCustomer({
        externalReference: customer.externalReference,
        idempotencyKey: customer.idempotencyKey,
      });
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
      await markBillingCustomerManualReview(input.workspaceId, config.mode);
      throw error;
    }
  }

  const customerId = customer.mollieCustomerId;
  if (!customerId) {
    throw new Error("billing customer is not ready");
  }

  const paymentCreationClaimed = await claimIntentPaymentCreation(
    intent.intentId
  );
  if (!paymentCreationClaimed) {
    throw new Error(
      "checkout creation is being reconciled; no retry was issued"
    );
  }
  let payment: Awaited<ReturnType<MollieClient["createFirstPayment"]>>;
  try {
    payment = await client.createFirstPayment({
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
    });
  } catch (error) {
    await markIntentApiUnknown(intent.intentId);
    throw error;
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
    });
    throw error;
  }
  const attached = await attachMolliePayment({
    intentId: intent.intentId,
    workspaceId: intent.workspaceId,
    mode: intent.mode,
    molliePaymentId: payment.id,
  });
  if (!attached) {
    throw new Error("checkout was superseded before it could be opened");
  }
  return {
    intentId: intent.intentId,
    checkoutUrl: client.getHostedCheckoutUrl(payment),
    status: "open" as const,
  };
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

export async function getMollieLaunchCheck(clientOverride?: MollieClient) {
  const config = getMollieConfig();
  const client = clientOverride ?? new MollieClient(config);
  const methods = await checkMolliePaymentMethods(client, config.mode);
  return {
    ...methods,
    mode: config.mode,
    liveBillingEnabled: config.liveBillingEnabled,
    tenantWorkerConfigured: getTenantBillingWorkerWorkspaceId() !== null,
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
