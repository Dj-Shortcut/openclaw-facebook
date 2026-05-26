import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatDirectorSocialCopy,
  generateDirectorSocialCopy,
} from "./_core/image-generation/director/directorSocialCopy";

describe("director social copy", () => {
  const originalFetch = global.fetch;
  const originalApiKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();

    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
  });

  it("skips generation without a director mode", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    const fetchMock = vi.fn<typeof fetch>();
    global.fetch = fetchMock;

    await expect(
      generateDirectorSocialCopy({ lang: "en", reqId: "req-1" })
    ).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("generates sanitized caption and hashtags for director output", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          output_text:
            '{"caption":"Main character energy after dark.","hashtags":["#Nightlife","club energy","AI","too-many!"]}',
        }),
        { status: 200 }
      )
    );
    global.fetch = fetchMock;

    const copy = await generateDirectorSocialCopy({
      lang: "en",
      directorMode: "midnight_luxury",
      promptHint: "more dramatic lighting",
      reqId: "req-2",
    });

    expect(copy).toEqual({
      caption: "Main character energy after dark.",
      hashtags: ["#Nightlife", "#clubenergy", "#AI", "#toomany"],
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      store: boolean;
      input: Array<{ content: string }>;
    };
    expect(body.store).toBe(false);
    expect(body.input[0]?.content).toContain("Return only JSON");
    expect(body.input[1]?.content).toContain("Midnight Luxury");
  });

  it("fails soft when the social copy request fails", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    global.fetch = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("error", { status: 500 })
    );

    await expect(
      generateDirectorSocialCopy({
        lang: "nl",
        directorMode: "berlin_underground",
        reqId: "req-3",
      })
    ).resolves.toBeUndefined();
  });

  it("formats copy for WhatsApp", () => {
    expect(
      formatDirectorSocialCopy({
        caption: "Klaar voor de nacht.",
        hashtags: ["#Nightlife", "#Diva"],
      })
    ).toBe("Klaar voor de nacht.\n#Nightlife #Diva");
  });
});
