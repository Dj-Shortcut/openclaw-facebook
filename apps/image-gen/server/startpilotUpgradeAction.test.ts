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
const originalLeaderbotPublicUrl = process.env.LEADERBOT_PUBLIC_URL;
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalBaseUrl === undefined) delete process.env.APP_BASE_URL;
  else process.env.APP_BASE_URL = originalBaseUrl;
  if (originalLeaderbotPublicUrl === undefined) {
    delete process.env.LEADERBOT_PUBLIC_URL;
  } else {
    process.env.LEADERBOT_PUBLIC_URL = originalLeaderbotPublicUrl;
  }
  process.env.NODE_ENV = originalNodeEnv;
});

describe("Startpilot upgrade action", () => {
  it("does not expose the obsolete static Startpilot checkout", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";

    const response = buildStartpilotQuotaReachedResponse("nl");
    expect(response.actions).toEqual([]);
    expect(JSON.stringify(response)).not.toMatch(/psid|sender/i);
  });

  it("distinguishes today's Startpilot limit from the total credit", () => {
    process.env.NODE_ENV = "production";

    const daily = buildStartpilotQuotaReachedResponse("nl", "daily_exhausted");
    const total = buildStartpilotQuotaReachedResponse("nl", "total_exhausted");

    expect(daily.text).toContain("Morgen kun je weer afbeeldingen maken");
    expect(daily.text).not.toContain("tegoed is opgebruikt");
    expect(total.text).toContain("tegoed is opgebruikt");
    expect(daily.actions).toEqual(total.actions);
  });

  it("does not render an upgrade button before the scoped checkout exists", () => {
    process.env.NODE_ENV = "production";
    const actions = buildStartpilotQuotaReachedResponse("en").actions;

    expect(renderMessengerQuickReplies(actions)).toEqual([]);
    expect(renderMessengerUrlButtons(actions)).toEqual([]);
  });

  it("keeps the free-quota message informational until credit checkout exists", () => {
    process.env.NODE_ENV = "production";

    const response = buildFreeQuotaReachedResponse("nl");
    expect(response.text).toContain("gratis credits");
    expect(response.actions).toEqual([]);
  });

  it("omits the upgrade action when only the backend host is configured", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_BASE_URL = "https://leaderbot-fb-image-gen.fly.dev";
    delete process.env.LEADERBOT_PUBLIC_URL;

    expect(buildStartpilotQuotaReachedResponse("en").actions).toEqual([]);
  });

  it("falls back to quick replies for URL actions rejected as web buttons", () => {
    process.env.NODE_ENV = "production";
    process.env.APP_BASE_URL = "https://app.leaderbot.live";
    const actions = [
      { id: "evil", label: "Open", url: "https://evil.example/pay" },
      {
        id: "credentials",
        label: "Open",
        url: "https://user:pass@app.leaderbot.live/pay",
      },
      { id: "http", label: "Open", url: "http://app.leaderbot.live/pay" },
    ];

    expect(renderMessengerUrlButtons(actions)).toEqual([]);
    expect(renderMessengerQuickReplies(actions)).toEqual([
      {
        content_type: "text",
        title: "Open",
        payload: "OPENCLAW_ACTION:Open",
      },
      {
        content_type: "text",
        title: "Open",
        payload: "OPENCLAW_ACTION:Open",
      },
      {
        content_type: "text",
        title: "Open",
        payload: "OPENCLAW_ACTION:Open",
      },
    ]);
  });
});
