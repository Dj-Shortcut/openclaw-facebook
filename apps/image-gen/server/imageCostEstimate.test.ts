import { afterEach, describe, expect, it } from "vitest";

import {
  estimateOpenAiImageRequestCost,
  readOpenAiImageCostOptionsFromRequestBody,
} from "./_core/image-generation/imageCostEstimate";

describe("image cost estimates", () => {
  const originalEnv = {
    OPENAI_IMAGE_ESTIMATED_COST_USD: process.env.OPENAI_IMAGE_ESTIMATED_COST_USD,
    OPENAI_IMAGE_QUALITY: process.env.OPENAI_IMAGE_QUALITY,
    OPENAI_IMAGE_SIZE: process.env.OPENAI_IMAGE_SIZE,
  };

  afterEach(() => {
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  it("uses an explicit per-image estimate override for validation runs", () => {
    process.env.OPENAI_IMAGE_ESTIMATED_COST_USD = "0.019";
    process.env.OPENAI_IMAGE_SIZE = "1024x1536";
    process.env.OPENAI_IMAGE_QUALITY = "medium";

    expect(
      estimateOpenAiImageRequestCost({
        model: "gpt-5",
        size: "1024x1536",
        quality: "medium",
      })
    ).toEqual({
      model: "gpt-5",
      pricingModel: "gpt-image-1",
      size: "1024x1536",
      quality: "medium",
      estimatedCostUsd: 0.019,
      costEstimateComplete: true,
      estimateSource: "env_override",
    });
  });

  it("prices image-generation tool output separately from the Responses model", () => {
    expect(
      estimateOpenAiImageRequestCost({
        model: "gpt-5",
        pricingModel: "gpt-image-1",
        size: "1024x1024",
        quality: "low",
      })
    ).toEqual({
      model: "gpt-5",
      pricingModel: "gpt-image-1",
      size: "1024x1024",
      quality: "low",
      estimatedCostUsd: 0.011,
      costEstimateComplete: true,
      estimateSource: "gpt_image_1_table",
    });
  });

  it("reads normalized image-generation tool options from the request body", () => {
    expect(
      readOpenAiImageCostOptionsFromRequestBody({
        tools: [
          {
            type: "image_generation",
            size: "1024x1536",
            quality: "medium",
            input_fidelity: "high",
          },
        ],
      })
    ).toEqual({
      size: "1024x1536",
      quality: "medium",
      inputFidelity: "high",
    });
  });

  it("marks source-image edits as partial when input charges are not priced", () => {
    expect(
      estimateOpenAiImageRequestCost({
        model: "gpt-5",
        size: "1024x1024",
        quality: "medium",
        inputFidelity: "high",
        hasSourceImage: true,
      })
    ).toEqual({
      model: "gpt-5",
      pricingModel: "gpt-image-1",
      size: "1024x1024",
      quality: "medium",
      inputFidelity: "high",
      estimatedCostUsd: undefined,
      estimatedOutputCostUsd: 0.042,
      costEstimateComplete: false,
      unpricedCostComponents: ["source_image_input"],
      estimateSource: "partial_source_image_input_unpriced",
    });
  });

  it("marks unpriced model and auto quality combinations explicitly", () => {
    delete process.env.OPENAI_IMAGE_ESTIMATED_COST_USD;
    delete process.env.OPENAI_IMAGE_SIZE;
    delete process.env.OPENAI_IMAGE_QUALITY;

    expect(
      estimateOpenAiImageRequestCost({
        model: "gpt-5",
        size: "1024x1024",
        quality: "auto",
      })
    ).toEqual({
      model: "gpt-5",
      pricingModel: "gpt-image-1",
      size: "1024x1024",
      quality: "auto",
      estimatedCostUsd: undefined,
      costEstimateComplete: false,
      unpricedCostComponents: ["output_image"],
      estimateSource: "unpriced",
    });
  });
});
