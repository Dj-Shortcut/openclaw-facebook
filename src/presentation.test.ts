import { describe, expect, it } from "vitest";
import { renderMessengerPresentationPayload } from "./presentation.js";

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
      { content_type: "text", title: "Scope bepalen", payload: "scope" },
      { content_type: "text", title: "Regels maken", payload: "rules" },
    ]);
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

  it("keeps at most four focused pills", () => {
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

    expect(payload?.channelData?.facebook?.quickReplies).toHaveLength(4);
  });
});
