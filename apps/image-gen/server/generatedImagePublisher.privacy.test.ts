import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
const {
  storagePutMock,
  storageDeleteMock,
  registerObjectMock,
  unregisterObjectMock,
  reserveFenceMock,
  markFenceStartedMock,
  finalizeFenceMock,
} = vi.hoisted(() => ({
  storagePutMock: vi.fn(),
  storageDeleteMock: vi.fn(),
  registerObjectMock: vi.fn(),
  unregisterObjectMock: vi.fn(),
  reserveFenceMock: vi.fn(),
  markFenceStartedMock: vi.fn(),
  finalizeFenceMock: vi.fn(),
}));

vi.mock("./storage", () => ({
  storagePut: storagePutMock,
  storageDelete: storageDeleteMock,
}));

vi.mock("./_core/messengerGenerationCompletion", () => ({
  registerMessengerObjectForPrivacyCleanup: registerObjectMock,
  unregisterMessengerObjectFromPrivacyCleanup: unregisterObjectMock,
}));

vi.mock("./_core/messengerProviderAttemptFence", () => ({
  reserveMessengerProviderAttemptFence: reserveFenceMock,
  markMessengerProviderAttemptStarted: markFenceStartedMock,
  finalizeMessengerProviderAttemptFence: finalizeFenceMock,
}));

vi.mock("./_core/image-generation/imageServiceConfig", () => ({
  hasObjectStorageConfig: () => true,
  assertProductionImageStorageConfig: vi.fn(),
  getRequiredPublicBaseUrl: () => "https://app.example",
}));

vi.mock("./_core/image-generation/openAiImageClient", () => ({
  getOpenAiImageOutputContentType: () => "image/png",
  getOpenAiImageOutputExtension: () => "png",
}));

vi.mock("./_core/logger", () => ({ safeLog: vi.fn() }));

import { publishGeneratedImage } from "./_core/image-generation/generatedImagePublisher";
import { runWithMessengerRequestContext } from "./_core/messengerRequestContext";

const userKey = "a".repeat(64);
const originalNodeEnv = process.env.NODE_ENV;
const originalLegacyKeys = process.env.STORAGE_ALLOW_LEGACY_KEYS;

async function publishInScope(): Promise<string> {
  return await runWithMessengerRequestContext(
    "page-1",
    async () => await publishGeneratedImage(Buffer.from("image"), "req-1"),
    {
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
      privacyEpoch: 5,
      userKey,
    }
  );
}

describe("generated image privacy-safe upload", () => {
  beforeEach(() => {
    calls.length = 0;
    storagePutMock.mockReset();
    storageDeleteMock.mockReset();
    registerObjectMock.mockReset();
    unregisterObjectMock.mockReset();
    reserveFenceMock.mockReset();
    markFenceStartedMock.mockReset();
    finalizeFenceMock.mockReset();
    reserveFenceMock.mockImplementation(async () => {
      calls.push("reserve");
      return { leaseToken: "lease", attemptKeyHash: "attempt" };
    });
    registerObjectMock.mockImplementation(async () => {
      calls.push("inventory");
      return true;
    });
    unregisterObjectMock.mockImplementation(async () => {
      calls.push("unregister");
      return true;
    });
    markFenceStartedMock.mockImplementation(async () => {
      calls.push("started");
    });
    finalizeFenceMock.mockImplementation(async (_fence, outcome) => {
      calls.push(`finalize:${outcome}`);
    });
    storageDeleteMock.mockImplementation(async () => {
      calls.push("delete");
    });
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalLegacyKeys === undefined) {
      delete process.env.STORAGE_ALLOW_LEGACY_KEYS;
    } else {
      process.env.STORAGE_ALLOW_LEGACY_KEYS = originalLegacyKeys;
    }
  });

  it("fails closed in production when Messenger tenant scope is absent", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.STORAGE_ALLOW_LEGACY_KEYS;

    await expect(
      publishGeneratedImage(Buffer.from("image"), "req-unscoped")
    ).rejects.toThrow(/Tenant-scoped generated image storage is required/);
    expect(storagePutMock).not.toHaveBeenCalled();
  });

  it("durably inventories the exact scoped key before the first PUT", async () => {
    storagePutMock.mockImplementation(async (key: string) => {
      calls.push("put");
      return { key, url: `https://assets.example/${key}` };
    });

    const url = await publishInScope();

    expect(url).toContain("generated/images/v1/workspace-42/");
    expect(calls).toEqual([
      "reserve",
      "inventory",
      "started",
      "put",
      "finalize:succeeded",
    ]);
    expect(unregisterObjectMock).not.toHaveBeenCalled();
  });

  it("never starts a PUT when the pre-write inventory fence rejects", async () => {
    registerObjectMock.mockImplementationOnce(async () => {
      calls.push("inventory");
      return false;
    });

    await expect(publishInScope()).rejects.toThrow(/subject is erased/);

    expect(storagePutMock).not.toHaveBeenCalled();
    expect(calls).toEqual(["reserve", "inventory", "finalize:known_failed"]);
  });

  it("keeps inventory and an ambiguous provider fence after a remote commit timeout", async () => {
    storagePutMock.mockImplementationOnce(async () => {
      calls.push("remote_commit");
      throw new Error("Storage upload timed out");
    });

    await expect(publishInScope()).rejects.toThrow(/timed out/);

    expect(calls).toEqual([
      "reserve",
      "inventory",
      "started",
      "remote_commit",
      "delete",
      "finalize:ambiguous",
    ]);
    expect(unregisterObjectMock).not.toHaveBeenCalled();
  });

  it("removes inventory only after a returned PUT is confirmed deleted", async () => {
    storagePutMock.mockImplementation(async (key: string) => {
      calls.push("put");
      return { key, url: `https://assets.example/${key}` };
    });
    finalizeFenceMock.mockImplementation(async (_fence, outcome) => {
      calls.push(`finalize:${outcome}`);
      if (outcome === "succeeded") throw new Error("fence commit failed");
    });

    await expect(publishInScope()).rejects.toThrow(/fence commit failed/);

    expect(calls).toEqual([
      "reserve",
      "inventory",
      "started",
      "put",
      "finalize:succeeded",
      "delete",
      "unregister",
      "finalize:known_failed",
    ]);
  });
});
