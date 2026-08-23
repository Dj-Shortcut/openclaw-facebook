import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  fetchSource: vi.fn(),
  storeSource: vi.fn(),
  createObjectKey: vi.fn(),
  hasObjectStorage: vi.fn(),
  getOwnership: vi.fn(),
  getPageId: vi.fn(),
  getPrivacySubject: vi.fn(),
  reserveFence: vi.fn(),
  registerObject: vi.fn(),
  markStarted: vi.fn(),
  finalizeFence: vi.fn(),
  unregisterObject: vi.fn(),
  storageDelete: vi.fn(),
  safeLog: vi.fn(),
}));

vi.mock("./_core/image-generation/imageServiceConfig", () => ({
  hasObjectStorageConfig: mocks.hasObjectStorage,
}));
vi.mock("./_core/image-generation/sourceImageFetcher", () => ({
  fetchExternalSourceImageForIngress: mocks.fetchSource,
}));
vi.mock("./_core/sourceImageStore", () => ({
  createInboundSourceImageObjectKey: mocks.createObjectKey,
  storeInboundSourceImage: mocks.storeSource,
}));
vi.mock("./_core/messengerRequestContext", () => ({
  getMessengerRequestOwnership: mocks.getOwnership,
  getMessengerRequestPageId: mocks.getPageId,
  getMessengerRequestPrivacySubject: mocks.getPrivacySubject,
}));
vi.mock("./_core/messengerProviderAttemptFence", () => ({
  reserveMessengerProviderAttemptFence: mocks.reserveFence,
  markMessengerProviderAttemptStarted: mocks.markStarted,
  finalizeMessengerProviderAttemptFence: mocks.finalizeFence,
}));
vi.mock("./_core/messengerGenerationCompletion", () => ({
  registerMessengerObjectForPrivacyCleanup: mocks.registerObject,
  unregisterMessengerObjectFromPrivacyCleanup: mocks.unregisterObject,
}));
const testUserKey = "a".repeat(64);
vi.mock("./_core/privacy", () => ({ toUserKey: () => "a".repeat(64) }));
vi.mock("./_core/messengerApi", () => ({ safeLog: mocks.safeLog }));
vi.mock("./storage", () => ({
  storageDelete: mocks.storageDelete,
  storageKeyFromPublicUrl: vi.fn(),
}));

import { normalizeMessengerInboundImage } from "./_core/messengerImageIngress";

const input = {
  inboundImageUrl: "https://meta.example/private-source.jpg",
  psid: "sender-1",
  psidHash: "hashed-sender",
  reqId: "req-source-1",
};
const providerFence = {
  leaseToken: "lease-1",
  attemptKeyHash: "attempt-1",
};

