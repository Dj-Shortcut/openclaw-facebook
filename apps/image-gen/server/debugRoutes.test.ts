import http from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bindTestHttpServer } from "./testHttpServer";
import { registerDebugRoutes } from "./_core/runtime/debugRoutes";
import { appendCostLedgerEntry } from "./_core/costLedger";
import * as costLedger from "./_core/costLedger";
import * as messengerGenerationQueue from "./_core/messengerGenerationQueue";
import { clearStateStore } from "./_core/stateStore";
import { resetAdminAuthRateLimiterForTests } from "./_core/adminAuth";
import {
  recordMessengerDeliveryFailure,
  recordMessengerDuplicateSkip,
  resetRuntimeStatsForTests,
} from "./_core/botRuntimeStats";

const originalAdminToken = process.env.ADMIN_TOKEN;

afterEach(() => {
  resetAdminAuthRateLimiterForTests();
  resetRuntimeStatsForTests();
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

  it("rejects impossible cost summary calendar dates", async () => {
    process.env.ADMIN_TOKEN = "secret-admin-token";
    const server = await startServer();

    try {
      const response = await fetch(
        `${server.baseUrl}/admin/cost-summary?period=2026-13-99`,
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
        queueHealth: {
          enabled: false,
          queued: 0,
          processing: 0,
          failed: 0,
        },
      });
      expect(JSON.stringify(payload)).not.toContain("prompt");
      expect(JSON.stringify(payload)).not.toContain("facebook:");
      expect(JSON.stringify(payload)).not.toContain("secret-admin-token");
    } finally {
      await server.close();
    }
  });

  it("renders an owner cost dashboard as aggregate-only plain text", async () => {
    process.env.ADMIN_TOKEN = "secret-admin-token";
    await appendCostLedgerEntry(
      {
        id: "req-dashboard-safe:attempt-1",
        channel: "facebook_messenger",
        operation: "image_generation",
        provider: "openai-images",
        model: "gpt-image-2",
        userKey: "user-key-dashboard-1",
        reqId: "req-dashboard-safe",
        status: "provider_attempt_failed",
        estimatedCostUsd: 0.025,
        estimatedOutputCostUsd: null,
        finalCostUsd: null,
        costEstimateComplete: true,
        estimateSource: "env_override",
        unpricedCostComponents: [],
      },
      new Date("2026-06-21T12:00:00.000Z")
    );
    await appendCostLedgerEntry(
      {
        id: "req-dashboard-blocked:attempt-1",
        channel: "facebook_messenger",
        operation: "audio_<script>alert(1)</script>",
        provider: "openai-audio<img src=x onerror=alert(1)>",
        model: "gpt-4o-transcribe",
        userKey: "user-key-dashboard-2",
        reqId: "raw-request-id-that-must-not-render",
        status: "blocked",
        estimatedCostUsd: 0,
        estimatedOutputCostUsd: null,
        finalCostUsd: null,
        costEstimateComplete: false,
        estimateSource: null,
        unpricedCostComponents: ["audio_seconds"],
      },
      new Date("2026-06-21T13:00:00.000Z")
    );
    recordMessengerDeliveryFailure();
    recordMessengerDuplicateSkip();
    const server = await startServer();

    try {
      const response = await fetch(
        `${server.baseUrl}/admin/cost-dashboard?period=2026-06-21`,
        { headers: { "x-admin-token": "secret-admin-token" } }
      );
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/plain");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body).toContain("Leaderbot Cost Dashboard");
      expect(body).toContain("Period: 2026-06-21");
      expect(body).toContain("$0.0250");
      expect(body).toContain("1 failed provider attempts");
      expect(body).toContain("1 budget or quota blocks");
      expect(body).toContain("1 incomplete cost estimates");
      expect(body).toContain("1 process-local Messenger delivery failures today");
      expect(body).toContain("1 process-local duplicate generation skips today");
      expect(body).toContain("Process-local delivery failures today");
      expect(body).toContain("Process-local duplicate skips today");
      expect(body).toContain("image_generation");
      expect(body).toContain("audio_scriptalert(1)/script");
      expect(body).toContain("openai-images");
      expect(body).toContain("openai-audioimg src=x onerror=alert(1)");
      expect(body).not.toContain("<script>alert(1)</script>");
      expect(body).not.toContain("<img src=x onerror=alert(1)>");
      expect(body).not.toContain("secret-admin-token");
      expect(body).not.toContain("raw-request-id-that-must-not-render");
      expect(body).not.toContain("make me a robot");
      expect(body).not.toContain("user-key-dashboard");
    } finally {
      await server.close();
    }
  });

  it("protects the owner cost dashboard behind the admin token", async () => {
    process.env.ADMIN_TOKEN = "secret-admin-token";
    const server = await startServer();

    try {
      const response = await fetch(`${server.baseUrl}/admin/cost-dashboard`);

      expect(response.status).toBe(403);
    } finally {
      await server.close();
    }
  });

  it("rejects invalid owner cost dashboard periods", async () => {
    process.env.ADMIN_TOKEN = "secret-admin-token";
    const server = await startServer();

    try {
      const response = await fetch(
        `${server.baseUrl}/admin/cost-dashboard?period=2026-02-31`,
        { headers: { "x-admin-token": "secret-admin-token" } }
      );

      expect(response.status).toBe(400);
      expect(await response.text()).toBe("invalid period");
    } finally {
      await server.close();
    }
  });

  it("keeps cost summaries available when queue health cannot be scraped", async () => {
    process.env.ADMIN_TOKEN = "secret-admin-token";
    await appendCostLedgerEntry(
      {
        id: "req-cost-route-queue-fail:attempt-1",
        channel: "facebook_messenger",
        operation: "image_generation",
        provider: "openai-images",
        model: "gpt-image-2",
        userKey: "user-key-1",
        reqId: "req-cost-route-queue-fail",
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
    const queueStatsMock = vi
      .spyOn(messengerGenerationQueue, "getMessengerGenerationQueueStats")
      .mockRejectedValue(new Error("queue scrape failed"));
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
        estimatedCostUsd: 0.025,
        queueHealth: {
          available: false,
          scrapeError: true,
          enabled: true,
          queued: 0,
          processing: 0,
          failed: 0,
        },
      });
      expect(JSON.stringify(payload)).not.toContain("queue scrape failed");
    } finally {
      queueStatsMock.mockRestore();
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
      const payload = await response.json();
      expect(payload).toEqual({
        error: "Failed to summarize cost period",
        requestId: expect.stringMatching(/^cost_summary_[0-9a-f-]{36}$/),
      });
      expect(JSON.stringify(payload)).not.toContain("summary failed");
    } finally {
      summaryMock.mockRestore();
      await server.close();
    }
  });
});
