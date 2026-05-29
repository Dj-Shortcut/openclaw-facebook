import http from "node:http";
import express from "express";
import { describe, expect, it } from "vitest";
import {
  assertIdentityGameVariantCatalog,
  GAME_VARIANTS,
  registerIdentityGameShareRoutes,
  type GameVariantDefinition,
} from "./_core/identityGameVariants";
import { bindTestHttpServer } from "./testHttpServer";

function createVariant(overrides: Partial<GameVariantDefinition> = {}): GameVariantDefinition {
  const base: GameVariantDefinition = {
    variantId: "identity-test-v1",
    status: "qa",
    version: "v1",
    entryRefs: ["identity-test-v1", "game:identity-test-v1"],
    questions: [
      {
        id: "q1",
        prompt: "Q1",
        options: [
          { id: "q1_builder", title: "A", archetypeId: "builder" },
          { id: "q1_visionary", title: "B", archetypeId: "visionary" },
          { id: "q1_analyst", title: "C", archetypeId: "analyst" },
          { id: "q1_operator", title: "D", archetypeId: "operator" },
        ],
      },
      {
        id: "q2",
        prompt: "Q2",
        options: [
          { id: "q2_builder", title: "A", archetypeId: "builder" },
          { id: "q2_visionary", title: "B", archetypeId: "visionary" },
          { id: "q2_analyst", title: "C", archetypeId: "analyst" },
          { id: "q2_operator", title: "D", archetypeId: "operator" },
        ],
      },
      {
        id: "q3",
        prompt: "Q3",
        options: [
          { id: "q3_builder", title: "A", archetypeId: "builder" },
          { id: "q3_visionary", title: "B", archetypeId: "visionary" },
          { id: "q3_analyst", title: "C", archetypeId: "analyst" },
          { id: "q3_operator", title: "D", archetypeId: "operator" },
        ],
      },
    ],
    archetypes: [
      {
        id: "builder",
        title: "Builder",
        identityLine: "Builder identity",
        explanationLine: "Builder explanation",
      },
      {
        id: "visionary",
        title: "Visionary",
        identityLine: "Visionary identity",
        explanationLine: "Visionary explanation",
      },
      {
        id: "analyst",
        title: "Analyst",
        identityLine: "Analyst identity",
        explanationLine: "Analyst explanation",
      },
      {
        id: "operator",
        title: "Operator",
        identityLine: "Operator identity",
        explanationLine: "Operator explanation",
      },
    ],
    resolutionMap: {},
    copy: {
      intro: "intro",
      invalid: "invalid",
      replay: "replay",
    },
    imagePrompt: {
      styleKey: "style",
      variantDescriptor: "descriptor",
    },
  };

  const withMap: GameVariantDefinition = {
    ...base,
    resolutionMap: {
      ...base.resolutionMap,
      ...Object.fromEntries(
        base.questions[0].options.flatMap(option1 =>
          base.questions[1].options.flatMap(option2 =>
            base.questions[2].options.map(option3 => [
              `${option1.id}|${option2.id}|${option3.id}`,
              option1.archetypeId,
            ])
          )
        )
      ),
    },
  };

  return {
    ...withMap,
    ...overrides,
  };
}

async function listen(app: express.Express) {
  const server = http.createServer(app);
  const boundServer = await bindTestHttpServer(server);

  return {
    baseUrl: boundServer.baseUrl,
    close: boundServer.close,
    requestWithHost: (path: string, host: string) =>
      new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
        (resolve, reject) => {
          const request = http.request(
            {
              hostname: "127.0.0.1",
              port: boundServer.port,
              path,
              method: "GET",
              headers: { host },
            },
            response => {
              let body = "";
              response.setEncoding("utf8");
              response.on("data", chunk => {
                body += chunk;
              });
              response.on("end", () => {
                resolve({
                  status: response.statusCode ?? 0,
                  headers: response.headers,
                  body,
                });
              });
            }
          );
          request.on("error", reject);
          request.end();
        }
      ),
  };
}

