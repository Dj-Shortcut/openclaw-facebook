import { afterEach, describe, expect, it, vi } from "vitest";

const { createImageGeneratorMock, storageGetMock } = vi.hoisted(() => ({
  createImageGeneratorMock: vi.fn(),
  storageGetMock: vi.fn(),
}));

vi.mock("./_core/imageService", () => ({
  createImageGenerator: createImageGeneratorMock,
}));

vi.mock("./_core/image-generation/imageServiceErrors", () => ({
  GenerationTimeoutError: class GenerationTimeoutError extends Error {},
  MissingAppBaseUrlError: class MissingAppBaseUrlError extends Error {},
  MissingObjectStorageConfigError: class MissingObjectStorageConfigError extends Error {},
  MissingOpenAiApiKeyError: class MissingOpenAiApiKeyError extends Error {},
}));

vi.mock("./_core/image-generation/openAiImageClient", () => ({
  getGenerationMetrics: (error: Error & { generationMetrics?: unknown }) =>
    error.generationMetrics,
  OpenAiBudgetExceededError: class OpenAiBudgetExceededError extends Error {},
}));

vi.mock("./_core/image-generation/sourceImageFetcher", () => ({
  InvalidSourceImageUrlError: class InvalidSourceImageUrlError extends Error {},
  MissingInputImageError: class MissingInputImageError extends Error {},
}));

vi.mock("./storage", () => ({
  storageGet: storageGetMock,
  storageKeyFromPublicUrl: (publicUrl: string) => {
    try {
      const parsed = new URL(publicUrl);
      return decodeURIComponent(parsed.pathname.replace(/^\/+/, "")) || null;
    } catch {
      return null;
    }
  },
}));

import { executeGenerationFlow } from "./_core/generationFlow";
import { GenerationTimeoutError } from "./_core/image-generation/imageServiceErrors";
import { OpenAiBudgetExceededError } from "./_core/image-generation/openAiImageClient";
import {
  InvalidSourceImageUrlError,
  MissingInputImageError,
} from "./_core/image-generation/sourceImageFetcher";

