import { describe, expect, it, vi } from "vitest";
import { emitGenerationDiagnostic } from "./_core/generationDiagnostics";

describe("generation diagnostics", () => {
  it("emits compact redacted generation logs", () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);

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

      expect(infoSpy).toHaveBeenCalledTimes(1);
      const payload = JSON.parse(String(infoSpy.mock.calls[0][0])) as {
        msg: string;
        sender_id_hash: string;
        durations_ms: Record<string, number>;
      };

      expect(payload.msg).toBe("messenger_generation_diagnostic");
      expect(payload.sender_id_hash).toMatch(/^[a-f0-9]{12}$/);
      expect(JSON.stringify(payload)).not.toContain("psid-sensitive");
      expect(payload.durations_ms).toEqual({
        source_image_downloaded: 12,
        provider_request: 34,
      });
    } finally {
      infoSpy.mockRestore();
    }
  });
});
