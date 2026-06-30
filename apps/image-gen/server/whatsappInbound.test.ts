import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

import {
  extractWhatsAppEvents,
  logWhatsAppWebhookPayload,
} from "./_core/inbound/whatsappInbound";

const TEST_PRIVACY_PEPPER = "ci-whatsapp-pepper";
const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

describe("whatsappInbound audio normalization", () => {
  beforeEach(() => {
    process.env.PRIVACY_PEPPER = TEST_PRIVACY_PEPPER;
  });

  afterEach(() => {
    if (originalPrivacyPepper === undefined) {
      delete process.env.PRIVACY_PEPPER;
    } else {
      process.env.PRIVACY_PEPPER = originalPrivacyPepper;
    }
  });

  it("normalizes audio type as audio", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "1111111111",
                    id: "wa-audio-1",
                    type: "audio",
                    audio: { id: "audio-id-1" },
                    timestamp: "1719300000",
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const events = extractWhatsAppEvents(payload);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      channel: "whatsapp",
      messageType: "audio",
      audioId: "audio-id-1",
      rawMessageType: "audio",
      messageId: "wa-audio-1",
      timestamp: 1719300000 * 1000,
    });
  });

  it("normalizes voice type as audio", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    from: "1111111111",
                    id: "wa-audio-2",
                    type: "voice",
                    voice: { id: "voice-id-1" },
                    timestamp: "1719300001",
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const events = extractWhatsAppEvents(payload);

    expect(events[0]?.messageType).toBe("audio");
    expect(events[0]?.audioId).toBe("voice-id-1");
    expect(events[0]?.rawMessageType).toBe("voice");
  });

  it("normalizes ptt type as audio", () => {
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
      value: {
        messages: [
          {
            from: "1111111111",
            id: "wa-audio-3",
            type: "ptt",
            ptt: { id: "ptt-id-1" },
            timestamp: "1719300002",
          },
        ],
      },
            },
          ],
        },
      ],
    };

    const events = extractWhatsAppEvents(payload);

    expect(events[0]?.messageType).toBe("audio");
    expect(events[0]?.audioId).toBe("ptt-id-1");
  });
});

describe("whatsappInbound status logging", () => {
  it("summarizes status webhooks without raw recipient or message identifiers", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const payload = {
      object: "whatsapp_business_account",
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [
                  {
                    id: "wamid.raw-message-id",
                    recipient_id: "32469792656",
                    status: "failed",
                    errors: [
                      {
                        code: 131026,
                        title: "Message undeliverable",
                      },
                    ],
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    try {
      logWhatsAppWebhookPayload(payload);
      const loggedText = logSpy.mock.calls
        .map(call => call.map(value => String(value)).join(" "))
        .join("\n");

      expect(loggedText).toContain("whatsapp_inbound_payload_summary");
      expect(loggedText).toContain('"statusCount":1');
      expect(loggedText).toContain('"failed":1');
      expect(loggedText).toContain('"code":131026');
      expect(loggedText).toContain("Message undeliverable");
      expect(loggedText).not.toContain("32469792656");
      expect(loggedText).not.toContain("wamid.raw-message-id");
    } finally {
      logSpy.mockRestore();
    }
  });
});
