import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  database: {},
  getDatabaseOrThrow: vi.fn(),
  assertBillingOperatorPrincipal: vi.fn(),
  assertTestPaymentOperatorReadback: vi.fn(),
  resolveBillingOperatorOwner: vi.fn(),
  registerBillingSchedulerTenant: vi.fn(),
  enableBillingSchedulerTenant: vi.fn(),
}));
vi.mock("../../db", () => ({ getDatabaseOrThrow: mocks.getDatabaseOrThrow }));
vi.mock("./billingSchedulerStore", () => mocks);

import {
  enableTestPayments,
  readTestPaymentOperatorEnv,
} from "./testPaymentOperator";

function validEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "production",
    MOLLIE_MODE: "test",
    MOLLIE_BILLING_SCHEDULER_MODE: "pilot_pin",
    MOLLIE_CREDIT_WORKSPACE_ID: "1",
    MOLLIE_BILLING_WORKER_WORKSPACE_ID: "1",
    BILLING_NOTIFICATION_PLANE_ENABLED: "true",
    MOLLIE_BILLING_DRAIN_ENABLED: "true",
    MOLLIE_RECONCILIATION_ENABLED: "true",
    MOLLIE_BILLING_ENABLED: "false",
    MOLLIE_LIVE_BILLING_ENABLED: "false",
    MOLLIE_CREDIT_CHECKOUT_ENABLED: "false",
    MESSENGER_PAID_CREDITS_ENABLED: "false",
    LEADERBOT_DEPLOYMENT_IDENTITY: "deploy-123-1",
    EXPECTED_RUNTIME_PRINCIPAL_SHA256: "a".repeat(64),
    LEADERBOT_TEST_PAYMENT_OPERATOR_WORKSPACE_ID: "1",
    LEADERBOT_TEST_PAYMENT_OPERATOR_REQUEST_ID:
      "12345678-1234-4234-8234-123456789012",
    LEADERBOT_TEST_PAYMENT_OPERATOR_EXPECTED_EPOCH: "1",
    LEADERBOT_TEST_PAYMENT_OPERATOR_GITHUB_ACTOR_ID: "123",
    LEADERBOT_TEST_PAYMENT_OPERATOR_GITHUB_RUN_ID: "456",
    LEADERBOT_TEST_PAYMENT_OPERATOR_GITHUB_RUN_ATTEMPT: "1",
    LEADERBOT_TEST_PAYMENT_OPERATOR_SOURCE_SHA: "b".repeat(40),
    LEADERBOT_TEST_PAYMENT_OPERATOR_DEPLOYMENT_IDENTITY: "deploy-123-1",
    LEADERBOT_TEST_PAYMENT_OPERATOR_OPERATOR_IMAGE: `registry.fly.io/leaderbot-fb-image-gen@sha256:${"c".repeat(64)}`,
    LEADERBOT_TEST_PAYMENT_OPERATOR_ARTIFACT_SOURCE_SHA: "d".repeat(40),
    LEADERBOT_TEST_PAYMENT_OPERATOR_BUNDLE_SHA256: "e".repeat(64),
    LEADERBOT_TEST_PAYMENT_OPERATOR_RUNTIME_IMAGE: `registry.fly.io/leaderbot-fb-image-gen@sha256:${"f".repeat(64)}`,
  };
}

