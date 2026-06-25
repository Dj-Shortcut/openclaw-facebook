import { describe, expect, it, beforeEach, afterEach } from "vitest";

import { extractWhatsAppEvents } from "./_core/inbound/whatsappInbound";

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
