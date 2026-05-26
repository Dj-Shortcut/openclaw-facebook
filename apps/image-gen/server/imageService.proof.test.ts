import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OpenAiImageGenerator } from "./_core/imageService";
import { InvalidSourceImageUrlError } from "./_core/image-generation/sourceImageFetcher";
import { sha256 } from "./_core/imageProof";
import { setSourceImageDnsLookupForTests } from "./_core/image-generation/sourceImageFetcher";

const GENERATED_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=";
const STORED_SOURCE_IMAGE_URL =
  "https://leaderbot-fb-image-gen.fly.dev/generated/source.jpg";
const STORED_SOURCE_IMAGE_ALLOWED_HOSTS =
  "leaderbot-fb-image-gen.fly.dev,lookaside.fbsbx.com";

function toUrlString(url: string | URL): string {
  return typeof url === "string" ? url : url.toString();
}

function createStoredSourceImageInput(input: {
  userKey: string;
  reqId: string;
  promptHint?: string;
}) {
  return {
    ...input,
    sourceImageUrl: STORED_SOURCE_IMAGE_URL,
    trustedSourceImageUrl: true as const,
    sourceImageProvenance: "storeInbound" as const,
  };
}

function createOpenAiEditsFetchMock(options?: {
  sourceImageFixture?: Buffer;
  failuresBeforeSuccess?: number;
  payload?: { data: Array<{ b64_json: string }> };
  failureFactory?: (attempt: number) => Error;
}) {
  const sourceImageFixture = options?.sourceImageFixture ?? Buffer.alloc(7000, 9);
  const failuresBeforeSuccess = options?.failuresBeforeSuccess ?? 0;
  const payload = options?.payload ?? {
    data: [{ b64_json: GENERATED_IMAGE_BASE64 }],
  };
  let openAiCallCount = 0;

  const fetchMock = vi.fn(async (url: string | URL) => {
    if (toUrlString(url) === STORED_SOURCE_IMAGE_URL) {
      return {
        ok: true,
        headers: new Headers({ "content-type": "image/jpeg" }),
        arrayBuffer: async () => sourceImageFixture,
      } as Response;
    }

    expect(toUrlString(url)).toBe("https://api.openai.com/v1/images/edits");
    openAiCallCount += 1;
    if (openAiCallCount <= failuresBeforeSuccess) {
      const failure =
        options?.failureFactory?.(openAiCallCount) ??
        Object.assign(new Error("request failed"), { name: "AbortError" });
      throw failure;
    }

    return {
      ok: true,
      json: async () => payload,
    } as Response;
  });

  return { fetchMock, getOpenAiCallCount: () => openAiCallCount };
}

type StylePromptCase = {
  style:
    | "caricature"
    | "storybook-anime"
    | "afroman-americana"
    | "petals"
    | "gold"
    | "cinematic"
    | "disco"
    | "clouds";
  baseLead: string;
  features: string[];
  minFeatureMatches: number;
};

const STYLE_PROMPT_CASES = [
  {
    style: "caricature",
    baseLead: "Transform this photo into a high-end caricature portrait",
    features: [
      "playfully exaggerated facial proportions",
      "crisp inked contours",
      "dimensional cel-shaded rendering",
    ],
    minFeatureMatches: 3,
  },
  {
    style: "storybook-anime",
    baseLead:
      "Transform this photo into a whimsical hand-drawn fantasy illustration with a warm storybook atmosphere.",
    features: [
      "soft, painterly animated scene",
      "hand-painted background sensibility",
      "soft daylight or golden-hour lighting",
      "nostalgic magical mood",
    ],
    minFeatureMatches: 3,
  },
  {
    style: "afroman-americana",
    baseLead:
      "Transform this photo into a premium stylized portrait in an Afroman-inspired Americana look.",
    features: [
      "Preserve the subject identity and facial features",
      "tailored American flag suit",
      "bold retro Americana energy",
      "rich red white and blue color balance",
    ],
    minFeatureMatches: 3,
  },
  {
    style: "petals",
    baseLead: "Turn this image into a romantic floral fantasy portrait",
    features: [
      "drifting blossom petals",
      "luminous backlighting",
      "soft pastel palette of rose, blush, ivory, and fresh green",
    ],
    minFeatureMatches: 3,
  },
  {
    style: "gold",
    baseLead: "Reimagine this portrait as a luxe gilded editorial artwork",
    features: [
      "molten gold highlights",
      "champagne and amber color grading",
      "sculpted rim lighting",
    ],
    minFeatureMatches: 3,
  },
  {
    style: "cinematic",
    baseLead: "Reframe this photo as a prestige-film still",
    features: [
      "dramatic directional lighting",
      "deep shadows",
      "refined teal-and-amber palette",
    ],
    minFeatureMatches: 3,
  },
  {
    style: "disco",
    baseLead: "Convert this portrait into a glamorous disco-era hero shot",
    features: [
      "mirror-ball reflections",
      "magenta and electric blue spotlights",
      "glittering highlights",
    ],
    minFeatureMatches: 3,
  },
  {
    style: "clouds",
    baseLead: "Render this portrait as an ethereal skyborne scene",
    features: [
      "layered clouds",
      "diffused sunrise lighting",
      "airy gradients of pearl white, pale blue, silver, and warm peach",
    ],
    minFeatureMatches: 3,
  },
] satisfies StylePromptCase[];

