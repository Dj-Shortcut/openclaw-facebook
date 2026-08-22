import { afterEach, describe, expect, it, vi } from "vitest";

describe("webhook handler context logging", () => {
  const originalLogLevel = process.env.LOG_LEVEL;
  const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

  afterEach(() => {
    if (originalLogLevel === undefined) {
      delete process.env.LOG_LEVEL;
    } else {
      process.env.LOG_LEVEL = originalLogLevel;
    }
    if (originalPrivacyPepper === undefined) {
      delete process.env.PRIVACY_PEPPER;
    } else {
      process.env.PRIVACY_PEPPER = originalPrivacyPepper;
    }
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("logs incoming Messenger debug metadata without raw user content", async () => {
    process.env.LOG_LEVEL = "debug";
    process.env.PRIVACY_PEPPER = "handler-context-test-pepper";
    vi.resetModules();
    const messengerApi = await import("./_core/messengerApi");
    const safeLogSpy = vi
      .spyOn(messengerApi, "safeLog")
      .mockImplementation(() => undefined);
    const { createHandlerContext } =
      await import("./_core/webhookHandlerContext");
    const ctx = createHandlerContext({
      defaultLang: "en",
      runImageGeneration: vi.fn(async () => ({ sent: true })),
    });

    ctx.logIncomingMessage(
      "raw-psid-debug-log",
      "raw-user-id-debug-log",
      {
        sender: { id: "raw-psid-debug-log" },
        recipient: { id: "page-id" },
        timestamp: 1,
        message: {
          mid: "mid-sensitive",
          text: "make me a secret robot caption",
          quick_reply: { payload: "SECRET_QUICK_REPLY" },
          attachments: [
            {
              type: "image",
              payload: {
                url: "https://secret.example/image.jpg?token=abc",
              },
            },
          ],
        },
        postback: {
          payload: "SECRET_POSTBACK_PAYLOAD",
        },
        referral: { ref: "SECRET_REFERRAL_VALUE" },
      },
      "req-debug-log"
    );

    expect(safeLogSpy).toHaveBeenCalledTimes(1);
    const [eventName, metadata] = safeLogSpy.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    const serialized = JSON.stringify(metadata);

    expect(eventName).toBe("incoming_message");
    expect(metadata).toMatchObject({
      hasContent: true,
      contentLength: "make me a secret robot caption".length,
      hasQuickReplyAction: true,
      quickReplyActionLength: "SECRET_QUICK_REPLY".length,
      hasPostbackAction: true,
      postbackActionLength: "SECRET_POSTBACK_PAYLOAD".length,
      mediaCount: 1,
      mediaCategories: ["image"],
      mediaUrlCount: 1,
      hasReferralRef: true,
    });
    expect(metadata.psidHash).toMatch(/^[a-f0-9]{12}$/);
    expect(serialized).not.toContain("raw-psid-debug-log");
    expect(serialized).not.toContain("raw-user-id-debug-log");
    expect(serialized).not.toContain("make me a secret robot caption");
    expect(serialized).not.toContain("SECRET_QUICK_REPLY");
    expect(serialized).not.toContain("SECRET_POSTBACK_PAYLOAD");
    expect(serialized).not.toContain("SECRET_REFERRAL_VALUE");
    expect(serialized).not.toContain("mid-sensitive");
    expect(serialized).not.toContain("secret.example");
    expect(serialized).not.toContain("token=abc");
  });

  it("keeps flow state isolated for the same sender across Facebook Pages", async () => {
    process.env.PRIVACY_PEPPER = "handler-context-flow-scope-test-pepper";
    delete process.env.REDIS_URL;
    vi.resetModules();
    const { createHandlerContext } =
      await import("./_core/webhookHandlerContext");
    const {
      getOrCreateState,
      getState,
      resetStateStore,
      setFlowState,
      setLastGenerationContext,
      setPendingImage,
    } = await import("./_core/messengerState");
    const { runWithMessengerRequestContext } =
      await import("./_core/messengerRequestContext");
    const ctx = createHandlerContext({
      defaultLang: "en",
      runImageGeneration: vi.fn(async () => ({ sent: true })),
    });
    const psid = "shared-page-scoped-flow-sender";

    try {
      await Promise.resolve(
        setPendingImage(psid, "https://private.example/legacy.jpg")
      );
      await Promise.resolve(
        setLastGenerationContext(psid, { prompt: "private legacy prompt" })
      );
      await Promise.resolve(setFlowState(psid, "PROCESSING"));

      await runWithMessengerRequestContext("page-one", async () => {
        const state = await Promise.resolve(getOrCreateState(psid));
        expect(state.stage).toBe("IDLE");
        expect(state.lastPhotoUrl).toBeNull();
        expect(state.pendingImageUrl).toBeUndefined();
        expect(state.lastPrompt).toBeUndefined();
        const featureContext = ctx.createFeatureTextContext(
          psid,
          state.userKey,
          "req-page-one",
          "en",
          state,
          "start",
          "start",
          false
        );
        await Promise.resolve(
          setPendingImage(psid, "https://private.example/page-one.jpg")
        );
        await Promise.resolve(
          setLastGenerationContext(psid, { prompt: "private page one prompt" })
        );
        await featureContext.setFlowState("PROCESSING");
        const pageOneState = await Promise.resolve(getState(psid));
        expect(pageOneState?.stage).toBe("PROCESSING");
        expect(pageOneState?.lastPhotoUrl).toBe(
          "https://private.example/page-one.jpg"
        );
        expect(pageOneState?.lastPrompt).toBe("private page one prompt");
      });

      await runWithMessengerRequestContext("page-two", async () => {
        const state = await Promise.resolve(getOrCreateState(psid));
        expect(state.stage).toBe("IDLE");
        expect(state.lastPhotoUrl).toBeNull();
        expect(state.pendingImageUrl).toBeUndefined();
        expect(state.lastPrompt).toBeUndefined();
        const featureContext = ctx.createFeatureTextContext(
          psid,
          state.userKey,
          "req-page-two",
          "en",
          state,
          "start",
          "start",
          false
        );
        await featureContext.setFlowState("AWAITING_PHOTO");
        expect((await Promise.resolve(getState(psid)))?.stage).toBe(
          "AWAITING_PHOTO"
        );
      });

      await runWithMessengerRequestContext("page-one", async () => {
        const state = await Promise.resolve(getState(psid));
        expect(state?.stage).toBe("PROCESSING");
        expect(state?.lastPhotoUrl).toBe(
          "https://private.example/page-one.jpg"
        );
        expect(state?.lastPrompt).toBe("private page one prompt");
      });
    } finally {
      resetStateStore();
    }
  });
});
