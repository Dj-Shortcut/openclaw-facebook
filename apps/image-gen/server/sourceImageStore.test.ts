import { afterEach, describe, expect, it, vi } from "vitest";

const { storagePutMock } = vi.hoisted(() => ({
  storagePutMock: vi.fn(),
}));

vi.mock("./storage", () => ({
  storagePut: storagePutMock,
}));

describe("sourceImageStore", () => {
  afterEach(() => {
    vi.resetModules();
    storagePutMock.mockReset();
    delete process.env.APP_BASE_URL;
    delete process.env.BASE_URL;
    delete process.env.BUILT_IN_FORGE_API_URL;
    delete process.env.BUILT_IN_FORGE_API_KEY;
    delete process.env.NODE_ENV;
  });

  it("keeps local in-memory fallback outside production", async () => {
    process.env.APP_BASE_URL = "https://gateway.example";
    const { storeInboundSourceImage } = await import("./_core/sourceImageStore");

    const url = await storeInboundSourceImage(
      Buffer.from([1, 2, 3]),
      "image/jpeg",
      "req-local-source"
    );

    expect(url).toMatch(/^https:\/\/gateway\.example\/generated\/.+\.png$/);
    expect(storagePutMock).not.toHaveBeenCalled();
  });

  it("fails in production when durable source image storage is missing", async () => {
    process.env.NODE_ENV = "production";
    process.env.APP_BASE_URL = "https://gateway.example";
    const { storeInboundSourceImage } = await import("./_core/sourceImageStore");
    const { MissingObjectStorageConfigError } = await import(
      "./_core/image-generation/imageServiceErrors"
    );

    await expect(
      storeInboundSourceImage(
        Buffer.from([1, 2, 3]),
        "image/jpeg",
        "req-prod-source"
      )
    ).rejects.toThrow(MissingObjectStorageConfigError);
    expect(storagePutMock).not.toHaveBeenCalled();
  });

  it("stores inbound source images in object storage when configured", async () => {
    process.env.NODE_ENV = "production";
    process.env.BUILT_IN_FORGE_API_URL = "https://forge.example";
    process.env.BUILT_IN_FORGE_API_KEY = "forge-secret";
    storagePutMock.mockResolvedValue({
      key: "inbound-source/source.jpg",
      url: "https://cdn.example/inbound-source/source.jpg?signature=abc",
    });
    const { storeInboundSourceImage } = await import("./_core/sourceImageStore");

    const url = await storeInboundSourceImage(
      Buffer.from([1, 2, 3]),
      "image/jpeg",
      "req-prod-source"
    );

    expect(url).toBe(
      "https://cdn.example/inbound-source/source.jpg?signature=abc"
    );
    expect(storagePutMock).toHaveBeenCalledWith(
      expect.stringMatching(/^inbound-source\/\d+-[0-9a-f-]+\.jpg$/),
      Buffer.from([1, 2, 3]),
      "image/jpeg"
    );
  });
});