describe("generationFlow", () => {
  const originalForgeApiUrl = process.env.BUILT_IN_FORGE_API_URL;

  afterEach(() => {
    createImageGeneratorMock.mockReset();
    storageGetMock.mockReset();
    if (originalForgeApiUrl === undefined) {
      delete process.env.BUILT_IN_FORGE_API_URL;
    } else {
      process.env.BUILT_IN_FORGE_API_URL = originalForgeApiUrl;
    }
  });

  it("returns missing_source_image when no source image is available", async () => {
    const result = await executeGenerationFlow({
      generationKind: "source_image_edit",
      userId: "user-1",
      reqId: "req-1",
    });

    expect(result).toMatchObject({
      kind: "error",
      errorKind: "missing_source_image",
      trustedSourceImageUrl: false,
    });
  });

  it("marks stored last photo URLs as trusted", async () => {
    const generateMock = vi.fn().mockResolvedValue({
      imageUrl: "https://example.com/generated.jpg",
      proof: {
        incomingLen: 10,
        incomingSha256: "in",
        openaiInputLen: 10,
        openaiInputSha256: "out",
      },
      metrics: { totalMs: 123 },
    });
    createImageGeneratorMock.mockReturnValue({
      mode: "openai-images",
      generator: { generate: generateMock },
    });

    const result = await executeGenerationFlow({
      userId: "user-1",
      reqId: "req-1",
      lastPhotoUrl: "https://stored.example/image.jpg",
      lastPhotoSource: "stored",
    });

    expect(result).toMatchObject({
      kind: "success",
      trustedSourceImageUrl: true,
      resolvedSourceImageUrl: "https://stored.example/image.jpg",
    });
    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        generationKind: "source_image_edit",
        trustedSourceImageUrl: true,
        sourceImageProvenance: "storeInbound",
      })
    );
  });

  it("defaults source-less requests to text-to-image instead of legacy presets", async () => {
    const generateMock = vi.fn().mockResolvedValue({
      imageUrl: "https://example.com/generated.jpg",
      proof: {
        incomingLen: 0,
        incomingSha256: "",
        openaiInputLen: 10,
        openaiInputSha256: "out",
      },
      metrics: { totalMs: 123 },
    });
    createImageGeneratorMock.mockReturnValue({
      mode: "openai-images",
      generator: { generate: generateMock },
    });

    const result = await executeGenerationFlow({
      userId: "user-1",
      reqId: "req-text-default",
      promptHint: "Maak een landschap",
    });

    expect(result).toMatchObject({
      kind: "success",
      trustedSourceImageUrl: false,
      resolvedSourceImageUrl: "",
    });
    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        generationKind: "text_to_image",
        sourceImageUrl: undefined,
      })
    );
  });

  it("refreshes stored source image URLs through the storage proxy before generation", async () => {
    process.env.BUILT_IN_FORGE_API_URL = "https://forge.example";
    storageGetMock.mockResolvedValue({
      key: "inbound-source/photo.jpg",
      url: "https://signed.example/inbound-source/photo.jpg?signature=fresh",
    });
    const generateMock = vi.fn().mockResolvedValue({
      imageUrl: "https://example.com/generated.jpg",
      proof: {
        incomingLen: 10,
        incomingSha256: "in",
        openaiInputLen: 10,
        openaiInputSha256: "out",
      },
      metrics: { totalMs: 123 },
    });
    createImageGeneratorMock.mockReturnValue({
      mode: "openai-images",
      generator: { generate: generateMock },
    });

    const result = await executeGenerationFlow({
      userId: "user-1",
      reqId: "req-1",
      lastPhotoUrl: "https://assets.example/inbound-source/photo.jpg?signature=old",
      lastPhotoSource: "stored",
    });

    expect(result).toMatchObject({
      kind: "success",
      trustedSourceImageUrl: true,
      resolvedSourceImageUrl:
        "https://signed.example/inbound-source/photo.jpg?signature=fresh",
    });
    expect(storageGetMock).toHaveBeenCalledWith("inbound-source/photo.jpg");
    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceImageUrl:
          "https://signed.example/inbound-source/photo.jpg?signature=fresh",
        trustedSourceImageUrl: true,
        sourceImageProvenance: "storeInbound",
      })
    );
  });

  it("drops stale director fields before calling the prompt-first image generator", async () => {
    const generateMock = vi.fn().mockResolvedValue({
      imageUrl: "https://example.com/generated.jpg",
      proof: {
        incomingLen: 10,
        incomingSha256: "in",
        openaiInputLen: 10,
        openaiInputSha256: "out",
      },
      metrics: { totalMs: 123 },
    });
    createImageGeneratorMock.mockReturnValue({
      mode: "openai-images",
      generator: { generate: generateMock },
    });

    const result = await executeGenerationFlow({
      userId: "user-1",
      reqId: "req-1",
      lastPhotoUrl: "https://stored.example/image.jpg",
      lastPhotoSource: "stored",
      directorMode: "midnight_luxury",
      directorInstruction: "make it feel like an exclusive event portrait",
      directorPhotoAnalysis: "The source image has low ambient light.",
    });

    expect(result).toMatchObject({ kind: "success" });
    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({ generationKind: "source_image_edit" })
    );
    expect(generateMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        directorMode: expect.anything(),
        directorInstruction: expect.anything(),
        directorPhotoAnalysis: expect.anything(),
      })
    );
  });

  it("does not trust stored source image URLs when no storage key can be derived", async () => {
    process.env.BUILT_IN_FORGE_API_URL = "https://forge.example";

    const result = await executeGenerationFlow({
      userId: "user-1",
      reqId: "req-1",
      lastPhotoUrl: "not-a-valid-url",
      lastPhotoSource: "stored",
    });

    expect(result).toMatchObject({
      kind: "error",
      errorKind: "invalid_source_image",
      resolvedSourceImageUrl: "not-a-valid-url",
      trustedSourceImageUrl: false,
    });
    expect(storageGetMock).not.toHaveBeenCalled();
    expect(createImageGeneratorMock).not.toHaveBeenCalled();
  });


  it("prefers the most recent stored upload over an explicit stale source image", async () => {
    const generateMock = vi.fn().mockResolvedValue({
      imageUrl: "https://example.com/generated.jpg",
      proof: {
        incomingLen: 10,
        incomingSha256: "in",
        openaiInputLen: 10,
        openaiInputSha256: "out",
      },
      metrics: { totalMs: 123 },
    });
    createImageGeneratorMock.mockReturnValue({
      mode: "openai-images",
      generator: { generate: generateMock },
    });

    const result = await executeGenerationFlow({
      userId: "user-1",
      reqId: "req-1",
      sourceImageUrl: "https://assets.example/inbound-source/old.jpg",
      lastPhotoUrl: "https://assets.example/inbound-source/new.jpg",
      lastPhotoSource: "stored",
    });

    expect(result).toMatchObject({
      kind: "success",
      resolvedSourceImageUrl: "https://assets.example/inbound-source/new.jpg",
      trustedSourceImageUrl: true,
    });
    expect(generateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceImageUrl: "https://assets.example/inbound-source/new.jpg",
      })
    );
  });

  it("does not silently fall back to a stale explicit source when the latest upload is invalid", async () => {
    const generateMock = vi.fn();
    createImageGeneratorMock.mockReturnValue({
      mode: "openai-images",
      generator: { generate: generateMock },
    });

    const result = await executeGenerationFlow({
      userId: "user-1",
      reqId: "req-1",
      sourceImageUrl: "https://assets.example/inbound-source/old.jpg",
      lastPhotoUrl: "not-a-valid-url",
      lastPhotoSource: "stored",
    });

    expect(result).toMatchObject({
      kind: "error",
      errorKind: "invalid_source_image",
      resolvedSourceImageUrl: "not-a-valid-url",
    });
    expect(generateMock).not.toHaveBeenCalled();
  });

  it("classifies mapped generator failures", async () => {
    const timeoutError = new GenerationTimeoutError("timeout");
    (timeoutError as Error & { generationMetrics?: unknown }).generationMetrics = {
      totalMs: 45,
    };

    createImageGeneratorMock.mockReturnValue({
      mode: "openai-images",
      generator: { generate: vi.fn().mockRejectedValue(timeoutError) },
    });

    const timeoutResult = await executeGenerationFlow({
      userId: "user-1",
      reqId: "req-1",
      lastPhotoUrl: "https://stored.example/photo.jpg",
      lastPhotoSource: "stored",
    });

    expect(timeoutResult).toMatchObject({
      kind: "error",
      errorKind: "generation_timeout",
      metrics: { totalMs: 45 },
    });

    createImageGeneratorMock.mockReturnValue({
      mode: "openai-images",
      generator: {
        generate: vi.fn().mockRejectedValue(new InvalidSourceImageUrlError("bad")),
      },
    });

    const invalidSourceResult = await executeGenerationFlow({
      userId: "user-1",
      reqId: "req-1",
      lastPhotoUrl: "https://stored.example/photo.jpg",
      lastPhotoSource: "stored",
    });

    expect(invalidSourceResult).toMatchObject({
      kind: "error",
      errorKind: "invalid_source_image",
    });

    createImageGeneratorMock.mockReturnValue({
      mode: "openai-images",
      generator: {
        generate: vi.fn().mockRejectedValue(new MissingInputImageError("missing")),
      },
    });

    const missingInputResult = await executeGenerationFlow({
      userId: "user-1",
      reqId: "req-1",
      lastPhotoUrl: "https://stored.example/photo.jpg",
      lastPhotoSource: "stored",
    });

    expect(missingInputResult).toMatchObject({
      kind: "error",
      errorKind: "missing_input_image",
    });

    createImageGeneratorMock.mockReturnValue({
      mode: "openai-images",
      generator: {
        generate: vi.fn().mockRejectedValue(new OpenAiBudgetExceededError("budget")),
      },
    });

    const budgetResult = await executeGenerationFlow({
      userId: "user-1",
      reqId: "req-1",
      lastPhotoUrl: "https://stored.example/photo.jpg",
      lastPhotoSource: "stored",
    });

    expect(budgetResult).toMatchObject({
      kind: "error",
      errorKind: "generation_budget_reached",
    });
  });

  it("rejects non-stored source image URLs before calling the generator", async () => {
    const generateMock = vi.fn();
    createImageGeneratorMock.mockReturnValue({
      mode: "openai-images",
      generator: { generate: generateMock },
    });

    const result = await executeGenerationFlow({
      userId: "user-1",
      reqId: "req-1",
      lastPhotoUrl: "https://example.com/photo.jpg",
      lastPhotoSource: "external",
    });

    expect(result).toMatchObject({
      kind: "error",
      errorKind: "invalid_source_image",
      resolvedSourceImageUrl: "https://example.com/photo.jpg",
      trustedSourceImageUrl: false,
    });
    expect(generateMock).not.toHaveBeenCalled();
  });
});

