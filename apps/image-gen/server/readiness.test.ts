import http from "node:http";
import express from "express";
import { describe, expect, it, vi } from "vitest";

import { createReadinessHandler, type ReadinessCheck } from "./_core/readiness";
import { bindTestHttpServer } from "./testHttpServer";

async function startServer(checks: ReadinessCheck[]) {
  const app = express();
  app.get("/readyz", createReadinessHandler(checks));

  const server = http.createServer(app);
  const boundServer = await bindTestHttpServer(server);

  return {
    baseUrl: boundServer.baseUrl,
    close: boundServer.close,
  };
}

describe("readiness", () => {
  it("returns ok when all dependency checks pass", async () => {
    const server = await startServer([
      { name: "redis", check: vi.fn() },
      { name: "storage", check: vi.fn(async () => undefined) },
    ]);

    try {
      const response = await fetch(`${server.baseUrl}/readyz`);
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload).toEqual({
        ok: true,
        checks: [
          { name: "redis", ok: true },
          { name: "storage", ok: true },
        ],
      });
    } finally {
      await server.close();
    }
  });

  it("returns 503 with redacted error codes when a dependency check fails", async () => {
    class StorageConfigError extends Error {}
    const server = await startServer([
      { name: "redis", check: vi.fn() },
      {
        name: "image_storage_config",
        check: vi.fn(() => {
          throw new StorageConfigError("secret storage URL missing");
        }),
      },
    ]);

    try {
      const response = await fetch(`${server.baseUrl}/readyz`);
      const payload = await response.json();

      expect(response.status).toBe(503);
      expect(payload).toEqual({
        ok: false,
        checks: [
          { name: "redis", ok: true },
          {
            name: "image_storage_config",
            ok: false,
            error: "StorageConfigError",
          },
        ],
      });
      expect(JSON.stringify(payload)).not.toContain("secret storage URL");
    } finally {
      await server.close();
    }
  });
});
