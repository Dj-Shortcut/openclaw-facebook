import { afterEach, describe, expect, it } from "vitest";
import { storageKeyFromPublicUrl } from "./storage";

describe("storageKeyFromPublicUrl", () => {
  const originalPublicBaseUrl = process.env.PUBLIC_BASE_URL;

  afterEach(() => {
    if (originalPublicBaseUrl === undefined) {
      delete process.env.PUBLIC_BASE_URL;
    } else {
      process.env.PUBLIC_BASE_URL = originalPublicBaseUrl;
    }
  });

  it("extracts object keys from bare public URLs", () => {
    delete process.env.PUBLIC_BASE_URL;

    expect(
      storageKeyFromPublicUrl(
        "https://assets.example/inbound-source/photo.jpg?signature=abc"
      )
    ).toBe("inbound-source/photo.jpg");
  });

  it("strips the configured public base path prefix", () => {
    process.env.PUBLIC_BASE_URL = "https://cdn.example/assets";

    expect(
      storageKeyFromPublicUrl(
        "https://cdn.example/assets/inbound-source/photo.jpg?signature=abc"
      )
    ).toBe("inbound-source/photo.jpg");
  });
});
