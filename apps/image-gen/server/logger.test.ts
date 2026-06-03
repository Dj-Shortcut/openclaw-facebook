import { afterEach, describe, expect, it, vi } from "vitest";

import { safeLog } from "./_core/logger";

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
      user: "12345678",
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

  it("sanitizes sensitive content inside error messages", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    safeLog("error_event", {
      level: "error",
      error: new Error("failed for https://example.com/secret?token=abc"),
    });

    const payload = JSON.parse(String(errorSpy.mock.calls[0]?.[0]));

    expect(payload.error).toMatchObject({
      name: "Error",
      message: "failed for [URL_REDACTED]",
    });
    expect(JSON.stringify(payload)).not.toContain("abc");
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
        user: "12345678",
        items: ["[Circular]"],
      },
    });
  });
});
