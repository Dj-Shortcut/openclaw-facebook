import { describe, expect, it } from "vitest";
import { parseGameEntryIntent } from "./_core/entryIntent";

describe("entryIntent parsing", () => {
  it("normalizes a Messenger deep link into an identity game entry intent", () => {
    const result = parseGameEntryIntent({
      channel: "messenger",
      ref: "game:party-alter-ego?entryMode=confirm_first&campaignId=camp-1&creativeId=creative-9&entryVariant=feed-a",
      sourceType: "referral",
      localeHint: "nl",
      receivedAt: 1710000000000,
    });

    expect(result).toEqual({
      sourceChannel: "messenger",
      sourceType: "referral",
      targetExperienceType: "identity_game",
      targetExperienceId: "party-alter-ego",
      entryMode: "confirm_first",
      campaignId: "camp-1",
      creativeId: "creative-9",
      entryVariant: "feed-a",
      localeHint: "nl",
      rawRef:
        "game:party-alter-ego?entryMode=confirm_first&campaignId=camp-1&creativeId=creative-9&entryVariant=feed-a",
      receivedAt: 1710000000000,
    });
  });

  it("ignores non-game refs so style deep links can keep their own flow", () => {
    expect(
      parseGameEntryIntent({
        channel: "messenger",
        ref: "style_disco",
      })
    ).toBeNull();
  });

  it("accepts a bare identity-ai-v1 ref from a Messenger deep link", () => {
    const result = parseGameEntryIntent({
      channel: "messenger",
      ref: "identity-ai-v1",
      sourceType: "referral",
      localeHint: "nl",
      receivedAt: 1710000000000,
    });

    expect(result).toEqual({
      sourceChannel: "messenger",
      sourceType: "referral",
      targetExperienceType: "identity_game",
      targetExperienceId: "identity-ai-v1",
      entryMode: undefined,
      campaignId: undefined,
      creativeId: undefined,
      entryVariant: undefined,
      localeHint: "nl",
      rawRef: "identity-ai-v1",
      receivedAt: 1710000000000,
    });
  });

  it("accepts bare refs for other identity-prefixed variants", () => {
    const result = parseGameEntryIntent({
      channel: "messenger",
      ref: "identity-team-mirror",
      sourceType: "referral",
      receivedAt: 1710000000001,
    });

    expect(result).toEqual({
      sourceChannel: "messenger",
      sourceType: "referral",
      targetExperienceType: "identity_game",
      targetExperienceId: "identity-team-mirror",
      entryMode: undefined,
      campaignId: undefined,
      creativeId: undefined,
      entryVariant: undefined,
      localeHint: undefined,
      rawRef: "identity-team-mirror",
      receivedAt: 1710000000001,
    });
  });

  it("collapses repeated separators when normalizing game ids", () => {
    const result = parseGameEntryIntent({
      channel: "messenger",
      ref: "game: My Game!! ",
    });

    expect(result?.targetExperienceId).toBe("my-game");
  });

  it("collapses repeated preserved separators into a single hyphen", () => {
    const dashed = parseGameEntryIntent({
      channel: "messenger",
      ref: "game:my--game",
    });
    const underscored = parseGameEntryIntent({
      channel: "messenger",
      ref: "game:my__game",
    });

    expect(dashed?.targetExperienceId).toBe("my-game");
    expect(underscored?.targetExperienceId).toBe("my-game");
  });

  it("prefers locale encoded in the ref over the channel-provided locale hint", () => {
    const result = parseGameEntryIntent({
      channel: "messenger",
      ref: "game:party-alter-ego?locale=en",
      localeHint: "nl_BE",
    });

    expect(result?.localeHint).toBe("en");
  });

  it("maps leaderbot_start refs with query params to identity-ai-v1", () => {
    const result = parseGameEntryIntent({
      channel: "messenger",
      ref: "leaderbot_start?locale=en&campaignId=launch-1",
      sourceType: "referral",
      receivedAt: 1710000000002,
    });

    expect(result).toEqual({
      sourceChannel: "messenger",
      sourceType: "referral",
      targetExperienceType: "identity_game",
      targetExperienceId: "identity-ai-v1",
      entryMode: undefined,
      campaignId: "launch-1",
      creativeId: undefined,
      entryVariant: undefined,
      localeHint: "en",
      rawRef: "leaderbot_start?locale=en&campaignId=launch-1",
      receivedAt: 1710000000002,
    });
  });

  it("matches leaderbot_start case-insensitively", () => {
    const result = parseGameEntryIntent({
      channel: "messenger",
      ref: "LEADERBOT_START",
      sourceType: "referral",
      receivedAt: 1710000000003,
    });

    expect(result?.targetExperienceId).toBe("identity-ai-v1");
  });

  it("ignores an empty locale query value and falls back to the input locale hint", () => {
    const result = parseGameEntryIntent({
      channel: "messenger",
      ref: "game:party-alter-ego?locale=%20%20",
      localeHint: "nl_BE",
    });

    expect(result?.localeHint).toBe("nl_BE");
  });
});
