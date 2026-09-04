import { COOKIE_NAME } from "@shared/const";
import type { Request } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { User } from "../drizzle/schema";

const mocks = vi.hoisted(() => ({
  getUserByOpenId: vi.fn(),
  upsertUser: vi.fn(),
}));

vi.mock("./db", () => ({
  getUserByOpenId: mocks.getUserByOpenId,
  upsertUser: mocks.upsertUser,
}));

const originalJwtSecret = process.env.JWT_SECRET;
const originalAppId = process.env.VITE_APP_ID;

afterEach(() => {
  mocks.getUserByOpenId.mockReset();
  mocks.upsertUser.mockReset();

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
  it("accepts sessions when name is empty", { timeout: 180_000 }, async () => {
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

  it("authenticates a session from a multi-cookie header", async () => {
    process.env.JWT_SECRET = "x".repeat(32);
    process.env.VITE_APP_ID = "leaderbot-app";

    vi.resetModules();
    const { sdk } = await import("./_core/sdk");
    const token = await sdk.signSession({
      openId: "open-id-cookie",
      appId: "leaderbot-app",
      name: "",
    });
    const now = new Date();
    const user = {
      id: 1,
      openId: "open-id-cookie",
      name: null,
      email: null,
      loginMethod: "facebook",
      role: "user",
      createdAt: now,
      updatedAt: now,
      lastSignedIn: now,
    } satisfies User;
    mocks.getUserByOpenId.mockResolvedValueOnce(user);

    await expect(
      sdk.authenticateRequest({
        headers: {
          cookie: `unrelated=value; ${COOKIE_NAME}=${token}`,
        },
      } as Request)
    ).resolves.toBe(user);
    expect(mocks.getUserByOpenId).toHaveBeenCalledWith("open-id-cookie");
    expect(mocks.upsertUser).toHaveBeenCalledWith({
      openId: "open-id-cookie",
      lastSignedIn: expect.any(Date),
    });
  });
});
