import { describe, expect, it } from "vitest";
import {
  MESSENGER_OPENCLAW_ACTION_PREFIX,
  decodeOpenClawActionPayload,
  renderMessengerActionPayload,
  renderMessengerPresentationPayload,
} from "./presentation.js";

const conversationPresentation = {
  blocks: [
    { type: "text" as const, text: "Ik kan dit op twee manieren verder brengen." },
    {
      type: "buttons" as const,
      buttons: [
        { label: "Scope bepalen", value: "scope" },
        { label: "Regels maken", value: "rules" },
      ],
    },
  ],
};

describe("renderMessengerPresentationPayload", () => {
  it("turns useful conversational choices into Messenger quick replies", () => {
    const payload = renderMessengerPresentationPayload({
      payload: {},
      presentation: conversationPresentation,
    });

    expect(payload?.text).toBe("Ik kan dit op twee manieren verder brengen.");
    expect(payload?.channelData?.facebook?.quickReplies).toEqual([
      {
        content_type: "text",
        title: "Scope bepalen",
        payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}scope`,
      },
      {
        content_type: "text",
        title: "Regels maken",
        payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}rules`,
      },
    ]);
  });

  it("turns generic conversation actions into Messenger quick replies", () => {
    const payload = renderMessengerActionPayload({
      text: "Wat wil je doen?",
      actions: [
        { id: "Scope bepalen", label: "Scope bepalen" },
        { id: "Regels maken", label: "Regels maken" },
      ],
    });

    expect(payload?.channelData?.facebook?.quickReplies).toEqual([
      {
        content_type: "text",
        title: "Scope bepalen",
        payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}Scope bepalen`,
      },
      {
        content_type: "text",
        title: "Regels maken",
        payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}Regels maken`,
      },
    ]);
  });

  it("decodes OpenClaw action payloads back to user input text", () => {
    expect(decodeOpenClawActionPayload(`${MESSENGER_OPENCLAW_ACTION_PREFIX}Scope bepalen`)).toBe(
      "Scope bepalen",
    );
    expect(decodeOpenClawActionPayload("RETRY_STYLE_gold")).toBeNull();
  });

  it("does not render arbitrary single-pill UI", () => {
    const payload = renderMessengerPresentationPayload({
      payload: { text: "Ik licht het toe." },
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [{ label: "Meer", value: "more" }],
          },
        ],
      },
    });

    expect(payload).toBeNull();
  });

  it("filters URL and disabled actions before applying the minimum", () => {
    const payload = renderMessengerPresentationPayload({
      payload: { text: "Kies wat helpt." },
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Open docs", url: "https://example.test" },
              { label: "Uit", value: "disabled", disabled: true },
              { label: "Doorgaan", value: "continue" },
            ],
          },
        ],
      },
    });

    expect(payload).toBeNull();
  });

  it("requires conversational lead-in text before native pills", () => {
    const payload = renderMessengerPresentationPayload({
      payload: {},
      presentation: {
        blocks: [
          {
            type: "buttons",
            buttons: [
              { label: "Scope bepalen", value: "scope" },
              { label: "Regels maken", value: "rules" },
            ],
          },
        ],
      },
    });

    expect(payload).toBeNull();
  });

  it("does not silently truncate more than four focused pills", () => {
    const payload = renderMessengerPresentationPayload({
      payload: { text: "Kies een richting." },
      presentation: {
        blocks: [
          {
            type: "select",
            options: [
              { label: "Eerste", value: "one" },
              { label: "Tweede", value: "two" },
              { label: "Derde", value: "three" },
              { label: "Vierde", value: "four" },
              { label: "Vijfde", value: "five" },
            ],
          },
        ],
      },
    });

    expect(payload).toBeNull();
  });
});
