import http from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindTestHttpServer } from "./testHttpServer";
import { registerDebugRoutes } from "./_core/runtime/debugRoutes";
import { appendCostLedgerEntry } from "./_core/costLedger";
import * as costLedger from "./_core/costLedger";
import { clearStateStore } from "./_core/stateStore";
import { resetAdminAuthRateLimiterForTests } from "./_core/adminAuth";

const originalAdminToken = process.env.ADMIN_TOKEN;

afterEach(() => {
  resetAdminAuthRateLimiterForTests();
  clearStateStore();
  if (originalAdminToken === undefined) {
    delete process.env.ADMIN_TOKEN;
  } else {
    process.env.ADMIN_TOKEN = originalAdminToken;
  }
});

async function startServer() {
  const app = express();
  registerDebugRoutes(app, "test-sha");
  const server = http.createServer(app);
  const boundServer = await bindTestHttpServer(server);
  return {
    baseUrl: boundServer.baseUrl,
    close: boundServer.close,
  };
}

describe("debug/admin routes", () => {
  it("protects the cost summary behind the admin token", async () => {
    process.env.ADMIN_TOKEN = "secret-admin-token";
    const server = await startServer();

    try {
      const response = await fetch(`${server.baseUrl}/admin/cost-summary`);

      expect(response.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("rejects invalid cost summary periods", async () => {
    process.env.ADMIN_TOKEN = "secret-admin-token";
    const server = await startServer();

    try {
      const response = await fetch(
        `${server.baseUrl}/admin/cost-summary?period=not-a-date`,
        { headers: { "x-admin-token": "secret-admin-token" } }
      );

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid period" });
    } finally {
      await server.close();
    }
  });

  it("returns owner-safe cost summary aggregates", async () => {
    process.env.ADMIN_TOKEN = "secret-admin-token";
    await appendCostLedgerEntry(
      {
        id: "req-cost-route:attempt-1",
        channel: "facebook_messenger",
        operation: "image_generation",
        provider: "openai-images",
        model: "gpt-image-2",
        userKey: "user-key-1",
        reqId: "req-cost-route",
        status: "provider_attempt_started",
        estimatedCostUsd: 0.025,
        estimatedOutputCostUsd: null,
        finalCostUsd: null,
        costEstimateComplete: true,
        estimateSource: "env_override",
        unpricedCostComponents: [],
      },
      new Date("2026-06-21T12:00:00.000Z")
    );
    const server = await startServer();

    try {
      const response = await fetch(
        `${server.baseUrl}/admin/cost-summary?period=2026-06-21`,
        { headers: { "x-admin-token": "secret-admin-token" } }
      );
      const payload = await response.json();

      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        period: "2026-06-21",
        totalEntries: 1,
        uniqueUserCount: 1,
        estimatedCostUsd: 0.025,
        openAttemptEntries: 1,
        failedAttemptEntries: 0,
        blockedEntries: 0,
        byStatus: {
          provider_attempt_started: 1,
          provider_attempt_succeeded: 0,
          provider_attempt_failed: 0,
          blocked: 0,
        },
        byOperation: {
          image_generation: {
            attempts: 1,
            estimatedCostUsd: 0.025,
          },
        },
      });
      expect(JSON.stringify(payload)).not.toContain("prompt");
      expect(JSON.stringify(payload)).not.toContain("facebook:");
      expect(JSON.stringify(payload)).not.toContain("secret-admin-token");
    } finally {
      await server.close();
    }
  });

  it("returns 500 when cost summary generation fails", async () => {
    process.env.ADMIN_TOKEN = "secret-admin-token";
    const summaryMock = vi
      .spyOn(costLedger, "summarizeCostLedgerPeriod")
      .mockRejectedValue(new Error("summary failed"));
    const server = await startServer();

    try {
      const response = await fetch(
        `${server.baseUrl}/admin/cost-summary?period=2026-06-21`,
        { headers: { "x-admin-token": "secret-admin-token" } }
      );

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "Failed to summarize cost period",
        requestId: "summary failed",
      });
    } finally {
      summaryMock.mockRestore();
      await server.close();
    }
  });
});
