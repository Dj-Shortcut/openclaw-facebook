import { afterEach, describe, expect, it, vi } from "vitest";

describe("webhook handler context logging", () => {
  const originalLogLevel = process.env.LOG_LEVEL;
  const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

  afterEach(() => {
    if (originalLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLogLevel;
    }
    if (originalPrivacyPepper === undefined) {
      delete process.env.PRIVACY_PEPPER;
    } else {
      process.env.PRIVACY_PEPPER = originalPrivacyPepper;
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("logs incoming Messenger debug metadata without raw user content", async () => {
    process.env.LOG_LEVEL = "debug";
    process.env.PRIVACY_PEPPER = "handler-context-test-pepper";
    vi.resetModules();
    const { createHandlerContext } = await import("./_core/webhookHandlerContext");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const ctx = createHandlerContext({
      defaultLang: "en",
      runImageGeneration: vi.fn(async () => ({ sent: true })),
    });

    ctx.logIncomingMessage(
      "raw-psid-debug-log",
      "raw-user-id-debug-log",
      {
        sender: { id: "raw-psid-debug-log" },
        recipient: { id: "page-id" },
        timestamp: 1,
        message: {
          mid: "mid-sensitive",
          text: "make me a secret robot",
          quick_reply: { payload: "SECRET_QUICK_REPLY" },
          attachments: [
            {
              type: "image",
              payload: {
                url: "https://secret.example/image.jpg?token=abc",
              },
            },
          ],
        },
        referral: { ref: "SECRET_REFERRAL_VALUE" },
      },
      "req-debug-log"
    );

    expect(logSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(logSpy.mock.calls[0][0])) as {
      event: string;
      hasReferralRef: boolean;
      psidHash: string;
    };
    const serialized = JSON.stringify(payload);

    expect(payload.event).toBe("incoming_message");
    expect(payload.hasReferralRef).toBe(true);
    expect(payload.psidHash).toMatch(/^[a-f0-9]{12}$/);
    expect(serialized).not.toContain("raw-psid-debug-log");
    expect(serialized).not.toContain("raw-user-id-debug-log");
    expect(serialized).not.toContain("make me a secret robot");
    expect(serialized).not.toContain("SECRET_QUICK_REPLY");
    expect(serialized).not.toContain("SECRET_REFERRAL_VALUE");
    expect(serialized).not.toContain("secret.example");
    expect(serialized).not.toContain("token=abc");
  });
});
