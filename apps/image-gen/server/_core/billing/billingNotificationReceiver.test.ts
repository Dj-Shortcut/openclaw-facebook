import { createHash, createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getDatabaseOrThrowMock } = vi.hoisted(() => ({
  getDatabaseOrThrowMock: vi.fn(),
}));

vi.mock("../../db", () => ({ getDatabaseOrThrow: getDatabaseOrThrowMock }));

import {
  BillingNotificationReceiverError,
  receiveBillingNotification,
} from "./billingNotificationReceiver";

const originalEnv = { ...process.env };
const secret = "receiver-signing-secret-that-is-long-enough";
const deliveryId = "550e8400-e29b-41d4-a716-446655440000";
const occurredAt = "2026-08-18T10:00:00.000Z";
const now = new Date("2026-08-18T10:00:30.000Z");

describe("first-party billing notification receiver", () => {
  beforeEach(() => {
    process.env.BILLING_NOTIFICATION_RECEIVER_OPERATOR_KEY_ID = "operator-v1";
    process.env.BILLING_NOTIFICATION_RECEIVER_OPERATOR_SIGNING_SECRET = secret;
    process.env.BILLING_NOTIFICATION_RECEIVER_SOURCE_ID = "source-a";
    getDatabaseOrThrowMock.mockReset();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("atomically stores one metadata-only receipt and local delivery", async () => {
    const inserts: unknown[] = [];
    getDatabaseOrThrowMock.mockResolvedValue(databaseFlow(null, inserts));
    await expect(receiveBillingNotification(request())).resolves.toBe(
      "accepted"
    );
    expect(inserts).toHaveLength(3);
    expect(JSON.stringify(inserts)).not.toContain("customer message");
  });

  it("ACKs an exact retry and conflicts on a changed body digest", async () => {
    const signed = request();
    const digest = createHash("sha256").update(signed.rawBody).digest("hex");
    getDatabaseOrThrowMock.mockResolvedValue(
      databaseFlow({ bodyDigest: digest, audience: "operator" }, [])
    );
    await expect(receiveBillingNotification(signed)).resolves.toBe("duplicate");

    getDatabaseOrThrowMock.mockResolvedValue(
      databaseFlow({ bodyDigest: "0".repeat(64), audience: "operator" }, [])
    );
    await expect(receiveBillingNotification(signed)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it("rejects stale or invalid signatures before touching the database", async () => {
    const stale = request(new Date("2026-08-18T09:00:00.000Z"));
    await expect(receiveBillingNotification(stale)).rejects.toBeInstanceOf(
      BillingNotificationReceiverError
    );
    const invalid = request();
    invalid.headers = { ...invalid.headers, signature: `v1=${"0".repeat(64)}` };
    await expect(receiveBillingNotification(invalid)).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(getDatabaseOrThrowMock).not.toHaveBeenCalled();
  });

  it("binds route, source, audience, and canonical signature", async () => {
    const wrongRoute = request();
    wrongRoute.routeAudience = "customer";
    await expect(receiveBillingNotification(wrongRoute)).rejects.toMatchObject({
      statusCode: 400,
    });

    const bareSignature = request();
    bareSignature.headers = {
      ...bareSignature.headers,
      signature: bareSignature.headers.signature.slice(3),
    };
    await expect(
      receiveBillingNotification(bareSignature)
    ).rejects.toMatchObject({
      statusCode: 401,
    });

    process.env.BILLING_NOTIFICATION_RECEIVER_SOURCE_ID = "different-source";
    await expect(receiveBillingNotification(request())).rejects.toMatchObject({
      statusCode: 401,
    });
    expect(getDatabaseOrThrowMock).not.toHaveBeenCalled();
  });

  it("rejects unknown reasons and extra metadata before persistence", async () => {
    const invalid = request();
    invalid.rawBody = JSON.stringify({
      ...JSON.parse(invalid.rawBody),
      reason: "customer message with possible PII",
      details: "must not persist",
    });
    resign(invalid);
    await expect(receiveBillingNotification(invalid)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(getDatabaseOrThrowMock).not.toHaveBeenCalled();
  });
});

function request(timestampDate = now) {
  const rawBody = JSON.stringify({
    schema: "leaderbot.billing.notification.v1",
    deliveryId,
    workspaceId: 42,
    mode: "test",
    eventType: "manual_review",
    reason: "billing_profile_revoked",
    occurredAt,
  });
  const timestamp = Math.floor(timestampDate.getTime() / 1_000).toString();
  const idempotencyKey = `billing-notification:source-a:test:${deliveryId}`;
  const originAndPath =
    "https://receiver.test/api/internal/billing/notifications/operator";
  const digest = createHash("sha256").update(rawBody).digest("hex");
  const canonical = [
    "v1",
    "POST",
    originAndPath,
    "operator",
    "operator-v1",
    timestamp,
    idempotencyKey,
    digest,
  ].join("\n");
  return {
    rawBody,
    method: "POST" as const,
    originAndPath,
    routeAudience: "operator",
    now,
    headers: {
      audience: "operator",
      keyId: "operator-v1",
      timestamp,
      idempotencyKey,
      signature: `v1=${createHmac("sha256", secret).update(canonical).digest("hex")}`,
    },
  };
}

function resign(input: ReturnType<typeof request>): void {
  const digest = createHash("sha256").update(input.rawBody).digest("hex");
  const canonical = [
    "v1",
    input.method,
    input.originAndPath,
    input.headers.audience,
    input.headers.keyId,
    input.headers.timestamp,
    input.headers.idempotencyKey,
    digest,
  ].join("\n");
  input.headers = {
    ...input.headers,
    signature: `v1=${createHmac("sha256", secret)
      .update(canonical)
      .digest("hex")}`,
  };
}

function databaseFlow(
  existing: { bodyDigest: string; audience: string } | null,
  inserts: unknown[]
) {
  const tx = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => ({
            for: vi.fn(async () => (existing ? [existing] : [])),
          })),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(value => {
        inserts.push(value);
        const result = [{ insertId: inserts.length === 1 ? 17 : 18 }];
        return {
          onDuplicateKeyUpdate: vi.fn(async () => undefined),
          then: (
            resolve: (value: typeof result) => unknown,
            reject?: (reason: unknown) => unknown
          ) => Promise.resolve(result).then(resolve, reject),
        };
      }),
    })),
  };
  return {
    transaction: vi.fn(async callback => callback(tx)),
  };
}