describe("Messenger source image upload fence", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.order.length = 0;
    process.env.NODE_ENV = "production";
    mocks.hasObjectStorage.mockReturnValue(true);
    mocks.getOwnership.mockReturnValue({
      workspaceId: 42,
      channelConnectionId: 7,
      bindingEpoch: 3,
    });
    mocks.getPageId.mockReturnValue("page-1");
    mocks.getPrivacySubject.mockReturnValue({
      userKey: testUserKey,
      privacyEpoch: 5,
    });
    mocks.fetchSource.mockImplementation(async () => {
      mocks.order.push("download");
      return { buffer: Buffer.from("image"), contentType: "image/jpeg" };
    });
    mocks.createObjectKey.mockReturnValue(
      `inbound-source/v1/workspace-42/connection-7/binding-3/privacy-5/user-${testUserKey}/1787461200000-00000000-0000-4000-8000-000000000000.jpg`
    );
    mocks.reserveFence.mockImplementation(async () => {
      mocks.order.push("reserve");
      return providerFence;
    });
    mocks.registerObject.mockImplementation(async () => {
      mocks.order.push("inventory");
      return true;
    });
    mocks.markStarted.mockImplementation(async () => {
      mocks.order.push("started");
    });
    mocks.storeSource.mockImplementation(async () => {
      mocks.order.push("upload");
      return "https://assets.example/inbound-source/source.jpg";
    });
    mocks.finalizeFence.mockImplementation(
      async (_fence: unknown, outcome: string) => {
        mocks.order.push(`finalize:${outcome}`);
      }
    );
    mocks.unregisterObject.mockImplementation(async () => {
      mocks.order.push("unregister");
      return true;
    });
    mocks.storageDelete.mockImplementation(async () => {
      mocks.order.push("delete");
    });
  });

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it("inventories and starts the privacy fence before uploading", async () => {
    await expect(normalizeMessengerInboundImage(input)).resolves.toBe(
      "https://assets.example/inbound-source/source.jpg"
    );

    expect(mocks.order).toEqual([
      "download",
      "reserve",
      "inventory",
      "started",
      "upload",
      "finalize:succeeded",
    ]);
    expect(mocks.storeSource).toHaveBeenCalledWith(
      Buffer.from("image"),
      "image/jpeg",
      input.reqId,
      `inbound-source/v1/workspace-42/connection-7/binding-3/privacy-5/user-${testUserKey}/1787461200000-00000000-0000-4000-8000-000000000000.jpg`
    );
    expect(mocks.createObjectKey).toHaveBeenCalledWith(
      "image/jpeg",
      expect.objectContaining({
        workspaceId: 42,
        channelConnectionId: 7,
        bindingEpoch: 3,
        privacyEpoch: 5,
        userKey: testUserKey,
      })
    );
  });

  it("does not upload while the durable start barrier is unresolved", async () => {
    let releaseStart!: () => void;
    const startBarrier = new Promise<void>(resolve => {
      releaseStart = resolve;
    });
    mocks.markStarted.mockImplementation(async () => {
      mocks.order.push("started");
      await startBarrier;
    });

    const pending = normalizeMessengerInboundImage(input);
    await vi.waitFor(() => expect(mocks.markStarted).toHaveBeenCalledOnce());
    expect(mocks.storeSource).not.toHaveBeenCalled();
    releaseStart();
    await expect(pending).resolves.toBe(
      "https://assets.example/inbound-source/source.jpg"
    );
  });

  it("keeps a failed upload inventoried even when immediate delete succeeds", async () => {
    mocks.storeSource.mockImplementation(async () => {
      mocks.order.push("upload");
      throw new Error("upload failed");
    });

    await expect(normalizeMessengerInboundImage(input)).resolves.toBeNull();
    expect(mocks.order).toEqual([
      "download",
      "reserve",
      "inventory",
      "started",
      "upload",
      "delete",
      "finalize:ambiguous",
    ]);
    expect(mocks.unregisterObject).not.toHaveBeenCalled();
  });

  it("keeps ambiguous failed uploads inventoried for later erasure", async () => {
    mocks.storeSource.mockRejectedValue(new Error("upload timed out"));
    mocks.storageDelete.mockRejectedValue(new Error("delete timed out"));

    await expect(normalizeMessengerInboundImage(input)).resolves.toBeNull();
    expect(mocks.unregisterObject).not.toHaveBeenCalled();
    expect(mocks.finalizeFence).toHaveBeenCalledWith(
      providerFence,
      "ambiguous"
    );
  });

  it("refuses an erased subject before the upload starts", async () => {
    mocks.registerObject.mockResolvedValue(false);

    await expect(normalizeMessengerInboundImage(input)).resolves.toBeNull();
    expect(mocks.markStarted).not.toHaveBeenCalled();
    expect(mocks.storeSource).not.toHaveBeenCalled();
    expect(mocks.finalizeFence).toHaveBeenCalledWith(
      providerFence,
      "known_failed"
    );
  });

  it("does not even download when production privacy scope is missing", async () => {
    mocks.getPrivacySubject.mockReturnValue(undefined);

    await expect(normalizeMessengerInboundImage(input)).resolves.toBeNull();
    expect(mocks.fetchSource).not.toHaveBeenCalled();
    expect(mocks.reserveFence).not.toHaveBeenCalled();
    expect(mocks.storeSource).not.toHaveBeenCalled();
  });
});
