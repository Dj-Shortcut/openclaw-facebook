import { afterEach, describe, expect, it, vi } from "vitest";

import { safeLog } from "./_core/logger";

describe("safeLog", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
});
