import express from "express";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { registerMetaWebhookRoutes } from "./_core/meta/webhookRoutes";
import { serveStatic } from "./_core/vite";

const tempDirs: string[] = [];

function createTempBuild() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "leaderbot-static-"));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, "index.html"), "<html><body><h1>Landing UI</h1></body></html>");
  fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dir, "assets", "app.js"), "console.log('ok');");
  return dir;
}

async function listen(app: express.Express) {
  return await new Promise<{
    baseUrl: string;
    close: () => Promise<void>;
  }>((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Unable to get test server address");
      }

      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((err) => {
              if (err) {
                closeReject(err);
                return;
              }
              closeResolve();
            });
          }),
      });
    });
  });
}

describe("serveStatic production mode", () => {
  afterEach(() => {
    delete process.env.META_VERIFY_TOKEN;

    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves index.html for root while keeping healthz and webhook routes working", async () => {
    const app = express();
    const staticDir = createTempBuild();

    app.get("/healthz", (_req, res) => {
      res.status(200).send("ok");
    });

    app.post("/webhook", (_req, res) => {
      res.status(200).json({ received: true });
    });

    serveStatic(app, staticDir);

    const server = await listen(app);

    try {
      const rootResponse = await fetch(`${server.baseUrl}/`);
      expect(rootResponse.status).toBe(200);
      const rootHtml = await rootResponse.text();
      expect(rootHtml).toContain("Landing UI");

      const healthResponse = await fetch(`${server.baseUrl}/healthz`);
      expect(healthResponse.status).toBe(200);
      expect(await healthResponse.text()).toBe("ok");

      const webhookResponse = await fetch(`${server.baseUrl}/webhook`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ test: true }),
      });
      expect(webhookResponse.status).toBe(200);
      expect(await webhookResponse.json()).toEqual({ received: true });
    } finally {
      await server.close();
    }
  });

  it("keeps WhatsApp webhook verification ahead of the SPA fallback", async () => {
    const app = express();
    const staticDir = createTempBuild();
    process.env.META_VERIFY_TOKEN = "test-token";

    registerMetaWebhookRoutes(app);
    serveStatic(app, staticDir);

    const server = await listen(app);

    try {
      const response = await fetch(
        `${server.baseUrl}/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=test-token&hub.challenge=wa-static-order`
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      const payload = await response.text();
      expect(payload).toBe("wa-static-order");
      expect(payload).not.toContain("Landing UI");
    } finally {
      await server.close();
    }
  });

});
