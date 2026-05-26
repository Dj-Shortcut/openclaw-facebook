import { afterEach, describe, expect, it, vi } from "vitest";

const originalJwtSecret = process.env.JWT_SECRET;
const originalAppId = process.env.VITE_APP_ID;

afterEach(() => {
  if (originalJwtSecret === undefined) {
    delete process.env.JWT_SECRET;
  } else {
    process.env.JWT_SECRET = originalJwtSecret;
  }

  if (originalAppId === undefined) {
    delete process.env.VITE_APP_ID;
  } else {
    process.env.VITE_APP_ID = originalAppId;
  }
});

describe.sequential("SDK session verification", () => {
  it("accepts sessions when name is empty", { timeout: 30000 }, async () => {
    process.env.JWT_SECRET = "x".repeat(32);
    process.env.VITE_APP_ID = "leaderbot-app";

    vi.resetModules();
    const { sdk } = await import("./_core/sdk");

    const token = await sdk.signSession({
      openId: "open-id-1",
      appId: "leaderbot-app",
      name: "",
    });

    await expect(sdk.verifySession(token)).resolves.toEqual({
      openId: "open-id-1",
      appId: "leaderbot-app",
      name: "",
    });
  });
});
