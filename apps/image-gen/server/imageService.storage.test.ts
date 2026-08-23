import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  setSourceImageDnsLookupForTests,
  setSourceImageRequestForTests,
} from "./_core/image-generation/sourceImageFetcher";

const GENERATED_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Z0ioAAAAASUVORK5CYII=";
const STORED_SOURCE_IMAGE_URL =
  "https://leaderbot-fb-image-gen.fly.dev/generated/source.jpg";
const TEST_SOURCE_IMAGE_FETCH_URL = "https://source-image.test/mock.jpg";

function toUrlString(url: string | URL): string {
  return typeof url === "string" ? url : url.toString();
}

describe("OpenAi image delivery via object storage", () => {
  beforeEach(() => {
    setSourceImageDnsLookupForTests(async () => [
      { address: "93.184.216.34", family: 4 },
    ]);
    setSourceImageRequestForTests(async () => {
      const response = await fetch(TEST_SOURCE_IMAGE_FETCH_URL, {
        redirect: "manual",
      });
      return {
        response,
        contentType:
          response.headers.get("content-type") ?? "application/octet-stream",
      };
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    setSourceImageDnsLookupForTests(null);
    setSourceImageRequestForTests(null);
    delete process.env.NODE_ENV;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_IMAGE_OUTPUT_FORMAT;
    delete process.env.SOURCE_IMAGE_ALLOWED_HOSTS;
    delete process.env.BUILT_IN_FORGE_API_URL;
    delete process.env.BUILT_IN_FORGE_API_KEY;
    delete process.env.APP_BASE_URL;
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.STORAGE_ALLOW_LEGACY_KEYS;
  });

  it("uploads generated image to storage and returns signed URL", async () => {
    process.env.OPENAI_API_KEY = "dummy-key";
    process.env.OPENAI_IMAGE_OUTPUT_FORMAT = "jpeg";
    process.env.SOURCE_IMAGE_ALLOWED_HOSTS = "leaderbot-fb-image-gen.fly.dev";
    process.env.BUILT_IN_FORGE_API_URL = "https://forge.example";
    process.env.BUILT_IN_FORGE_API_KEY = "forge-secret";
    process.env.PUBLIC_BASE_URL = "https://cdn.example";

    const { OpenAiImageGenerator } = await import("./_core/imageService");

    const sourceImage = Buffer.alloc(7000, 8);
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (toUrlString(url) === TEST_SOURCE_IMAGE_FETCH_URL) {
        return {
          ok: true,
          headers: new Headers({ "content-type": "image/jpeg" }),
          arrayBuffer: async () => sourceImage,
        } as Response;
      }

      if (toUrlString(url) === "https://api.openai.com/v1/responses") {
        return {
          ok: true,
          json: async () => ({
            output: [
              { type: "image_generation_call", result: GENERATED_IMAGE_BASE64 },
            ],
          }),
        } as Response;
      }

      if (
        toUrlString(url).startsWith(
          "https://forge.example/v1/storage/upload?path=generated%2Fimages%2F"
        )
      ) {
        expect(toUrlString(url)).toMatch(/\.jpg$/);
        expect(init?.method).toBe("POST");
        expect(init?.headers).toEqual(
          expect.objectContaining({
            Authorization: "Bearer forge-secret",
            "X-Leaderbot-Storage-Scope": "legacy-v1",
            "X-Leaderbot-Storage-Signature":
              expect.stringMatching(/^v1=[a-f0-9]{64}$/),
          })
        );
        expect(init?.body).toBeInstanceOf(FormData);
        const file = (init?.body as FormData).get("file") as File;
        expect(file.name).toMatch(/\.jpg$/);
        expect(file.type).toBe("image/jpeg");

        const objectKey = new URL(toUrlString(url)).searchParams.get("path");
        return {
          ok: true,
          json: async () => ({ url: `https://cdn.example/${objectKey}` }),
        } as Response;
      }

      throw new Error(`Unexpected fetch url: ${toUrlString(url)}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const generator = new OpenAiImageGenerator();
    const result = await generator.generate({
      sourceImageUrl: STORED_SOURCE_IMAGE_URL,
      trustedSourceImageUrl: true,
      sourceImageProvenance: "storeInbound",
      userKey: "user-1",
      reqId: "req-storage-1",
    });

    expect(result.imageUrl).toMatch(
      /^https:\/\/cdn\.example\/generated\/images\/\d+-[0-9a-f-]+\.jpg$/
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
  }, 10_000);

  it("fails clearly in production when durable storage config is missing", async () => {
    process.env.NODE_ENV = "production";

    const { assertProductionImageStorageConfig } =
      await import("./_core/image-generation/imageServiceConfig");
    const { MissingObjectStorageConfigError } =
      await import("./_core/image-generation/imageServiceErrors");

    expect(() => assertProductionImageStorageConfig()).toThrow(
      MissingObjectStorageConfigError
    );
    expect(() => assertProductionImageStorageConfig()).toThrow(
      "BUILT_IN_FORGE_API_URL and BUILT_IN_FORGE_API_KEY are required in production"
    );
  });

  it("fails closed in production without an exact trusted storage origin", async () => {
    process.env.NODE_ENV = "production";
    process.env.BUILT_IN_FORGE_API_URL = "https://forge.example";
    process.env.BUILT_IN_FORGE_API_KEY = "forge-secret";

    const { assertProductionImageStorageConfig } =
      await import("./_core/image-generation/imageServiceConfig");

    expect(() => assertProductionImageStorageConfig()).toThrow(
      /trusted HTTPS storage origin/
    );
  });
});
