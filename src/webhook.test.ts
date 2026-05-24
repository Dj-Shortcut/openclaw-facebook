import { describe, expect, it } from "vitest";
import {
  extractMessengerImageAttachmentUrls,
  extractMessengerInboundMessages,
  extractMessengerTextMessages,
} from "./webhook.js";

describe("extractMessengerTextMessages", () => {
  it("keeps text Page messages and skips echoes or unsupported events", () => {
    const messages = extractMessengerTextMessages({
      object: "page",
      entry: [
        {
          messaging: [
            {
              sender: { id: "psid-1" },
              recipient: { id: "page-1" },
              message: { mid: "m1", text: "hello" },
            },
            {
              sender: { id: "page-1" },
              recipient: { id: "psid-1" },
              message: { mid: "m2", text: "echo", is_echo: true },
            },
            {
              sender: { id: "psid-2" },
              recipient: { id: "page-1" },
              message: { mid: "m3" },
            },
          ],
        },
      ],
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]?.sender?.id).toBe("psid-1");
    expect(messages[0]?.message?.text).toBe("hello");
  });
});

describe("extractMessengerInboundMessages", () => {
  it("keeps image-only Page messages", () => {
    const messages = extractMessengerInboundMessages({
      object: "page",
      entry: [
        {
          messaging: [
            {
              sender: { id: "psid-1" },
              recipient: { id: "page-1" },
              message: {
                mid: "m1",
                attachments: [
                  {
                    type: "image",
                    payload: { url: "https://example.test/photo.jpg" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(messages).toHaveLength(1);
    expect(extractMessengerImageAttachmentUrls(messages[0]!)).toEqual([
      "https://example.test/photo.jpg",
    ]);
  });

  it("skips unsupported attachment-only messages", () => {
    const messages = extractMessengerInboundMessages({
      object: "page",
      entry: [
        {
          messaging: [
            {
              sender: { id: "psid-1" },
              recipient: { id: "page-1" },
              message: {
                mid: "m1",
                attachments: [
                  {
                    type: "file",
                    payload: { url: "https://example.test/file.pdf" },
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(messages).toHaveLength(0);
  });
});
