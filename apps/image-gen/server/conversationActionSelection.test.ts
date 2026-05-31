import { describe, expect, it } from "vitest";
import { resolveConversationActionInput } from "./_core/conversationActionSelection";

const actions = [
  {
    id: "choice_1",
    label: "samurai-portret",
    inputText: "Maak me een samurai-portret",
  },
  {
    id: "choice_2",
    label: "tekstprompt",
    inputText: "Schrijf een tekstprompt",
  },
];

describe("conversation action selection", () => {
  it.each(["1", "nr 1", "Nr 1 go", "nummer 1", "optie 1", "keuze 1"])(
    "resolves natural numbered reply %s",
    text => {
      expect(resolveConversationActionInput(text, actions)).toBe(
        "Maak me een samurai-portret"
      );
    }
  );

  it("resolves exact action labels", () => {
    expect(resolveConversationActionInput("tekstprompt", actions)).toBe(
      "Schrijf een tekstprompt"
    );
  });

  it("ignores unknown choices", () => {
    expect(resolveConversationActionInput("nr 9", actions)).toBeUndefined();
    expect(resolveConversationActionInput("maak iets anders", actions)).toBeUndefined();
  });
});