describe("protected Test Mode payment operator", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getDatabaseOrThrow.mockResolvedValue(mocks.database);
    mocks.resolveBillingOperatorOwner.mockResolvedValue(7);
    mocks.enableBillingSchedulerTenant.mockResolvedValue({ executionEpoch: 2 });
  });

  it("uses the real owner to enable existing state without registration or browser identity", async () => {
    const env = validEnv();
    const input = readTestPaymentOperatorEnv(env);
    await expect(enableTestPayments(env)).resolves.toEqual({
      event: "test_payment_operator_completed",
      status: "enabled",
      mode: "test",
      workspaceId: 1,
      requestId: input.requestId,
      executionEpoch: 2,
      committed: true,
      ...input.operatorAudit,
    });
    expect(mocks.assertBillingOperatorPrincipal).toHaveBeenCalledWith(
      mocks.database,
      "a".repeat(64)
    );
    expect(mocks.resolveBillingOperatorOwner).toHaveBeenCalledWith(1);
    expect(mocks.registerBillingSchedulerTenant).not.toHaveBeenCalled();
    expect(input.operatorAudit).toMatchObject({
      operatorImage: `registry.fly.io/leaderbot-fb-image-gen@sha256:${"c".repeat(64)}`,
      artifactSourceSha: "d".repeat(40),
      bundleSha256: "e".repeat(64),
      runtimeImage: `registry.fly.io/leaderbot-fb-image-gen@sha256:${"f".repeat(64)}`,
    });
    expect(mocks.enableBillingSchedulerTenant).toHaveBeenCalledExactlyOnceWith({
      ...input,
      actorUserId: 7,
      mode: "test",
      reason: "protected workflow test payment preparation",
    });
    expect(mocks.assertTestPaymentOperatorReadback).toHaveBeenCalledWith({
      workspaceId: 1,
      actorUserId: 7,
      requestId: input.requestId,
      executionEpoch: 2,
    });
    expect(
      mocks.resolveBillingOperatorOwner.mock.invocationCallOrder[0]
    ).toBeLessThan(
      mocks.enableBillingSchedulerTenant.mock.invocationCallOrder[0]!
    );
  });

  it.each([
    ["NODE_ENV", "development"],
    ["MOLLIE_MODE", "live"],
    ["MOLLIE_BILLING_SCHEDULER_MODE", "multi_tenant"],
    ["MOLLIE_CREDIT_WORKSPACE_ID", "2"],
    ["MOLLIE_BILLING_WORKER_WORKSPACE_ID", "2"],
    ["BILLING_NOTIFICATION_PLANE_ENABLED", "false"],
    ["MOLLIE_BILLING_DRAIN_ENABLED", "false"],
    ["MOLLIE_RECONCILIATION_ENABLED", "false"],
    ["MOLLIE_BILLING_ENABLED", "true"],
    ["MOLLIE_LIVE_BILLING_ENABLED", "true"],
    ["MOLLIE_CREDIT_CHECKOUT_ENABLED", "true"],
    ["MESSENGER_PAID_CREDITS_ENABLED", "true"],
    ["LEADERBOT_DEPLOYMENT_IDENTITY", "deploy-999-1"],
    ["EXPECTED_RUNTIME_PRINCIPAL_SHA256", "not-a-hash"],
    ["LEADERBOT_TEST_PAYMENT_OPERATOR_WORKSPACE_ID", "0"],
    ["LEADERBOT_TEST_PAYMENT_OPERATOR_WORKSPACE_ID", "1e0"],
    [
      "LEADERBOT_TEST_PAYMENT_OPERATOR_REQUEST_ID",
      "------------------------------------",
    ],
    ["LEADERBOT_TEST_PAYMENT_OPERATOR_EXPECTED_EPOCH", "2147483647"],
    ["LEADERBOT_TEST_PAYMENT_OPERATOR_EXPECTED_EPOCH", "0"],
    ["LEADERBOT_TEST_PAYMENT_OPERATOR_GITHUB_ACTOR_ID", "0"],
    ["LEADERBOT_TEST_PAYMENT_OPERATOR_GITHUB_RUN_ID", "private-value"],
    ["LEADERBOT_TEST_PAYMENT_OPERATOR_GITHUB_RUN_ATTEMPT", "1.5"],
    ["LEADERBOT_TEST_PAYMENT_OPERATOR_SOURCE_SHA", "not-reviewed"],
    ["LEADERBOT_TEST_PAYMENT_OPERATOR_DEPLOYMENT_IDENTITY", "none"],
    [
      "LEADERBOT_TEST_PAYMENT_OPERATOR_OPERATOR_IMAGE",
      "registry.fly.io/leaderbot-fb-image-gen:latest",
    ],
    [
      "LEADERBOT_TEST_PAYMENT_OPERATOR_OPERATOR_IMAGE",
      `registry.fly.io/another-app@sha256:${"c".repeat(64)}`,
    ],
    ["LEADERBOT_TEST_PAYMENT_OPERATOR_ARTIFACT_SOURCE_SHA", "not-reviewed"],
    ["LEADERBOT_TEST_PAYMENT_OPERATOR_BUNDLE_SHA256", "e".repeat(63)],
    [
      "LEADERBOT_TEST_PAYMENT_OPERATOR_RUNTIME_IMAGE",
      "registry.fly.io/leaderbot-fb-image-gen:latest",
    ],
    [
      "LEADERBOT_TEST_PAYMENT_OPERATOR_RUNTIME_IMAGE",
      `registry.fly.io/leaderbot-fb-image-gen@sha256:${"F".repeat(64)}`,
    ],
    ["MOLLIE_CREDIT_TEST_CHANNEL_CONNECTION_ID", "1"],
    ["MOLLIE_CREDIT_TEST_BINDING_EPOCH", "1"],
    ["MOLLIE_CREDIT_TEST_PRIVACY_EPOCH", "1"],
    ["MOLLIE_CREDIT_TEST_USER_KEY_HASH", "a".repeat(64)],
  ])("rejects invalid %s before any database access", async (name, value) => {
    await expect(
      enableTestPayments({ ...validEnv(), [name]: value })
    ).rejects.toMatchObject({
      failedStage: "config",
      outcome: "not_started",
    });
    expect(mocks.getDatabaseOrThrow).not.toHaveBeenCalled();
    expect(mocks.registerBillingSchedulerTenant).not.toHaveBeenCalled();
  });

  it.each(Object.keys(validEnv()))("requires explicit %s", async name => {
    const env = validEnv();
    delete env[name];
    await expect(enableTestPayments(env)).rejects.toMatchObject({
      failedStage: "config",
    });
    expect(mocks.getDatabaseOrThrow).not.toHaveBeenCalled();
  });

  it.each(["principal", "owner"])(
    "rejects unavailable %s before activation",
    async failure => {
      const error = new Error("private owner or credential details");
      if (failure === "principal")
        mocks.assertBillingOperatorPrincipal.mockRejectedValue(error);
      else mocks.resolveBillingOperatorOwner.mockRejectedValue(error);
      await expect(enableTestPayments(validEnv())).rejects.toMatchObject({
        failedStage: "owner",
        outcome: "not_started",
        message: "Test payment operator action failed",
      });
      expect(mocks.registerBillingSchedulerTenant).not.toHaveBeenCalled();
      expect(mocks.enableBillingSchedulerTenant).not.toHaveBeenCalled();
    }
  );

  it("does not bootstrap or retry when existing control or lane rows are absent", async () => {
    mocks.enableBillingSchedulerTenant.mockRejectedValue(
      new Error("billing scheduler tenant missing")
    );
    await expect(enableTestPayments(validEnv())).rejects.toMatchObject({
      failedStage: "activation",
      outcome: "unknown",
    });
    expect(mocks.enableBillingSchedulerTenant).toHaveBeenCalledOnce();
    expect(mocks.registerBillingSchedulerTenant).not.toHaveBeenCalled();
    expect(mocks.assertTestPaymentOperatorReadback).not.toHaveBeenCalled();
  });

  it("reports ambiguous activation without retrying or changing request identity", async () => {
    mocks.enableBillingSchedulerTenant.mockRejectedValue(
      new Error("response lost after commit")
    );
    await expect(enableTestPayments(validEnv())).rejects.toMatchObject({
      failedStage: "activation",
      outcome: "unknown",
    });
    expect(mocks.enableBillingSchedulerTenant).toHaveBeenCalledOnce();
    expect(mocks.registerBillingSchedulerTenant).not.toHaveBeenCalled();
  });

  it("preserves confirmed commit metadata when subsequent readback fails", async () => {
    mocks.assertTestPaymentOperatorReadback.mockRejectedValue(
      new Error("connection lost")
    );
    await expect(enableTestPayments(validEnv())).rejects.toMatchObject({
      failedStage: "readback",
      outcome: "unknown",
      committed: true,
    });
    expect(mocks.enableBillingSchedulerTenant).toHaveBeenCalledOnce();
  });
});
