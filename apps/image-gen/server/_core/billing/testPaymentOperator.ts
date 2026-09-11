import { getDatabaseOrThrow } from "../../db";
import {
  assertBillingOperatorPrincipal,
  assertTestPaymentOperatorReadback,
  enableBillingSchedulerTenant,
  registerBillingSchedulerTenant,
  resolveBillingOperatorOwner,
  type BillingSchedulerOperatorAudit,
} from "./billingSchedulerStore";

type OperatorStage =
  "config" | "owner" | "registration" | "activation" | "readback";
export class TestPaymentOperatorError extends Error {
  constructor(
    readonly failedStage: OperatorStage,
    readonly outcome: "not_started" | "unknown",
    readonly committed = false
  ) {
    super("Test payment operator action failed");
    this.name = "TestPaymentOperatorError";
  }
}

const PREFIX = "LEADERBOT_TEST_PAYMENT_OPERATOR_";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const POSITIVE_ID = /^[1-9][0-9]{0,19}$/;

function rejectConfig(): never {
  throw new TestPaymentOperatorError("config", "not_started");
}

function exactValue(
  env: NodeJS.ProcessEnv,
  name: string,
  pattern: RegExp
): string {
  const value = env[name];
  if (typeof value !== "string" || !pattern.test(value)) rejectConfig();
  return value;
}

function databaseId(
  env: NodeJS.ProcessEnv,
  name: string,
  maximum = 2_147_483_647
): number {
  const value = Number(exactValue(env, name, POSITIVE_ID));
  if (!Number.isSafeInteger(value) || value > maximum) rejectConfig();
  return value;
}

export function readTestPaymentOperatorEnv(
  env: NodeJS.ProcessEnv = process.env
) {
  const requiredValues: Record<string, string> = {
    NODE_ENV: "production",
    MOLLIE_MODE: "test",
    MOLLIE_BILLING_SCHEDULER_MODE: "pilot_pin",
    BILLING_NOTIFICATION_PLANE_ENABLED: "true",
    MOLLIE_BILLING_DRAIN_ENABLED: "true",
    MOLLIE_RECONCILIATION_ENABLED: "true",
    MOLLIE_BILLING_ENABLED: "false",
    MOLLIE_LIVE_BILLING_ENABLED: "false",
    MOLLIE_CREDIT_CHECKOUT_ENABLED: "false",
    MESSENGER_PAID_CREDITS_ENABLED: "false",
  };
  if (
    Object.entries(requiredValues).some(
      ([name, expected]) => env[name] !== expected
    )
  )
    rejectConfig();
  for (const name of [
    "MOLLIE_CREDIT_TEST_CHANNEL_CONNECTION_ID",
    "MOLLIE_CREDIT_TEST_BINDING_EPOCH",
    "MOLLIE_CREDIT_TEST_PRIVACY_EPOCH",
    "MOLLIE_CREDIT_TEST_USER_KEY_HASH",
  ]) {
    if (env[name] !== undefined && env[name] !== "") rejectConfig();
  }
  const workspaceId = databaseId(env, `${PREFIX}WORKSPACE_ID`);
  if (
    databaseId(env, "MOLLIE_CREDIT_WORKSPACE_ID") !== workspaceId ||
    databaseId(env, "MOLLIE_BILLING_WORKER_WORKSPACE_ID") !== workspaceId
  )
    rejectConfig();
  const deploymentIdentity = exactValue(
    env,
    `${PREFIX}DEPLOYMENT_IDENTITY`,
    /^deploy-[1-9][0-9]{0,19}-[1-9][0-9]{0,9}$/
  );
  if (deploymentIdentity !== env.LEADERBOT_DEPLOYMENT_IDENTITY) rejectConfig();
  const operatorAudit: BillingSchedulerOperatorAudit = Object.freeze({
    source: "protected_workflow",
    githubActorId: exactValue(env, `${PREFIX}GITHUB_ACTOR_ID`, POSITIVE_ID),
    githubRunId: exactValue(env, `${PREFIX}GITHUB_RUN_ID`, POSITIVE_ID),
    githubRunAttempt: databaseId(env, `${PREFIX}GITHUB_RUN_ATTEMPT`),
    sourceSha: exactValue(env, `${PREFIX}SOURCE_SHA`, /^[a-f0-9]{40}$/),
    deploymentIdentity,
    runtimePrincipalSha256: exactValue(
      env,
      "EXPECTED_RUNTIME_PRINCIPAL_SHA256",
      /^[a-f0-9]{64}$/
    ),
  });
  return Object.freeze({
    workspaceId,
    requestId: exactValue(env, `${PREFIX}REQUEST_ID`, UUID),
    expectedExecutionEpoch: databaseId(
      env,
      `${PREFIX}EXPECTED_EPOCH`,
      2_147_483_646
    ),
    operatorAudit,
  });
}

export async function enableTestPayments(env: NodeJS.ProcessEnv = process.env) {
  const input = readTestPaymentOperatorEnv(env);
  let stage: OperatorStage = "owner";
  let committed = false;
  try {
    // Verify the real pool credential, not an actor supplied by the workflow.
    await assertBillingOperatorPrincipal(
      await getDatabaseOrThrow(),
      input.operatorAudit.runtimePrincipalSha256
    );
    const actorUserId = await resolveBillingOperatorOwner(input.workspaceId);
    stage = "registration";
    await registerBillingSchedulerTenant(input.workspaceId, "test");
    stage = "activation";
    // Do not retry this call automatically. Replays must retain the original
    // request ID, expected epoch and complete protected-workflow provenance.
    const result = await enableBillingSchedulerTenant({
      ...input,
      actorUserId,
      mode: "test",
      reason: "protected workflow test payment preparation",
    });
    committed = true;
    stage = "readback";
    if (result.executionEpoch !== input.expectedExecutionEpoch + 1)
      throw new Error("unexpected billing operator epoch");
    await assertTestPaymentOperatorReadback({
      workspaceId: input.workspaceId,
      actorUserId,
      requestId: input.requestId,
      executionEpoch: result.executionEpoch,
    });
    return {
      event: "test_payment_operator_completed",
      status: "enabled",
      mode: "test",
      workspaceId: input.workspaceId,
      requestId: input.requestId,
      executionEpoch: result.executionEpoch,
      committed: true,
      ...input.operatorAudit,
    } as const;
  } catch {
    // A transaction response can be lost after commit. Never turn that into a
    // definitive rejection, fabricate a browser session, or issue another ID.
    throw new TestPaymentOperatorError(
      stage,
      stage === "activation" || committed ? "unknown" : "not_started",
      committed
    );
  }
}
