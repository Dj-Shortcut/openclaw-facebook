import { beforeEach, describe, expect, it, vi } from "vitest";

const { prepareSourceImageMock, safeLogMock } = vi.hoisted(() => ({
  prepareSourceImageMock: vi.fn(),
  safeLogMock: vi.fn(),
}));

vi.mock("./_core/image-generation/sourceImageFetcher", () => ({
  prepareSourceImage: prepareSourceImageMock,
}));

vi.mock("./_core/logger", () => ({
  safeLog: safeLogMock,
}));

import { prepareGenerationInput } from "./_core/image-generation/generationInputPreparer";
import {
  buildSourceImageEditPrompt,
  buildTextToImagePrompt,
} from "./_core/image-generation/promptBuilder";
import type { SourceImageFetchConfig } from "./_core/image-generation/sourceImageFetchConfig";

describe("generation input preparer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("selects the text-to-image prompt and returns the prepared input", async () => {
    const input = {
      generationKind: "text_to_image" as const,
      promptHint: "Een draak boven Antwerpen",
      reqId: "req-text-input",
    };
    const fetchConfig: SourceImageFetchConfig = {
      allowedHosts: ["unused.example.test"],
      retryLimit: 0,
      timeoutMs: 1_234,
    };
    const sourceImage = {
      buffer: Buffer.alloc(0),
      contentType: "image/jpeg",
      incomingLen: 0,
      incomingSha256: "empty",
      fbImageFetchMs: 0,
    };
    prepareSourceImageMock.mockResolvedValue(sourceImage);

    const result = await prepareGenerationInput(input, fetchConfig);

    expect(prepareSourceImageMock).toHaveBeenCalledWith(input, fetchConfig);
    expect(result).toMatchObject({
      hasSourceImage: false,
      prompt: buildTextToImagePrompt(input.promptHint),
      sourceImage,
    });
    expect(result.promptBuildMs).toBeGreaterThanOrEqual(0);
  });

  it("selects the source-edit prompt and forwards typed fetch config", async () => {
    const input = {
      generationKind: "source_image_edit" as const,
      sourceImageUrl: "https://assets.example.test/source.jpg",
      trustedSourceImageUrl: true,
      sourceImageProvenance: "storeInbound" as const,
      promptHint: "Maak de jas blauw",
      reqId: "req-edit-input",
    };
    const fetchConfig: SourceImageFetchConfig = {
      allowedHosts: ["assets.example.test"],
      retryLimit: 2,
      timeoutMs: 2_345,
    };
    const sourceImage = {
      buffer: Buffer.alloc(7_000, 7),
      contentType: "image/jpeg",
      incomingLen: 7_000,
      incomingSha256: "source-hash",
      fbImageFetchMs: 12,
    };
    prepareSourceImageMock.mockResolvedValue(sourceImage);

    const result = await prepareGenerationInput(input, fetchConfig);

    expect(prepareSourceImageMock).toHaveBeenCalledWith(input, fetchConfig);
    expect(result).toMatchObject({
      hasSourceImage: true,
      prompt: buildSourceImageEditPrompt(input.promptHint),
      sourceImage,
    });
    expect(result.promptBuildMs).toBeGreaterThanOrEqual(0);
  });
});
