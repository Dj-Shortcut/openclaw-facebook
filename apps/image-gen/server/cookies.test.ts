import { describe, expect, it } from "vitest";
import type { Request } from "express";

import { getSessionCookieOptions } from "./_core/cookies";

function buildRequest(overrides?: Partial<Request>): Request {
  return {
    protocol: "http",
    headers: {},
    ...overrides,
  } as Request;
}

describe("getSessionCookieOptions", () => {
  it("uses SameSite=None for secure requests", () => {
    const options = getSessionCookieOptions(
      buildRequest({
        protocol: "https",
      }),
    );

    expect(options).toMatchObject({
      secure: true,
      sameSite: "none",
      httpOnly: true,
      path: "/",
    });
  });

  it("uses SameSite=Lax for non-secure requests", () => {
    const options = getSessionCookieOptions(buildRequest());

    expect(options).toMatchObject({
      secure: false,
      sameSite: "lax",
      httpOnly: true,
      path: "/",
    });
  });

  it("treats x-forwarded-proto=https as secure", () => {
    const options = getSessionCookieOptions(
      buildRequest({
        protocol: "http",
        headers: {
          "x-forwarded-proto": "https",
        },
      }),
    );

    expect(options).toMatchObject({
      secure: true,
      sameSite: "none",
    });
  });
});
