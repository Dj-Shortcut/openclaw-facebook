import { afterEach, describe, expect, it } from "vitest";
import {
  buildOpenAiImageGenerationPayload,
  buildOpenAiRequest,
} from "./_core/image-generation/openAiImageClient";

const originalModel = process.env.OPENAI_IMAGE_MODEL;
const originalQuality = process.env.OPENAI_IMAGE_QUALITY;

afterEach(() => {
  if (originalModel === undefined) delete process.env.OPENAI_IMAGE_MODEL;
  else process.env.OPENAI_IMAGE_MODEL = originalModel;
  if (originalQuality === undefined) delete process.env.OPENAI_IMAGE_QUALITY;
  else process.env.OPENAI_IMAGE_QUALITY = originalQuality;
});

describe("workspace-bound Images 2.0 request config", () => {
  it("overrides global model and quality for a paid request only", () => {
    process.env.OPENAI_IMAGE_MODEL = "global-free-model";
    process.env.OPENAI_IMAGE_QUALITY = "low";

    const paid = buildOpenAiRequest({
      prompt: "paid prompt",
      sourceImage: { buffer: Buffer.alloc(0), contentType: "image/png" },
      hasSourceImage: false,
      model: "gpt-image-2",
      quality: "high",
    });
    const free = buildOpenAiRequest({
      prompt: "free prompt",
      sourceImage: { buffer: Buffer.alloc(0), contentType: "image/png" },
      hasSourceImage: false,
    });

    const paidBody = JSON.parse(String(paid.requestInit.body));
    const freeBody = JSON.parse(String(free.requestInit.body));
    expect(paidBody.model).toBe("gpt-image-2");
    expect(paid.endpoint.toString()).toBe(
      "https://api.openai.com/v1/images/generations"
    );
    expect(paidBody.quality).toBe("high");
    expect(freeBody.model).toBe("global-free-model");
    expect(free.endpoint.toString()).toBe(
      "https://api.openai.com/v1/responses"
    );
    expect(freeBody.tools[0].quality).toBe("low");
  });

  it("allows the paid quality override without mutating environment config", () => {
    process.env.OPENAI_IMAGE_QUALITY = "medium";
    const payload = buildOpenAiImageGenerationPayload({
      model: "gpt-image-2",
      prompt: "test",
      quality: "high",
    });

    expect((payload.tools as Array<Record<string, unknown>>)[0].quality).toBe(
      "high"
    );
    expect(process.env.OPENAI_IMAGE_QUALITY).toBe("medium");
  });
});
