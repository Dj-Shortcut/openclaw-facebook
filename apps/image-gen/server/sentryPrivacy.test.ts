import { afterEach, describe, expect, it, vi } from "vitest";

const sentryMocks = vi.hoisted(() => ({
  captureException: vi.fn(),
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

import { captureException, initSentry } from "./_core/observability/sentry";

describe("Sentry privacy boundary", () => {
  const originalDsn = process.env.SENTRY_DSN;
  const originalTracesSampleRate = process.env.SENTRY_TRACES_SAMPLE_RATE;

  afterEach(() => {
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

  it("never forwards raw exception content or unapproved context", () => {
    process.env.SENTRY_DSN = "https://public@example.invalid/1";
    const privateContent =
      "raw-psid-123 private prompt +32470000000 https://private.example/image";
    const reqId = "3f8161cc-ec79-4c80-aa63-cad8d9c107ab";

    captureException(new TypeError(privateContent), {
      reqId,
      area: "webhook",
      eventType: "message",
      hasImage: true,
      rawPayload: privateContent,
    });

    const captured = sentryMocks.captureException.mock.calls[0]?.[0];
    expect(captured).toBeInstanceOf(Error);
    expect(captured).toMatchObject({
      name: "TypeError",
      message: "Application exception",
    });
    expect(sentryMocks.setExtra.mock.calls).toEqual(
      expect.arrayContaining([
        ["reqId", reqId],
        ["area", "webhook"],
        ["eventType", "message"],
        ["hasImage", true],
        ["errorClass", "TypeError"],
      ])
    );
    expect(
      JSON.stringify(sentryMocks.captureException.mock.calls)
    ).not.toContain(privateContent);
    expect(JSON.stringify(sentryMocks.setExtra.mock.calls)).not.toContain(
      privateContent
    );
    expect(sentryMocks.setExtra).not.toHaveBeenCalledWith(
      "rawPayload",
      expect.anything()
    );
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
        frames: [{ filename: "webhookEventRouter.ts" }],
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
