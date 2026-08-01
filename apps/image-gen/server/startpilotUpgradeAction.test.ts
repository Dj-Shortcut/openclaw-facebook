import { afterEach, describe, expect, it } from "vitest";
import {
  buildFreeQuotaReachedResponse,
  buildStartpilotQuotaReachedResponse,
} from "./_core/conversationActions";
import {
  renderMessengerQuickReplies,
  renderMessengerUrlButtons,
} from "./_core/messengerActionRenderer";

const originalBaseUrl = process.env.APP_BASE_URL;
const originalPortalBaseUrl = process.env.PORTAL_BASE_URL;
const originalLeaderbotPublicUrl = process.env.LEADERBOT_PUBLIC_URL;
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalBaseUrl === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = originalBaseUrl;
  if (originalPortalBaseUrl === undefined) delete process.env.PORTAL_BASE_URL;
  else process.env.PORTAL_BASE_URL = originalPortalBaseUrl;
  if (originalLeaderbotPublicUrl === undefined) {
    delete process.env.LEADERBOT_PUBLIC_URL;
  } else {
    process.env.LEADERBOT_PUBLIC_URL = originalLeaderbotPublicUrl;
  }
  process.env.NODE_ENV = originalNodeEnv;
});

describe("Startpilot upgrade action", () => {
  it("builds a channel-neutral portal action without a PSID", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    process.env.PORTAL_BASE_URL = "https://leaderbot.live";

    const response = buildStartpilotQuotaReachedResponse("nl");
    expect(response.actions).toEqual([
      {
        id: "open_startpilot_upgrade",
        label: "Open Leaderbot",
        url: "https://leaderbot.live/?upgrade=startpilot#pricing",
      },
    ]);
    expect(JSON.stringify(response)).not.toMatch(/psid|sender/i);
  });

  it("renders allowlisted HTTPS URLs as Messenger web buttons, not quick replies", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_BASE_URL = "https://leaderbot.live";
    const actions = buildStartpilotQuotaReachedResponse("en").actions;

    expect(renderMessengerQuickReplies(actions)).toEqual([]);
    expect(renderMessengerUrlButtons(actions)).toEqual([
      {
        type: "web_url",
        title: "Open Leaderbot",
        url: "https://leaderbot.live/?upgrade=startpilot#pricing",
        webview_height_ratio: "full",
      },
    ]);
  });

  it("offers free users a portal CTA when their daily image allowance ends", () => {
    process.env.NODE_ENV = "production";
    process.env.PORTAL_BASE_URL = "https://leaderbot.live";

    const response = buildFreeQuotaReachedResponse("nl");
    expect(response.text).toContain("gratis credits");
    expect(response.actions).toEqual([
      expect.objectContaining({
        id: "open_startpilot_upgrade",
        url: "https://leaderbot.live/?upgrade=startpilot#pricing",
      }),
    ]);
  });

  it("rejects credentials, insecure production URLs, and other origins", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_BASE_URL = "https://leaderbot.live";

    expect(
      renderMessengerUrlButtons([
        { id: "evil", label: "Open", url: "https://evil.example/pay" },
        {
          id: "credentials",
          label: "Open",
          url: "https://user:pass@leaderbot.live/pay",
        },
        { id: "http", label: "Open", url: "http://leaderbot.live/pay" },
      ])
    ).toEqual([]);
  });
});