const GENERIC_FALLBACK_PATTERNS = [
  "Apply disco style to this photo",
  /Apply .* style to this photo/i,
] as const;

function expectDistinctivePrompt(
  prompt: string,
  styleCase: StylePromptCase,
  promptHint: string
): void {
  for (const pattern of GENERIC_FALLBACK_PATTERNS) {
    if (typeof pattern === "string") {
      expect(prompt).not.toContain(pattern);
      continue;
    }

    expect(prompt).not.toMatch(pattern);
  }

  expect(prompt).toContain(styleCase.baseLead);

  const matchedFeatures = styleCase.features.filter(feature =>
    prompt.includes(feature)
  );
  expect(matchedFeatures.length).toBeGreaterThanOrEqual(
    styleCase.minFeatureMatches
  );

  const additionalDirection = `Additional direction: ${promptHint}.`;
  expect(prompt).toContain(additionalDirection);
  expect(prompt.indexOf(styleCase.baseLead)).toBeLessThan(
    prompt.indexOf(additionalDirection)
  );
}

function installStoredSourcePromptFetchMock(
  assertPrompt: (prompt: string) => void
) {
  process.env.OPENAI_API_KEY = "dummy-key";
  process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
  process.env.SOURCE_IMAGE_ALLOWED_HOSTS = STORED_SOURCE_IMAGE_ALLOWED_HOSTS;

  const fixture = Buffer.alloc(7000, 9);
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    if (toUrlString(url) === STORED_SOURCE_IMAGE_URL) {
      return {
        ok: true,
        headers: new Headers({ "content-type": "image/jpeg" }),
        arrayBuffer: async () => fixture,
      } as Response;
    }

    const formData = init?.body as FormData;
    assertPrompt(String(formData.get("prompt")));

    return {
      ok: true,
      json: async () => ({ data: [{ b64_json: GENERATED_IMAGE_BASE64 }] }),
    } as Response;
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("OpenAi image-to-image proof", () => {
  beforeEach(() => {
    setSourceImageDnsLookupForTests(async () => [
      { address: "93.184.216.34", family: 4 },
    ]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setSourceImageDnsLookupForTests(null);
    delete process.env.NODE_ENV;
    delete process.env.OPENAI_API_KEY;
    delete process.env.APP_BASE_URL;
    delete process.env.OPENAI_IMAGE_MAX_RETRIES;
    delete process.env.OPENAI_IMAGE_RETRY_BASE_MS;
    delete process.env.OPENAI_IMAGE_TIMEOUT_MS;
    delete process.env.SOURCE_IMAGE_ALLOWED_HOSTS;
    delete process.env.BUILT_IN_FORGE_API_URL;
    delete process.env.BUILT_IN_FORGE_API_KEY;
  });

  it.each(STYLE_PROMPT_CASES)(
    "$style builds a distinctive OpenAI edits prompt and preserves prompt hints",
    async styleCase => {
      process.env.OPENAI_API_KEY = "dummy-key";
      process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
      process.env.SOURCE_IMAGE_ALLOWED_HOSTS = STORED_SOURCE_IMAGE_ALLOWED_HOSTS;

      const fixture = Buffer.alloc(7000, 9);
      const fixtureHash = sha256(fixture);
      const promptHint = "neon rain";

      const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (toUrlString(url) === STORED_SOURCE_IMAGE_URL) {
          expect(init?.redirect).toBe("manual");
          return {
            ok: true,
            headers: new Headers({ "content-type": "image/jpeg" }),
            arrayBuffer: async () => fixture,
          } as Response;
        }

        expect(toUrlString(url)).toBe("https://api.openai.com/v1/images/edits");
        const formData = init?.body as FormData;
        expect(formData).toBeInstanceOf(FormData);
        const imageBlob = formData.get("image");
        expect(imageBlob).toBeInstanceOf(Blob);
        const imageBuffer = Buffer.from(await (imageBlob as Blob).arrayBuffer());
        expect(sha256(imageBuffer)).toBe(fixtureHash);
        expect(formData.get("output_format")).toBe("jpeg");

        const prompt = String(formData.get("prompt"));
        expectDistinctivePrompt(prompt, styleCase, promptHint);

        return {
          ok: true,
          json: async () => ({ data: [{ b64_json: GENERATED_IMAGE_BASE64 }] }),
        } as Response;
      });

      vi.stubGlobal("fetch", fetchMock);

      const generator = new OpenAiImageGenerator();
      const result = await generator.generate({
        style: styleCase.style,
        ...createStoredSourceImageInput({
          promptHint,
          userKey: "user-1",
          reqId: `req-${styleCase.style}-prompt`,
        }),
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.imageUrl).toMatch(
        /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.jpg$/
      );
      expect(result.metrics.totalMs).toBeGreaterThanOrEqual(0);
      expect(result.metrics.fbImageFetchMs).toBeGreaterThanOrEqual(0);
      expect(result.metrics.openAiMs).toBeGreaterThanOrEqual(0);
    }
  );

  it("uses the cyberpunk preset prompt for OpenAI edits", async () => {
    const fetchMock = installStoredSourcePromptFetchMock(prompt => {
      expect(prompt).toContain(
        "Transform this photo into a cyberpunk portrait"
      );
      expect(prompt).toContain("neon signage glow");
      expect(prompt).toContain("rain-slick reflections");
      expect(prompt).toContain(
        "vivid palette of electric pink, cyan, ultraviolet, and toxic blue"
      );
    });

    const generator = new OpenAiImageGenerator();
    await generator.generate({
      style: "cyberpunk",
      ...createStoredSourceImageInput({
        userKey: "user-1",
        reqId: "req-cyberpunk-prompt",
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the Norman Blackwell preset prompt for OpenAI edits", async () => {
    const fetchMock = installStoredSourcePromptFetchMock(prompt => {
      expect(prompt).toContain(
        "Reimagine this photo as a nostalgic mid-century American editorial illustration"
      );
      expect(prompt).toContain("warm storybook lighting");
      expect(prompt).toContain(
        "all-American palette of cream, brick red, muted teal, and honey gold"
      );
      expect(prompt).toContain(
        "polished finish of a vintage family magazine cover from the 1940s or 1950s"
      );
    });

    const generator = new OpenAiImageGenerator();
    await generator.generate({
      style: "norman-blackwell",
      ...createStoredSourceImageInput({
        userKey: "user-1",
        reqId: "req-norman-blackwell-prompt",
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the oil-paint preset prompt for OpenAI edits", async () => {
    const fetchMock = installStoredSourcePromptFetchMock(prompt => {
      expect(prompt).toContain(
        "Render this portrait as a classical oil painting"
      );
      expect(prompt).toContain("visible brush strokes");
      expect(prompt).toContain("textured canvas grain");
      expect(prompt).toContain("sculpted painterly lighting");
      expect(prompt).toContain(
        "rich museum-grade palette of umber, ochre, crimson, and deep blue"
      );
    });

    const generator = new OpenAiImageGenerator();
    await generator.generate({
      style: "oil-paint",
      ...createStoredSourceImageInput({
        userKey: "user-1",
        reqId: "req-oil-paint-prompt",
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("hard-fails before OpenAI call when input image is too small", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = STORED_SOURCE_IMAGE_ALLOWED_HOSTS;

    const tinyFixture = Buffer.alloc(1024, 1);
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (toUrlString(url) === STORED_SOURCE_IMAGE_URL) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "image/jpeg" }),
          arrayBuffer: async () => tinyFixture,
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({ data: [{ b64_json: GENERATED_IMAGE_BASE64 }] }),
      } as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await expect(
      generator.generate({
        style: "disco",
        ...createStoredSourceImageInput({
          userKey: "user-1",
          reqId: "req-2",
        }),
      })
    ).rejects.toThrow("Source image too small");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hard-fails before OpenAI call when content-length exceeds the inbound size cap", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = STORED_SOURCE_IMAGE_ALLOWED_HOSTS;

    const fetchMock = vi.fn(async (url: string | URL) => {
      if (toUrlString(url) === STORED_SOURCE_IMAGE_URL) {
        return {
          ok: true,
          headers: new Headers({
            "content-type": "image/jpeg",
            "content-length": String(21 * 1024 * 1024),
          }),
          arrayBuffer: async () => Buffer.alloc(1024, 1),
          body: null,
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({ data: [{ b64_json: GENERATED_IMAGE_BASE64 }] }),
      } as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await expect(
      generator.generate({
        style: "disco",
        ...createStoredSourceImageInput({
          userKey: "user-1",
          reqId: "req-too-large-header",
        }),
      })
    ).rejects.toThrow("Source image too large");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries the source image download once on transient network errors", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = STORED_SOURCE_IMAGE_ALLOWED_HOSTS;

    const fixture = Buffer.alloc(7000, 9);
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (
        toUrlString(url) === STORED_SOURCE_IMAGE_URL &&
        fetchMock.mock.calls.length === 1
      ) {
        throw new TypeError("temporary network failure");
      }

      if (toUrlString(url) === STORED_SOURCE_IMAGE_URL) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "image/jpeg" }),
          arrayBuffer: async () => fixture,
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({ data: [{ b64_json: GENERATED_IMAGE_BASE64 }] }),
      } as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    const result = await generator.generate({
      style: "disco",
      ...createStoredSourceImageInput({
        userKey: "user-1",
        reqId: "req-3",
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.imageUrl).toMatch(
      /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.jpg$/
    );
    expect(result.metrics.fbImageFetchMs).toBeGreaterThanOrEqual(0);
  });

  it("rejects localhost and private IP source image URLs before fetch", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = "img.example,lookaside.fbsbx.com";

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await expect(
      generator.generate({
        style: "disco",
        sourceImageUrl: "https://127.0.0.1/source.jpg",
        userKey: "user-1",
        reqId: "req-private-ip",
      })
    ).rejects.toBeInstanceOf(InvalidSourceImageUrlError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("enforces SOURCE_IMAGE_ALLOWED_HOSTS when configured", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = "leaderbot-fb-image-gen.fly.dev";

    const fixture = Buffer.alloc(7000, 9);
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (toUrlString(url) === STORED_SOURCE_IMAGE_URL) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "image/jpeg" }),
          arrayBuffer: async () => fixture,
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({ data: [{ b64_json: GENERATED_IMAGE_BASE64 }] }),
      } as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    const result = await generator.generate({
      style: "disco",
      ...createStoredSourceImageInput({
        userKey: "user-1",
        reqId: "req-allowlist",
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.imageUrl).toMatch(
      /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.jpg$/
    );
  });

  it("blocks hosts outside SOURCE_IMAGE_ALLOWED_HOSTS before fetch", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = "img.example";

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await expect(
      generator.generate({
        style: "disco",
        sourceImageUrl: "https://other.example/source.jpg",
        userKey: "user-1",
        reqId: "req-deny-allowlist",
      })
    ).rejects.toBeInstanceOf(InvalidSourceImageUrlError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects allowlisted hosts that resolve to private IPs before fetch", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = "img.example";

    setSourceImageDnsLookupForTests(async () => [
      { address: "127.0.0.1", family: 4 },
    ]);

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await expect(
      generator.generate({
        style: "disco",
        sourceImageUrl: "https://img.example/source.jpg",
        userKey: "user-1",
        reqId: "req-private-dns-resolution",
      })
    ).rejects.toBeInstanceOf(InvalidSourceImageUrlError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires allowlisted hosts even for trusted internally stored source image URLs", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = "img.example";

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await expect(
      generator.generate({
        style: "disco",
        sourceImageUrl: "https://pub-storage.example/inbound-source/test.jpg",
        trustedSourceImageUrl: true,
        sourceImageProvenance: "storeInbound",
        userKey: "user-1",
        reqId: "req-trusted-stored-source",
      })
    ).rejects.toBeInstanceOf(InvalidSourceImageUrlError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not bypass SOURCE_IMAGE_ALLOWED_HOSTS without stored-source provenance", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = "img.example";

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await expect(
      generator.generate({
        style: "disco",
        sourceImageUrl: "https://pub-storage.example/inbound-source/test.jpg",
        trustedSourceImageUrl: true,
        userKey: "user-1",
        reqId: "req-missing-provenance",
      })
    ).rejects.toBeInstanceOf(InvalidSourceImageUrlError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects source image URLs with embedded credentials before fetch", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = "img.example";

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await expect(
      generator.generate({
        style: "disco",
        sourceImageUrl: "https://user:pass@img.example/source.jpg",
        userKey: "user-1",
        reqId: "req-embedded-credentials",
      })
    ).rejects.toBeInstanceOf(InvalidSourceImageUrlError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects source image URLs on non-443 ports before fetch", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = "img.example";

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await expect(
      generator.generate({
        style: "disco",
        sourceImageUrl: "https://img.example:8443/source.jpg",
        userKey: "user-1",
        reqId: "req-non-standard-port",
      })
    ).rejects.toBeInstanceOf(InvalidSourceImageUrlError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects source image URLs with path traversal segments before fetch", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = "img.example";

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await expect(
      generator.generate({
        style: "disco",
        sourceImageUrl: "https://img.example/inbound/../source.jpg",
        userKey: "user-1",
        reqId: "req-path-traversal",
      })
    ).rejects.toBeInstanceOf(InvalidSourceImageUrlError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects encoded path traversal segments before fetch", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = "img.example";

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await expect(
      generator.generate({
        style: "disco",
        sourceImageUrl: "https://img.example/inbound/%2e%2e/source.jpg",
        userKey: "user-1",
        reqId: "req-encoded-path-traversal",
      })
    ).rejects.toBeInstanceOf(InvalidSourceImageUrlError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not require APP_BASE_URL when production uses durable object storage", async () => {
    process.env.NODE_ENV = "production";
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "http://leaderbot.example";
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = "leaderbot-fb-image-gen.fly.dev";
    process.env.BUILT_IN_FORGE_API_URL = "https://forge.example";
    process.env.BUILT_IN_FORGE_API_KEY = "forge-secret";

    const fixture = Buffer.alloc(7000, 9);
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (toUrlString(url) === STORED_SOURCE_IMAGE_URL) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "image/jpeg" }),
          arrayBuffer: async () => fixture,
        } as Response;
      }

      if (
        toUrlString(url).startsWith(
          "https://forge.example/v1/storage/upload?path=generated%2Fdisco%2F"
        )
      ) {
        return {
          ok: true,
          json: async () => ({
            url: "https://cdn.example/generated/disco.jpg?signature=prod",
          }),
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({ data: [{ b64_json: GENERATED_IMAGE_BASE64 }] }),
      } as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    const result = await generator.generate({
      style: "disco",
      ...createStoredSourceImageInput({
        userKey: "user-1",
        reqId: "req-insecure-app-base-url",
      }),
    });

    expect(result.imageUrl).toBe(
      "https://cdn.example/generated/disco.jpg?signature=prod"
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("retries OpenAI edits request on retryable status codes", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    process.env.OPENAI_IMAGE_MAX_RETRIES = "1";
    process.env.OPENAI_IMAGE_RETRY_BASE_MS = "1";
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = STORED_SOURCE_IMAGE_ALLOWED_HOSTS;

    const fixture = Buffer.alloc(7000, 9);
    let openAiCallCount = 0;
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (toUrlString(url) === STORED_SOURCE_IMAGE_URL) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "image/jpeg" }),
          arrayBuffer: async () => fixture,
        } as Response;
      }

      openAiCallCount += 1;
      if (openAiCallCount === 1) {
        return {
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({ data: [{ b64_json: GENERATED_IMAGE_BASE64 }] }),
      } as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    const result = await generator.generate({
      style: "disco",
      ...createStoredSourceImageInput({
        userKey: "user-1",
        reqId: "req-openai-retry",
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.imageUrl).toMatch(
      /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.jpg$/
    );
    expect(result.metrics.openAiMs).toBeGreaterThanOrEqual(0);
  });

  it("does not retry when OpenAI reports insufficient quota", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    process.env.OPENAI_IMAGE_MAX_RETRIES = "2";
    process.env.OPENAI_IMAGE_RETRY_BASE_MS = "1";
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = STORED_SOURCE_IMAGE_ALLOWED_HOSTS;

    const fixture = Buffer.alloc(7000, 9);
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (toUrlString(url) === STORED_SOURCE_IMAGE_URL) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "image/jpeg" }),
          arrayBuffer: async () => fixture,
        } as Response;
      }

      return new Response(
        JSON.stringify({
          error: {
            code: "insufficient_quota",
            message: "Budget reached for this month",
          },
        }),
        {
          status: 429,
          statusText: "Too Many Requests",
          headers: new Headers({ "content-type": "application/json" }),
        }
      );
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await expect(
      generator.generate({
        style: "disco",
        ...createStoredSourceImageInput({
          userKey: "user-1",
          reqId: "req-openai-budget-exceeded",
        }),
      })
    ).rejects.toThrow("OpenAI budget exceeded");

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails closed when SOURCE_IMAGE_ALLOWED_HOSTS is not set", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await expect(
      generator.generate({
        style: "disco",
        sourceImageUrl: "https://img.example/source.jpg",
        userKey: "user-1",
        reqId: "req-no-allowlist",
      })
    ).rejects.toBeInstanceOf(InvalidSourceImageUrlError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks redirects for source image fetches", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = STORED_SOURCE_IMAGE_ALLOWED_HOSTS;

    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (toUrlString(url) === STORED_SOURCE_IMAGE_URL) {
        expect(init?.redirect).toBe("manual");
        return {
          ok: false,
          status: 302,
          headers: new Headers({ "content-type": "image/jpeg" }),
          arrayBuffer: async () => Buffer.alloc(7000, 9),
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({ data: [{ b64_json: GENERATED_IMAGE_BASE64 }] }),
      } as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await expect(
      generator.generate({
        style: "disco",
        ...createStoredSourceImageInput({
          userKey: "user-1",
          reqId: "req-redirect-error",
        }),
      })
    ).rejects.toBeInstanceOf(InvalidSourceImageUrlError);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      new URL(STORED_SOURCE_IMAGE_URL),
      expect.objectContaining({ redirect: "manual" })
    );
  });

  it("retries OpenAI edits request after timeout aborts", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    process.env.OPENAI_IMAGE_MAX_RETRIES = "1";
    process.env.OPENAI_IMAGE_RETRY_BASE_MS = "1";
    process.env.OPENAI_IMAGE_TIMEOUT_MS = "5";
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = STORED_SOURCE_IMAGE_ALLOWED_HOSTS;

    const { fetchMock } = createOpenAiEditsFetchMock({
      failuresBeforeSuccess: 1,
      failureFactory: () => {
        const abortError = new Error("request aborted");
        abortError.name = "AbortError";
        return abortError;
      },
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    const result = await generator.generate({
      style: "disco",
      ...createStoredSourceImageInput({
        userKey: "user-1",
        reqId: "req-openai-timeout-retry",
      }),
    });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(result.imageUrl).toMatch(
      /^https:\/\/leaderbot-fb-image-gen\.fly\.dev\/generated\/[0-9a-f-]+\.jpg$/
    );
    expect(result.metrics.openAiMs).toBeGreaterThanOrEqual(0);
  });

  it("fails when OpenAI base64 payload decodes to an empty image buffer", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = STORED_SOURCE_IMAGE_ALLOWED_HOSTS;

    const fixture = Buffer.alloc(7000, 9);
    const fetchMock = vi.fn(async (url: string | URL) => {
      if (toUrlString(url) === STORED_SOURCE_IMAGE_URL) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "image/jpeg" }),
          arrayBuffer: async () => fixture,
        } as Response;
      }

      return {
        ok: true,
        json: async () => ({ data: [{ b64_json: "!!!" }] }),
      } as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    await expect(
      generator.generate({
        style: "disco",
        ...createStoredSourceImageInput({
          userKey: "user-1",
          reqId: "req-empty-output-buffer",
        }),
      })
    ).rejects.toThrow(
      "OpenAI response image data was empty after base64 decode"
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
