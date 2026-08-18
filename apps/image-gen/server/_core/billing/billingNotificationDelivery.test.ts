import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertBillingNotificationConfig,
  deliverBillingNotification,
} from "./billingNotificationDelivery";

const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
});

describe("metadata-only billing notification delivery", () => {
  it("rejects shared audience credentials and a mismatched receiver source", () => {
    process.env.NODE_ENV = "test";
    process.env.MOLLIE_MODE = "test";
    process.env.BILLING_NOTIFICATION_SOURCE_ID = "source-a";
    process.env.BILLING_NOTIFICATION_RECEIVER_SOURCE_ID = "source-a";
    process.env.BILLING_NOTIFICATION_RECEIVER_PUBLIC_ORIGIN =
      "https://receiver.example";
    process.env.BILLING_NOTIFICATION_RECEIVER_PREFLIGHT_ACK = "true";
    process.env.BILLING_CUSTOMER_NOTIFICATION_WEBHOOK_URL =
      "https://receiver.example/api/internal/billing/notifications/customer";
    process.env.BILLING_OPERATOR_NOTIFICATION_WEBHOOK_URL =
      "https://receiver.example/api/internal/billing/notifications/operator";
    process.env.BILLING_CUSTOMER_NOTIFICATION_KEY_ID = "customer-v1";
    process.env.BILLING_OPERATOR_NOTIFICATION_KEY_ID = "operator-v1";
    process.env.BILLING_NOTIFICATION_RECEIVER_CUSTOMER_KEY_ID = "customer-v1";
    process.env.BILLING_NOTIFICATION_RECEIVER_OPERATOR_KEY_ID = "operator-v1";
    for (const name of [
      "BILLING_CUSTOMER_NOTIFICATION_SIGNING_SECRET",
      "BILLING_OPERATOR_NOTIFICATION_SIGNING_SECRET",
      "BILLING_NOTIFICATION_RECEIVER_CUSTOMER_SIGNING_SECRET",
      "BILLING_NOTIFICATION_RECEIVER_OPERATOR_SIGNING_SECRET",
    ]) {
      process.env[name] = "shared-signing-secret-that-is-at-least-32";
    }
    expect(() => assertBillingNotificationConfig()).toThrow(
      "notification_audience_keys_must_differ"
    );

    process.env.BILLING_OPERATOR_NOTIFICATION_SIGNING_SECRET =
      "operator-signing-secret-that-is-at-least-32";
    process.env.BILLING_NOTIFICATION_RECEIVER_OPERATOR_SIGNING_SECRET =
      "operator-signing-secret-that-is-at-least-32";
    process.env.BILLING_NOTIFICATION_RECEIVER_SOURCE_ID = "source-b";
    expect(() => assertBillingNotificationConfig()).toThrow(
      "notification_receiver_source_mismatch"
    );
  });
  it("delivers only bounded metadata to the configured customer destination", async () => {
    process.env.BILLING_CUSTOMER_NOTIFICATION_WEBHOOK_URL =
      "https://notify.example/customer";
    process.env.BILLING_CUSTOMER_NOTIFICATION_SIGNING_SECRET =
      "test-notification-signing-secret-32-bytes";
    process.env.BILLING_CUSTOMER_NOTIFICATION_KEY_ID = "customer-v1";
    process.env.BILLING_NOTIFICATION_SOURCE_ID = "leaderbot-test";
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("", { status: 200 }));
    await deliverBillingNotification(
      {
        id: 9,
        deliveryId: "11111111-1111-4111-8111-111111111111",
        workspaceId: 42,
        mode: "test",
        eventType: "payment_warning",
        attemptCount: 2,
        createdAt: new Date("2026-08-18T10:00:00.000Z"),
        payload: {
          reason: "payment_failed",
          messengerSenderUserKey: "secret-user-key",
          molliePaymentId: "tr_secret",
        },
      },
      transport
    );
    const [url, request] = transport.mock.calls[0] as [URL, RequestInit];
    expect(url.toString()).toBe("https://notify.example/customer");
    const body = String(request.body);
    expect(JSON.parse(body)).toEqual({
      schema: "leaderbot.billing.notification.v1",
      deliveryId: "11111111-1111-4111-8111-111111111111",
      workspaceId: 42,
      mode: "test",
      eventType: "payment_warning",
      reason: "payment_failed",
      occurredAt: "2026-08-18T10:00:00.000Z",
    });
    expect(body).not.toContain("secret-user-key");
    expect(body).not.toContain("tr_secret");
    expect(request.redirect).toBe("error");
    expect(request.headers).toMatchObject({
      "Idempotency-Key":
        "billing-notification:leaderbot-test:test:11111111-1111-4111-8111-111111111111",
      "X-Leaderbot-Audience": "customer",
      "X-Leaderbot-Key-Id": "customer-v1",
      "X-Leaderbot-Transport-Attempt": "2",
      "X-Leaderbot-Timestamp": expect.any(String),
      "X-Leaderbot-Signature": expect.stringMatching(/^v1=[a-f0-9]{64}$/),
    });
    await deliverBillingNotification(
      {
        id: 9,
        deliveryId: "11111111-1111-4111-8111-111111111111",
        workspaceId: 42,
        mode: "test",
        eventType: "payment_warning",
        attemptCount: 3,
        createdAt: new Date("2026-08-18T10:00:00.000Z"),
        payload: { reason: "payment_failed" },
      },
      transport
    );
    const retryRequest = transport.mock.calls[1]?.[1] as RequestInit;
    expect(retryRequest.body).toBe(request.body);
    expect(retryRequest.headers).toMatchObject({
      "Idempotency-Key":
        "billing-notification:leaderbot-test:test:11111111-1111-4111-8111-111111111111",
      "X-Leaderbot-Transport-Attempt": "3",
    });
  });

  it("classifies transient transport failure for bounded outbox retry", async () => {
    process.env.BILLING_OPERATOR_NOTIFICATION_WEBHOOK_URL =
      "https://notify.example/operator";
    process.env.BILLING_OPERATOR_NOTIFICATION_SIGNING_SECRET =
      "test-notification-signing-secret-32-bytes";
    process.env.BILLING_OPERATOR_NOTIFICATION_KEY_ID = "operator-v1";
    process.env.BILLING_NOTIFICATION_SOURCE_ID = "leaderbot-test";
    const transport = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("", { status: 503 }));
    await expect(
      deliverBillingNotification(
        {
          id: 10,
          deliveryId: "22222222-2222-4222-8222-222222222222",
          workspaceId: 43,
          mode: "test",
          eventType: "manual_review",
          attemptCount: 1,
          createdAt: new Date("2026-08-18T10:00:00.000Z"),
          payload: { reason: "payment_mismatch" },
        },
        transport
      )
    ).rejects.toThrow("notification_transport_retryable");
  });
});
