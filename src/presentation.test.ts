import { describe, expect, it } from "vitest";
import {
  MESSENGER_OPENCLAW_ACTION_PREFIX,
} from "./messengerPresentationTypes.js";
import {
  decodeOpenClawActionPayload,
} from "./messengerQuickReplies.js";
import {
  renderMessengerActionPayload,
  renderMessengerInferredChoicePayload,
} from "./messengerActionPayloadRenderer.js";
import {
  renderMessengerPresentationPayload,
} from "./messengerPresentationRenderer.js";

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
        { id: "scope", label: "Scope bepalen", inputText: "Scope bepalen" },
        { id: "rules", label: "Regels maken", inputText: "Regels maken" },
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

  it("keeps inferred numbered choices visible next to explicit actions", () => {
    const payload = renderMessengerActionPayload({
      text:
        "Ja. Wil je dat ik een:\n\n" +
        "1. samurai-portret maak,\n" +
        "2. samurai-avatar/sticker maak,\n" +
        "3. samurai-illustratie voor een poster maak,",
      actions: [{ id: "privacy", label: "Privacy", inputText: "Privacy" }],
    });

    expect(payload?.text).toBe("Ja. Wil je dat ik een:");
    expect(payload?.channelData?.facebook?.quickReplies).toEqual([
      {
        content_type: "text",
        title: "samurai-portret",
        payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}Maak deze afbeelding: samurai-portret`,
      },
      {
        content_type: "text",
        title: "samurai-avatar/stick",
        payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}Maak deze afbeelding: samurai-avatar/sticker`,
      },
      {
        content_type: "text",
        title: "samurai-illustratie",
        payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}Maak deze afbeelding: samurai-illustratie voor een poster`,
      },
      {
        content_type: "text",
        title: "Privacy",
        payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}Privacy`,
      },
    ]);
  });

  it("strips Messenger-unfriendly markdown from inferred pills and delivery text", () => {
    const payload = renderMessengerActionPayload({
      text:
        "**Kies een richting:**\n\n" +
        "1. **samurai-portret** maak,\n" +
        "2. `samurai-avatar/sticker` maak,",
      actions: [{ id: "privacy", label: "**Privacy**", inputText: "Privacy" }],
    });

    expect(payload?.text).toBe("Kies een richting:");
    expect(payload?.channelData?.facebook?.quickReplies).toEqual([
      {
        content_type: "text",
        title: "samurai-portret",
        payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}Maak deze afbeelding: samurai-portret`,
      },
      {
        content_type: "text",
        title: "samurai-avatar/stick",
        payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}Maak deze afbeelding: samurai-avatar/sticker`,
      },
      {
        content_type: "text",
        title: "Privacy",
        payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}Privacy`,
      },
    ]);
  });

  it("uses action value when inputText is absent and id is technical", () => {
    const payload = renderMessengerActionPayload({
      text: "Kies een richting.",
      actions: [
        { id: "opt_1", label: "Avatar", value: "Maak een avatar" },
        { id: "opt_2", label: "Poster", value: "Maak een poster" },
      ],
    });

    expect(payload?.channelData?.facebook?.quickReplies).toEqual([
      {
        content_type: "text",
        title: "Avatar",
        payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}Maak een avatar`,
      },
      {
        content_type: "text",
        title: "Poster",
        payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}Maak een poster`,
      },
    ]);
  });

  it("falls back to the label for minimal on-the-fly actions", () => {
    const payload = renderMessengerActionPayload({
      text: "Wat wil je maken?",
      actions: [{ label: "Avatar" }, { label: "Poster" }],
    });

    expect(payload?.channelData?.facebook?.quickReplies).toEqual([
      {
        content_type: "text",
        title: "Avatar",
        payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}Avatar`,
      },
      {
        content_type: "text",
        title: "Poster",
        payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}Poster`,
      },
    ]);
  });

  it("decodes OpenClaw action payloads back to user input text", () => {
    expect(decodeOpenClawActionPayload(`${MESSENGER_OPENCLAW_ACTION_PREFIX}Scope bepalen`)).toBe(
      "Scope bepalen",
    );
    expect(decodeOpenClawActionPayload("RETRY_STYLE_gold")).toBeNull();
  });

  it("renders a single explicit action when the assistant only needs one next step", () => {
    const payload = renderMessengerActionPayload({
      text: "Wil je dat ik deze prompt omzet naar een afbeelding?",
      actions: [{ label: "Maak afbeelding" }],
    });

    expect(payload?.channelData?.facebook?.quickReplies).toEqual([
      {
        content_type: "text",
        title: "Maak afbeelding",
        payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}Maak afbeelding`,
      },
    ]);
  });

  it("renders an explicit single presentation button", () => {
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

    expect(payload?.channelData?.facebook?.quickReplies).toEqual([
      {
        content_type: "text",
        title: "Meer",
        payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}more`,
      },
    ]);
  });

  it("filters URL and disabled actions before rendering", () => {
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

    expect(payload?.channelData?.facebook?.quickReplies).toEqual([
      {
        content_type: "text",
        title: "Doorgaan",
        payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}continue`,
      },
    ]);
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

  it("renders more than four focused pills when Messenger can carry them", () => {
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

    expect(payload?.channelData?.facebook?.quickReplies).toHaveLength(5);
  });

  it("does not silently truncate beyond the Messenger quick reply limit", () => {
    const payload = renderMessengerPresentationPayload({
      payload: { text: "Kies een richting." },
      presentation: {
        blocks: [
          {
            type: "select",
            options: Array.from({ length: 14 }, (_, index) => ({
              label: `Optie ${index + 1}`,
              value: `option-${index + 1}`,
            })),
          },
        ],
      },
    });

    expect(payload).toBeNull();
  });

  it("infers Messenger pills from a clear numbered choice list", () => {
    const payload = renderMessengerInferredChoicePayload({
      text:
        "Ja. Wil je dat ik een:\n\n" +
        "1. samurai-portret maak,\n" +
        "2. samurai-avatar/sticker maak,\n" +
        "3. samurai-illustratie voor een\n" +
        "poster maak,\n" +
        "4. of een tekstprompt schrijf\n" +
        "waarmee je hem kunt genereren?\n\n" +
        "Als je wilt, kan ik meteen een stoere versie maken.",
    });

    expect(payload?.channelData?.facebook?.quickReplies).toEqual([
      {
        content_type: "text",
        title: "samurai-portret",
        payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}Maak deze afbeelding: samurai-portret`,
      },
      {
        content_type: "text",
        title: "samurai-avatar/stick",
        payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}Maak deze afbeelding: samurai-avatar/sticker`,
      },
      {
        content_type: "text",
        title: "samurai-illustratie",
        payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}Maak deze afbeelding: samurai-illustratie voor een poster`,
      },
      {
        content_type: "text",
        title: "tekstprompt",
        payload: `${MESSENGER_OPENCLAW_ACTION_PREFIX}Schrijf een tekstprompt`,
      },
    ]);
    expect(payload?.text).toBe(
      "Ja. Wil je dat ik een:\n\nAls je wilt, kan ik meteen een stoere versie maken.",
    );
  });

  it("does not infer choices from code blocks", () => {
    const payload = renderMessengerInferredChoicePayload({
      text: "```text\n1. keep this as text\n2. also text\n```",
    });

    expect(payload).toBeNull();
  });
});
