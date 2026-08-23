import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLogger, safeLog } from "./_core/logger";

function logUser(value: string): string {
  return `usr_${createHash("sha256").update(value).digest("hex").slice(0, 12)}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("safeLog routing", () => {
  it("emits structured info logs with redacted sensitive fields", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    safeLog("messenger_event", {
      user: "1234567890",
      psid: "secret-psid",
      accessToken: "secret-token",
      reason: "ok",
    });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));

    expect(payload).toEqual({
      level: "info",
      event: "messenger_event",
      user: logUser("1234567890"),
      reason: "ok",
    });
  });

  it("routes warning and error logs to the matching console methods", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    safeLog("warning_event", { level: "warn" });
    safeLog("error_event", { level: "error" });

    expect(JSON.parse(String(warnSpy.mock.calls[0]?.[0]))).toMatchObject({
      level: "warn",
      event: "warning_event",
    });
    expect(JSON.parse(String(errorSpy.mock.calls[0]?.[0]))).toMatchObject({
      level: "error",
      event: "error_event",
    });
  });
});

describe("createLogger redaction", () => {
  it("applies the same privacy boundary as safeLog", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logger = createLogger({
      reqId: "3f8161cc-ec79-4c80-aa63-cad8d9c107ab",
    });
    const privateExceptionContent =
      "raw-psid-123 private customer message that must never be logged";
    const exception = Object.assign(new TypeError(privateExceptionContent), {
      code: "UPSTREAM_REJECTED",
      cause: new Error(`private cause: ${privateExceptionContent}`),
    });

    logger.error({
      event: "whatsapp_graph_failed",
      body: "private message for +32470000000",
      senderId: "raw-sender-id",
      reason: "upstream rejected request",
      error: exception,
    });

    const payload = JSON.parse(String(errorSpy.mock.calls[0]?.[0]));
    expect(payload).toMatchObject({
      level: "error",
      event: "whatsapp_graph_failed",
      reqId: "3f8161cc-ec79-4c80-aa63-cad8d9c107ab",
      reason: "upstream rejected request",
      error: {
        class: "TypeError",
        code: "UPSTREAM_REJECTED",
      },
    });
    expect(payload).not.toHaveProperty("body");
    expect(payload).not.toHaveProperty("senderId");
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("+32470000000");
    expect(serialized).not.toContain(privateExceptionContent);
    expect(serialized).not.toContain("private cause");
  });
});

describe("safeLog redaction", () => {
  it("preserves already-hashed operational identifiers", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    safeLog("generation_diagnostic", {
      psidHash: "abc123",
      sender_id_hash: "def456",
      senderId: "raw-sender",
    });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));

    expect(payload).toMatchObject({
      psidHash: "abc123",
      sender_id_hash: "def456",
    });
    expect(payload).not.toHaveProperty("senderId");
  });

  it("keeps opaque request correlation while dropping raw webhook ids", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    safeLog("webhook_event", {
      reqId: "3f8161cc-ec79-4c80-aa63-cad8d9c107ab",
      entryId: "raw-page-id-123456789",
      eventId: "raw-message-id-sensitive",
      eventIdHash: "a1b2c3d4e5f6",
    });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));
    const serialized = JSON.stringify(payload);

    expect(payload).toMatchObject({
      reqId: "3f8161cc-ec79-4c80-aa63-cad8d9c107ab",
      eventIdHash: "a1b2c3d4e5f6",
    });
    expect(serialized).not.toContain("raw-page-id-123456789");
    expect(serialized).not.toContain("raw-message-id-sensitive");
  });

  it("keeps summarized URL fields while dropping raw URL fields", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    safeLog("url_event", {
      imageUrl: "example.com/path",
      publicUrl: "cdn.example/path",
      sourceImageUrl: "https://secret.example/raw-token",
      rawUrl: "https://secret.example/raw-token",
    });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));

    expect(payload).toMatchObject({
      imageUrl: "example.com/path",
      publicUrl: "cdn.example/path",
    });
    expect(payload).not.toHaveProperty("sourceImageUrl");
    expect(payload).not.toHaveProperty("rawUrl");
  });

  it("serializes only a safe error class and omits unsafe error details", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const privateContent =
      "raw-psid-123 arbitrary customer message without a known pattern";
    const error = Object.assign(new Error(privateContent), {
      code: `unsafe:${privateContent}`,
      cause: new Error(`private cause: ${privateContent}`),
    });

    safeLog("error_event", {
      level: "error",
      error,
    });

    const payload = JSON.parse(String(errorSpy.mock.calls[0]?.[0]));

    expect(payload.error).toEqual({ class: "Error" });
    expect(payload.error).not.toHaveProperty("message");
    expect(payload.error).not.toHaveProperty("stack");
    expect(payload.error).not.toHaveProperty("cause");
    expect(payload.error).not.toHaveProperty("code");
    expect(JSON.stringify(payload)).not.toContain(privateContent);
  });

  it("fingerprints caller-stringified errors without logging their content", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const privateContent =
      "provider rejected private customer prompt with raw-psid-123";

    safeLog("string_error_event", {
      level: "error",
      error: privateContent,
    });

    const payload = JSON.parse(String(errorSpy.mock.calls[0]?.[0]));
    expect(payload.error).toEqual({
      class: "RedactedError",
      fingerprint: createHash("sha256")
        .update(privateContent)
        .digest("hex")
        .slice(0, 12),
    });
    expect(JSON.stringify(payload)).not.toContain(privateContent);
    expect(JSON.stringify(payload)).not.toContain("raw-psid-123");
  });

  it("redacts Mollie keys, resource identifiers, and customer fields", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fakeMollieKey = ["test", "aaaaaaaaaaaa"].join("_");
    const mollieIds = [
      "tr_payment123",
      "cst_customer123",
      "mdt_mandate123",
      "sub_subscription123",
      "re_refund123",
      "chb_chargeback123",
      "stl_settlement123",
      "ord_order123",
    ];

    safeLog("billing_error", {
      level: "error",
      apiKey: fakeMollieKey,
      mollieCustomerId: "cst_customer123",
      paymentId: "tr_payment123",
      reason: `${fakeMollieKey} ${mollieIds.join(" ")} customer@example.com`,
      error: new Error(
        `${fakeMollieKey} ${mollieIds.join(" ")} customer@example.com`
      ),
    });

    const serialized = String(errorSpy.mock.calls[0]?.[0]);
    expect(serialized).not.toContain(fakeMollieKey);
    for (const mollieId of mollieIds) {
      expect(serialized).not.toContain(mollieId);
    }
    expect(serialized).not.toContain("customer@example.com");
    expect(JSON.parse(serialized).error).toEqual({ class: "Error" });
    expect(serialized).toContain("MOLLIE_KEY_REDACTED");
    expect(serialized).toContain("MOLLIE_ID_REDACTED");
    expect(serialized).toContain("EMAIL_REDACTED");
  });

  it("redacts nested users, circular arrays, and event overrides", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const circular: unknown[] = [];
    circular.push(circular);

    safeLog("trusted_event", {
      event: "untrusted_event",
      context: {
        user: "1234567890",
        items: circular,
      },
    });

    const payload = JSON.parse(String(logSpy.mock.calls[0]?.[0]));

    expect(payload).toMatchObject({
      event: "trusted_event",
      context: {
        user: logUser("1234567890"),
        items: ["[Circular]"],
      },
    });
  });
});
