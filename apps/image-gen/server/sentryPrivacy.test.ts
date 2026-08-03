import { afterEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  debugEnabled: false,
  init: vi.fn(),
  setExtra: vi.fn(),
  withScope: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
  captureException: sentryMocks.captureException,
  init: sentryMocks.init,
  withScope: sentryMocks.withScope.mockImplementation(
    (callback: (scope: { setExtra: typeof sentryMocks.setExtra }) => void) =>
      callback({ setExtra: sentryMocks.setExtra })
  ),
}));

vi.mock("./_core/logLevel", () => ({
  isDebugLogEnabled: () => sentryMocks.debugEnabled,
}));

import { captureException, initSentry } from "./_core/observability/sentry";

describe("Sentry privacy boundary", () => {
  const originalDsn = process.env.SENTRY_DSN;
  const originalTracesSampleRate = process.env.SENTRY_TRACES_SAMPLE_RATE;

  afterEach(() => {
    sentryMocks.debugEnabled = false;
    vi.restoreAllMocks();
    vi.clearAllMocks();
    if (originalDsn === undefined) {
      delete process.env.SENTRY_DSN;
    } else {
      process.env.SENTRY_DSN = originalDsn;
    }
    if (originalTracesSampleRate === undefined) {
      delete process.env.SENTRY_TRACES_SAMPLE_RATE;
    } else {
      process.env.SENTRY_TRACES_SAMPLE_RATE = originalTracesSampleRate;
    }
  });

  it("preserves the original exception for beforeSend scrubbing", () => {
    process.env.SENTRY_DSN = "https://public@example.invalid/1";
    const privateContent =
      "raw-psid-123 private prompt +32470000000 https://private.example/image";
    const reqId = "3f8161cc-ec79-4c80-aa63-cad8d9c107ab";
    const original = new TypeError(privateContent);
    const originalStack = original.stack;
    initSentry();
    const options = sentryMocks.init.mock.calls[0]?.[0] as {
      beforeSend: (event: Record<string, any>) => Record<string, any>;
    };

    captureException(original, {
      reqId,
      area: "webhook",
      eventType: "message",
      hasImage: true,
      rawPayload: privateContent,
    });

    const captured = sentryMocks.captureException.mock.calls[0]?.[0] as Error;
    expect(captured).toBe(original);
    expect(captured.stack).toBe(originalStack);
    expect(sentryMocks.setExtra.mock.calls).toEqual(
      expect.arrayContaining([
        ["reqId", reqId],
        ["area", "webhook"],
        ["eventType", "message"],
        ["hasImage", true],
        ["errorClass", "TypeError"],
      ])
    );
    expect(JSON.stringify(sentryMocks.setExtra.mock.calls)).not.toContain(
      privateContent
    );
    expect(sentryMocks.setExtra).not.toHaveBeenCalledWith(
      "rawPayload",
      expect.anything()
    );

    const originalFrameLocation = captured.stack
      ?.split("\n")
      .slice(1)
      .map(line => line.trim())
      .find(Boolean);
    expect(originalFrameLocation).toEqual(
      expect.stringContaining("sentryPrivacy.test")
    );
    const capturedExtras = Object.fromEntries(
      sentryMocks.setExtra.mock.calls.map(([key, value]) => [
        String(key),
        value,
      ])
    );
    const sanitized = options.beforeSend({
      message: captured.message,
      contexts: { captured: { message: captured.message } },
      extra: capturedExtras,
      exception: {
        values: [
          {
            type: captured.name,
            value: captured.message,
            mechanism: { data: { message: captured.message } },
            stacktrace: {
              frames: [
                {
                  filename: originalFrameLocation,
                  context_line: captured.message,
                  vars: { message: captured.message },
                },
              ],
            },
          },
        ],
      },
    });

    expect(JSON.stringify(sanitized)).not.toContain(privateContent);
    expect(sanitized).not.toHaveProperty("message");
    expect(sanitized).not.toHaveProperty("contexts");
    expect(sanitized.extra).toEqual({
      reqId,
      area: "webhook",
      eventType: "message",
      hasImage: true,
      errorClass: "TypeError",
    });
    expect(sanitized.exception.values[0]).toMatchObject({
      type: "TypeError",
      value: "Application exception",
      stacktrace: {
        frames: [{ filename: originalFrameLocation }],
      },
    });
  });

  it("logs only validated dropped context keys when debug logging is enabled", () => {
    process.env.SENTRY_DSN = "https://public@example.invalid/1";
    sentryMocks.debugEnabled = true;
    const privateContent =
      "raw-psid-123 private prompt https://private.example/image";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    captureException(new Error(privateContent), {
      reqId: privateContent,
      rawPayload: privateContent,
      [privateContent]: true,
    });

    const logEntries = logSpy.mock.calls.map(([entry]) =>
      JSON.parse(String(entry))
    );
    expect(logSpy).toHaveBeenCalledTimes(3);
    expect(logEntries).toEqual([
      {
        level: "debug",
        event: "sentry_context_value_dropped",
        fieldKey: "reqId",
      },
      {
        level: "debug",
        event: "sentry_context_value_dropped",
        fieldKey: "rawPayload",
      },
      {
        level: "debug",
        event: "sentry_context_value_dropped",
        fieldKey: "invalid_context_key",
      },
    ]);
    expect(JSON.stringify(logEntries)).not.toContain(privateContent);
    expect(sentryMocks.setExtra).not.toHaveBeenCalledWith(privateContent, true);
  });

  it("does not log dropped context outside debug mode or accepted debug context", () => {
    process.env.SENTRY_DSN = "https://public@example.invalid/1";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    captureException(new Error("private"), { rawPayload: "private" });
    expect(logSpy).not.toHaveBeenCalled();

    sentryMocks.debugEnabled = true;
    captureException(new Error("private"), {
      area: "webhook",
      eventType: "message",
      hasImage: true,
      reqId: "3f8161cc-ec79-4c80-aa63-cad8d9c107ab",
    });
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("scrubs automatic Sentry events before they leave the process", () => {
    process.env.SENTRY_DSN = "https://public@example.invalid/1";
    const privateContent = "raw-psid private prompt +32470000000";
    initSentry();
    const options = sentryMocks.init.mock.calls[0]?.[0] as {
      beforeSend: (event: Record<string, any>) => Record<string, any>;
    };

    const sanitized = options.beforeSend({
      message: privateContent,
      request: { url: `https://example.invalid/?text=${privateContent}` },
      user: { id: "raw-user" },
      breadcrumbs: [{ message: privateContent }],
      tags: { sender: "raw-user" },
      extra: {
        rawPayload: privateContent,
        area: "webhook",
        hasText: true,
        [privateContent]: true,
      },
      exception: {
        values: [
          {
            type: "TypeError",
            value: privateContent,
            mechanism: { data: { raw: privateContent } },
            stacktrace: {
              frames: [
                {
                  filename: "webhookEventRouter.ts",
                  function: "originalFailureSite",
                  lineno: 321,
                  colno: 9,
                  vars: { prompt: privateContent },
                  context_line: privateContent,
                },
              ],
            },
          },
        ],
      },
    });

    expect(JSON.stringify(sanitized)).not.toContain(privateContent);
    expect(sanitized).not.toHaveProperty("request");
    expect(sanitized).not.toHaveProperty("user");
    expect(sanitized).not.toHaveProperty("breadcrumbs");
    expect(sanitized.extra).toEqual({ area: "webhook", hasText: true });
    expect(sanitized.exception.values[0]).toMatchObject({
      type: "TypeError",
      value: "Application exception",
      stacktrace: {
        frames: [
          {
            filename: "webhookEventRouter.ts",
            function: "originalFailureSite",
            lineno: 321,
            colno: 9,
          },
        ],
      },
    });
  });

  it("keeps performance trace export disabled despite runtime configuration and sampled parents", () => {
    process.env.SENTRY_DSN = "https://public@example.invalid/1";
    process.env.SENTRY_TRACES_SAMPLE_RATE = "1";

    initSentry();

    const options = sentryMocks.init.mock.calls[0]?.[0] as {
      beforeSendTransaction: (event: Record<string, unknown>) => null;
      tracesSampleRate: number;
      tracesSampler: (context: { parentSampled?: boolean }) => number;
    };
    expect(options).toHaveProperty("tracesSampleRate", 0);
    expect(options.tracesSampler({ parentSampled: true })).toBe(0);
    expect(
      options.beforeSendTransaction({ transaction: "private" })
    ).toBeNull();
  });
});
