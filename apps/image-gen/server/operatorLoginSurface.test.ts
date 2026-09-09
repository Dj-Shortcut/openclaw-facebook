import express from "express";
import { describe, expect, it } from "vitest";
import { registerOAuthRoutes } from "./_core/oauth";

/**
 * Messenger is the customer interface and there is no admin screen, so the
 * public page no longer advertises a way in. Two properties have to hold
 * together, and neither may be traded for the other:
 *
 * - nothing public discloses or exposes the operator login or the billing
 *   admin procedures;
 * - the operator login itself still exists, because it is the only safe way
 *   to reach credit recovery for held credits.
 */
function registeredPaths(register: (app: express.Express) => void): string[] {
  const app = express();
  register(app);
  const stack = (app as unknown as { router?: { stack: unknown[] } }).router
    ?.stack;
  return (stack ?? [])
    .map(layer => {
      const route = (layer as { route?: { path?: string } }).route;
      return route?.path;
    })
    .filter((path): path is string => typeof path === "string");
}

describe("operator login surface", () => {
  it("still registers the operator login and callback", () => {
    const paths = registeredPaths(registerOAuthRoutes);

    expect(paths).toContain("/api/oauth/start");
    expect(paths).toContain("/api/oauth/callback");
  });

  it("publishes no runtime config that advertises the login", async () => {
    const publicConfig = await import("./_core/runtime/publicConfig").catch(
      () => null
    );

    expect(publicConfig).toBeNull();
  });

  it("keeps the billing admin router behind the admin procedure", async () => {
    const routersSource = await import("node:fs/promises").then(fs =>
      fs.readFile(new URL("./routers.ts", import.meta.url), "utf8")
    );
    const adminRouterSource = await import("node:fs/promises").then(fs =>
      fs.readFile(
        new URL("./_core/billing/billingAdminRouter.ts", import.meta.url),
        "utf8"
      )
    );

    expect(routersSource).toContain("billingAdmin: billingAdminRouter");
    // Every exposed billing admin procedure is an admin procedure.
    expect(adminRouterSource).not.toMatch(/:\s*publicProcedure/);
    expect(adminRouterSource).toContain("adminProcedure");
  });
});
