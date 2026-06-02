import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emitGenerationDiagnostic, hashSenderId } from "./_core/generationDiagnostics";
import { toUserKey } from "./_core/privacy";

describe("generation diagnostics", () => {
  const originalPrivacyPepper = process.env.PRIVACY_PEPPER;

  beforeEach(() => {
    process.env.PRIVACY_PEPPER = "diagnostics-test-pepper";
  });

  afterEach(() => {
    if (originalPrivacyPepper === undefined) {
      delete process.env.PRIVACY_PEPPER;
    } else {
      process.env.PRIVACY_PEPPER = originalPrivacyPepper;
    }
  });

  it("emits compact redacted generation logs", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    try {
      emitGenerationDiagnostic({
        generationId: "gen-123",
        senderId: "psid-sensitive",
        style: "gold",
        success: false,
        failureReason: "generation_timeout",
        durationsMs: {
          source_image_downloaded: 12,
          provider_request: 34,
          empty: undefined,
        },
      });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String(logSpy.mock.calls[0][0])) as {
        event: string;
        sender_id_hash: string;
        durations_ms: Record<string, number>;
      };

      expect(payload.event).toBe("messenger_generation_diagnostic");
      expect(payload.sender_id_hash).toMatch(/^[a-f0-9]{12}$/);
      expect(payload.sender_id_hash).toBe(toUserKey("psid-sensitive").slice(0, 12));
      expect(JSON.stringify(payload)).not.toContain("psid-sensitive");
      expect(payload.durations_ms).toEqual({
        source_image_downloaded: 12,
        provider_request: 34,
      });
    } finally {
      logSpy.mockRestore();
    }
  });

  it("hashes sender ids through the peppered user key", () => {
    const first = hashSenderId("psid-sensitive");

    process.env.PRIVACY_PEPPER = "rotated-diagnostics-test-pepper";

    expect(hashSenderId("psid-sensitive")).not.toBe(first);
  });
});
