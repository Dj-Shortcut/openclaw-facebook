import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { registerOwnerProductWebRoutes } from "./_core/runtime/ownerProductWebRoutes";

const originalFlag = process.env.LEGACY_CUSTOMER_PORTAL_ENABLED;

afterEach(() => {
  if (originalFlag === undefined) {
    delete process.env.LEGACY_CUSTOMER_PORTAL_ENABLED;
  } else {
    process.env.LEGACY_CUSTOMER_PORTAL_ENABLED = originalFlag;
  }
});

describe("owner product web surface", () => {
  it("shows the current one-time Messenger offer and blocks legacy portal routes", async () => {
    delete process.env.LEGACY_CUSTOMER_PORTAL_ENABLED;
    const server = await startServer();
    try {
      const landing = await fetch(server.baseUrl);
      const body = await landing.text();
      expect(landing.status).toBe(200);
      expect(body).toContain("vijf premium afbeeldingscredits voor €3");
      expect(body).toContain("zonder abonnement");
      expect(body).not.toContain("Startpilot");

      await expect(fetch(`${server.baseUrl}/portal`)).resolves.toMatchObject({
        status: 404,
      });
      await expect(
        fetch(`${server.baseUrl}/api/trpc/portal.snapshot`)
      ).resolves.toMatchObject({ status: 404 });
    } finally {
      await server.close();
    }
  });

  it("keeps only authenticated legacy routes available with explicit migration opt-in", async () => {
    process.env.LEGACY_CUSTOMER_PORTAL_ENABLED = "true";
    const server = await startServer();
    try {
      const landing = await fetch(server.baseUrl);
      expect(landing.status).toBe(200);
      expect(await landing.text()).not.toContain("Startpilot");
      await expect(
        fetch(`${server.baseUrl}/api/trpc/portal.snapshot`)
      ).resolves.toMatchObject({ status: 404 });
    } finally {
      await server.close();
    }
  });
});

async function startServer() {
  const app = express();
  registerOwnerProductWebRoutes(app);
  app.use((_req, res) => res.status(404).send("fallback"));
  const listener = app.listen(0);
  await new Promise<void>(resolve => listener.once("listening", resolve));
  const { port } = listener.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        listener.close(error => (error ? reject(error) : resolve()))
      ),
  };
}
