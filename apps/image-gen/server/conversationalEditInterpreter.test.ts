import { afterEach, describe, expect, it, vi } from "vitest";
import {
  interpretConversationalEdit,
  looksLikePossibleEditRequest,
} from "./_core/conversationalEditInterpreter";

describe("conversational edit interpreter", () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;
  const originalModel = process.env.OPENAI_EDIT_INTERPRETER_MODEL;

  afterEach(() => {
    global.fetch = originalFetch;

    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }

    if (originalModel === undefined) {
      delete process.env.OPENAI_EDIT_INTERPRETER_MODEL;
    } else {
      process.env.OPENAI_EDIT_INTERPRETER_MODEL = originalModel;
    }
  });

  it("detects likely edit requests before calling the model", () => {
    expect(looksLikePossibleEditRequest("make it darker")).toBe(true);
    expect(looksLikePossibleEditRequest("meer cinematic")).toBe(true);
    expect(looksLikePossibleEditRequest("make it norman blackwell")).toBe(true);
    expect(looksLikePossibleEditRequest("make it ghibli")).toBe(true);
    expect(looksLikePossibleEditRequest("make it whimsical")).toBe(true);
    expect(looksLikePossibleEditRequest("what can you do?")).toBe(false);
  });

  it("parses an edit decision from the responses api", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text:
            '{"shouldEdit":true,"promptHint":"make it darker with warm gold glow"}',
        }),
        { status: 200 }
      )
    );

    global.fetch = fetchMock;

    const result = await interpretConversationalEdit({
      text: "make it darker and more gold",
      lang: "en",
    });

    expect(result).toEqual({
      shouldEdit: true,
      promptHint: "make it darker with warm gold glow",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("accepts direct output[].text responses from the responses api", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output: [
            {
              text: '{"shouldEdit":true,"promptHint":"more cyberpunk neon rain"}',
            },
          ],
        }),
        { status: 200 }
      )
    );

    global.fetch = fetchMock;

    const result = await interpretConversationalEdit({
      text: "make it more cyberpunk",
      lang: "en",
    });

    expect(result).toEqual({
      shouldEdit: true,
      promptHint: "more cyberpunk neon rain",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps visual style words in the prompt instead of returning preset decisions", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text:
            '{"shouldEdit":true,"style":"storybook-anime","promptHint":"make it storybook anime with cozy magical forest details"}',
        }),
        { status: 200 }
      )
    );

    global.fetch = fetchMock;

    const result = await interpretConversationalEdit({
      text: "make it ghibli",
      lang: "en",
    });

    expect(result).toEqual({
      shouldEdit: true,
      promptHint: "make it storybook anime with cozy magical forest details",
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      input: Array<{ role: string; content: string }>;
    };
    expect(body.input[0]?.content).not.toContain('"storybook-anime"');
    expect(body.input[0]?.content).toContain("Never map user wording");
  });

  it("ignores director mode decisions and keeps them as prompt-first edits", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text:
            '{"shouldEdit":true,"style":null,"promptHint":"make it less fake and more quiet luxury"}',
        }),
        { status: 200 }
      )
    );

    global.fetch = fetchMock;

    const result = await interpretConversationalEdit({
      text: "make it less fake and more luxury",
      lang: "en",
    });

    expect(result).toEqual({
      shouldEdit: true,
      promptHint: "make it less fake and more quiet luxury",
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      input: Array<{ role: string; content: string }>;
    };
    expect(body.input[0]?.content).not.toContain("last known director mode");
    expect(body.input[0]?.content).not.toContain("midnight_luxury");
    expect(body.input[0]?.content).not.toContain("old_money");
    expect(body.input[0]?.content).toContain("promptHint");
  });
});
