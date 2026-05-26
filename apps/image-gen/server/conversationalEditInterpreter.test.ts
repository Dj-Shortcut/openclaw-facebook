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
            '{"shouldEdit":true,"style":"gold","promptHint":"make it darker with warm glow"}',
        }),
        { status: 200 }
      )
    );

    global.fetch = fetchMock;

    const result = await interpretConversationalEdit({
      text: "make it darker and more gold",
      lang: "en",
      lastStyle: "disco",
    });

    expect(result).toEqual({
      shouldEdit: true,
      style: "gold",
      promptHint: "make it darker with warm glow",
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
              text: '{"shouldEdit":true,"style":"cyberpunk","promptHint":"more neon rain"}',
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
      lastStyle: "disco",
    });

    expect(result).toEqual({
      shouldEdit: true,
      style: "cyberpunk",
      promptHint: "more neon rain",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("supports storybook anime style decisions and sends alias guidance to the model", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text:
            '{"shouldEdit":true,"style":"storybook-anime","promptHint":"add cozy magical forest details"}',
        }),
        { status: 200 }
      )
    );

    global.fetch = fetchMock;

    const result = await interpretConversationalEdit({
      text: "make it ghibli",
      lang: "en",
      lastStyle: "disco",
    });

    expect(result).toEqual({
      shouldEdit: true,
      style: "storybook-anime",
      promptHint: "add cozy magical forest details",
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      input: Array<{ role: string; content: string }>;
    };
    expect(body.input[0]?.content).toContain('"storybook-anime"');
    expect(body.input[0]?.content).toContain('Treat "ghibli"');
  });

  it("parses director mode decisions and sends director context to the model", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";

    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text:
            '{"shouldEdit":true,"style":null,"directorMode":"old_money","promptHint":"make it less fake and more quiet luxury"}',
        }),
        { status: 200 }
      )
    );

    global.fetch = fetchMock;

    const result = await interpretConversationalEdit({
      text: "make it less fake and more luxury",
      lang: "en",
      lastStyle: "cinematic",
      lastDirectorMode: "midnight_luxury",
    });

    expect(result).toEqual({
      shouldEdit: true,
      directorMode: "old_money",
      promptHint: "make it less fake and more quiet luxury",
    });

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body)) as {
      input: Array<{ role: string; content: string }>;
    };
    expect(body.input[0]?.content).toContain("last known director mode");
    expect(body.input[0]?.content).toContain("midnight_luxury");
    expect(body.input[0]?.content).toContain("old_money");
  });
});