describe("identity game variants catalog and share routes", () => {
  it("fails fast when messenger page id is missing", () => {
    const app = express();
    expect(() =>
      registerIdentityGameShareRoutes(app, { pageId: "   ", nodeEnv: "development" })
    ).toThrow("MESSENGER_PAGE_ID is required");
  });

  it("fails fast when messenger page id is not numeric", () => {
    const app = express();
    expect(() =>
      registerIdentityGameShareRoutes(app, {
        pageId: "61587343141159/extra",
        nodeEnv: "development",
      })
    ).toThrow("MESSENGER_PAGE_ID must be a numeric Facebook page id");
  });

  it("rejects active variants with missing share metadata", () => {
    const variants: GameVariantDefinition[] = [
      createVariant({
        variantId: "identity-broken",
        status: "active",
        entryRefs: ["identity-broken"],
        share: undefined,
      }),
    ];

    expect(() => assertIdentityGameVariantCatalog(variants)).toThrow(
      "must define share metadata"
    );
  });

  it("allows active share image urls with benign query params", () => {
    const variants: GameVariantDefinition[] = [
      createVariant({
        variantId: "identity-benign-query",
        status: "active",
        entryRefs: ["identity-benign-query"],
        share: {
          title: "Test",
          description: "Test",
          imageUrl: "https://leaderbot.live/og/identity-benign.jpg?v=2",
        },
      }),
    ];

    expect(() => assertIdentityGameVariantCatalog(variants)).not.toThrow();
  });

  it("rejects active share image urls on private or reserved IP literals", () => {
    const variants: GameVariantDefinition[] = [
      createVariant({
        variantId: "identity-private-ip-share",
        status: "active",
        entryRefs: ["identity-private-ip-share"],
        share: {
          title: "Test",
          description: "Test",
          imageUrl: "https://10.0.0.5/og/private.png",
        },
      }),
    ];

    expect(() => assertIdentityGameVariantCatalog(variants)).toThrow(
      "non-public or non-cache-safe share.imageUrl"
    );
  });

  it("rejects active share image urls on IPv4-mapped IPv6 private literals", () => {
    const variants: GameVariantDefinition[] = [
      createVariant({
        variantId: "identity-private-mapped-ip-share",
        status: "active",
        entryRefs: ["identity-private-mapped-ip-share"],
        share: {
          title: "Test",
          description: "Test",
          imageUrl: "https://[::ffff:127.0.0.1]/og/private.png",
        },
      }),
    ];

    expect(() => assertIdentityGameVariantCatalog(variants)).toThrow(
      "non-public or non-cache-safe share.imageUrl"
    );
  });

  it("serves OG tags and Messenger redirect for canonical share URLs", async () => {
    const app = express();
    registerIdentityGameShareRoutes(app, { pageId: "61587343141159", nodeEnv: "development" });

    const server = await listen(app);
    try {
      const response = await fetch(`${server.baseUrl}/play/identity-ai-v1`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('property="og:title"');
      expect(html).toContain('property="og:description"');
      expect(html).toContain('property="og:image"');
      expect(html).toContain("https://m.me/61587343141159?ref=identity-ai-v1");
    } finally {
      await server.close();
    }
  });

  it("serves DJ share metadata and non-identity Messenger ref format", async () => {
    const app = express();
    registerIdentityGameShareRoutes(app, { pageId: "61587343141159", nodeEnv: "development" });

    const server = await listen(app);
    try {
      const response = await fetch(`${server.baseUrl}/play/dj`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('property="og:title" content="Wat voor DJ ben jij écht?"');
      expect(html).toContain('property="og:description" content="Dit ga je niet leuk vinden 😄"');
      expect(html).toContain(
        'property="og:image" content="https://leaderbot.live/og/dj-v1-invite-v1.png"'
      );
      expect(html).toContain("https://m.me/61587343141159?ref=game%3Adj");
    } finally {
      await server.close();
    }
  });

  it("redirects active variants to canonical leaderbot.live in production", async () => {
    const app = express();
    registerIdentityGameShareRoutes(app, { pageId: "61587343141159", nodeEnv: "production" });
    const server = await listen(app);

    try {
      const response = await server.requestWithHost(
        "/play/identity-ai-v1",
        "alt.example.com"
      );
      expect(response.status).toBe(307);
      expect(response.headers.location).toBe(
        "https://leaderbot.live/play/identity-ai-v1"
      );
    } finally {
      await server.close();
    }
  });

  it("uses global OG defaults when non-active variants do not define share metadata", async () => {
    const qaVariant: GameVariantDefinition = createVariant({
      variantId: "identity-qa-flow",
      status: "qa",
      entryRefs: ["identity-qa-flow"],
    });

    const app = express();
    registerIdentityGameShareRoutes(app, {
      pageId: "61587343141159",
      nodeEnv: "development",
      variants: [qaVariant],
    });

    const server = await listen(app);
    try {
      const response = await fetch(`${server.baseUrl}/play/identity-qa-flow`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const html = await response.text();
      expect(html).toContain("Discover your AI archetype");
      expect(html).toContain("https://leaderbot.live/og/identity-games-default.jpg");
    } finally {
      await server.close();
    }
  });

  it("keeps public cache for active variants", async () => {
    const app = express();
    registerIdentityGameShareRoutes(app, { pageId: "61587343141159", nodeEnv: "development" });

    const server = await listen(app);
    try {
      const response = await fetch(`${server.baseUrl}/play/identity-ai-v1`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("public, max-age=300");
    } finally {
      await server.close();
    }
  });

  it("uses game: ref prefix for non-identity variants", async () => {
    const qaVariant: GameVariantDefinition = createVariant({
      variantId: "quiz-speed-v1",
      status: "qa",
      entryRefs: ["quiz-speed-v1", "game:quiz-speed-v1"],
    });

    const app = express();
    registerIdentityGameShareRoutes(app, {
      pageId: "61587343141159",
      nodeEnv: "development",
      variants: [qaVariant],
    });

    const server = await listen(app);
    try {
      const response = await fetch(`${server.baseUrl}/play/quiz-speed-v1`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("https://m.me/61587343141159?ref=game%3Aquiz-speed-v1");
    } finally {
      await server.close();
    }
  });

  it("escapes share metadata when rendering OG html", async () => {
    const variant: GameVariantDefinition = createVariant({
      variantId: "identity-escaped",
      status: "active",
      entryRefs: ["identity-escaped"],
      share: {
        title: 'Reveal <your> "AI" self',
        description: 'Fast & fun <cta>',
        imageUrl: "https://leaderbot.live/og/escaped.jpg?v=2",
      },
    });

    const app = express();
    registerIdentityGameShareRoutes(app, {
      pageId: "61587343141159",
      nodeEnv: "development",
      variants: [variant],
    });

    const server = await listen(app);
    try {
      const response = await fetch(`${server.baseUrl}/play/identity-escaped`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Reveal &lt;your&gt; &quot;AI&quot; self");
      expect(html).toContain("Fast &amp; fun &lt;cta&gt;");
      expect(html).toContain(
        'window.location.replace("https://m.me/61587343141159?ref=identity-escaped")'
      );
    } finally {
      await server.close();
    }
  });

  it("renders inline redirect script with safe encoded messenger URL", async () => {
    const variant: GameVariantDefinition = createVariant({
      variantId: "identity-script-safety",
      status: "active",
      entryRefs: ["identity-script-safety"],
      share: {
        title: "Safe",
        description: "Safe",
        imageUrl: "https://leaderbot.live/og/safe.png",
      },
    });

    const app = express();
    registerIdentityGameShareRoutes(app, {
      pageId: "61587343141159",
      nodeEnv: "development",
      variants: [variant],
    });

    const server = await listen(app);
    try {
      const response = await fetch(`${server.baseUrl}/play/identity-script-safety`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain(
        'window.location.replace("https://m.me/61587343141159?ref=identity-script-safety")'
      );
      expect(html).not.toContain("</script><script>");
    } finally {
      await server.close();
    }
  });

  it("rejects variants with incomplete resolution maps", () => {
    const variant = createVariant({
      variantId: "identity-incomplete-map",
      resolutionMap: {
        "q1_builder|q2_builder|q3_builder": "builder",
      },
    });

    expect(() => assertIdentityGameVariantCatalog([variant])).toThrow(
      "missing resolutionMap key"
    );
  });

  it("rejects variants with duplicate archetype ids", () => {
    const duplicateArchetypesVariant = createVariant({
      variantId: "identity-duplicate-archetypes",
      archetypes: [
        {
          id: "builder",
          title: "Builder",
          identityLine: "Builder identity",
          explanationLine: "Builder explanation",
        },
        {
          id: "builder",
          title: "Builder clone",
          identityLine: "Builder clone identity",
          explanationLine: "Builder clone explanation",
        },
        {
          id: "analyst",
          title: "Analyst",
          identityLine: "Analyst identity",
          explanationLine: "Analyst explanation",
        },
        {
          id: "operator",
          title: "Operator",
          identityLine: "Operator identity",
          explanationLine: "Operator explanation",
        },
      ],
      resolutionMap: Object.fromEntries(
        Object.keys(createVariant().resolutionMap).map(key => [key, "builder"])
      ),
    });

    expect(() => assertIdentityGameVariantCatalog([duplicateArchetypesVariant])).toThrow(
      "duplicate archetype ids"
    );
  });

  it("rejects variants missing required archetype coverage", () => {
    const missingArchetypeVariant = createVariant({
      variantId: "identity-missing-visionary",
      archetypes: [
        {
          id: "builder",
          title: "Builder",
          identityLine: "Builder identity",
          explanationLine: "Builder explanation",
        },
        {
          id: "builder",
          title: "Builder duplicate",
          identityLine: "Builder duplicate identity",
          explanationLine: "Builder duplicate explanation",
        },
        {
          id: "analyst",
          title: "Analyst",
          identityLine: "Analyst identity",
          explanationLine: "Analyst explanation",
        },
        {
          id: "operator",
          title: "Operator",
          identityLine: "Operator identity",
          explanationLine: "Operator explanation",
        },
      ],
      resolutionMap: Object.fromEntries(
        Object.keys(createVariant().resolutionMap).map(key => [key, "builder"])
      ),
    });

    expect(() => assertIdentityGameVariantCatalog([missingArchetypeVariant])).toThrow(
      "missing archetypes: visionary"
    );
  });

  it("uses first-answer fallback for all-different deterministic resolution triples", () => {
    const identityAiV1 = GAME_VARIANTS.find(variant => variant.variantId === "identity-ai-v1");
    expect(identityAiV1).toBeDefined();
    expect(identityAiV1!.resolutionMap["q1_build|q2_vision|q3_analyst"]).toBe("builder");
  });

  it("builds a full deterministic 64-key map for dj and uses first-answer fallback", () => {
    const djVariant = GAME_VARIANTS.find(variant => variant.variantId === "dj");
    expect(djVariant).toBeDefined();
    expect(Object.keys(djVariant!.resolutionMap)).toHaveLength(64);
    expect(djVariant!.resolutionMap["dj_q1_a3|dj_q2_a2|dj_q3_a1"]).toBe("analyst");
  });

  it("rejects variants with invalid option id separators", () => {
    const invalidOptionIdVariant = createVariant({
      variantId: "identity-invalid-option-id",
      questions: [
        {
          id: "q1",
          prompt: "Q1",
          options: [
            { id: "q1|builder", title: "A", archetypeId: "builder" },
            { id: "q1_visionary", title: "B", archetypeId: "visionary" },
            { id: "q1_analyst", title: "C", archetypeId: "analyst" },
            { id: "q1_operator", title: "D", archetypeId: "operator" },
          ],
        },
        createVariant().questions[1],
        createVariant().questions[2],
      ],
    });

    expect(() => assertIdentityGameVariantCatalog([invalidOptionIdVariant])).toThrow(
      "Invalid variant definition"
    );
  });

  it("rejects variants with duplicate option ids in one question", () => {
    const duplicateOptionIdVariant = createVariant({
      variantId: "identity-duplicate-option-id",
      questions: [
        {
          id: "q1",
          prompt: "Q1",
          options: [
            { id: "q1_dup", title: "A", archetypeId: "builder" },
            { id: "q1_dup", title: "B", archetypeId: "visionary" },
            { id: "q1_analyst", title: "C", archetypeId: "analyst" },
            { id: "q1_operator", title: "D", archetypeId: "operator" },
          ],
        },
        createVariant().questions[1],
        createVariant().questions[2],
      ],
      resolutionMap: Object.fromEntries(
        Object.keys(createVariant().resolutionMap)
          .filter(key => !key.startsWith("q1_builder|") && !key.startsWith("q1_visionary|"))
          .map(key => [key.replace("q1_builder|", "q1_dup|").replace("q1_visionary|", "q1_dup|"), "builder"])
      ),
    });

    expect(() => assertIdentityGameVariantCatalog([duplicateOptionIdVariant])).toThrow(
      "has duplicate option id: q1_dup"
    );
  });
});
