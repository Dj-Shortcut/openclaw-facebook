import { toUserKey } from "./privacy";

type GenerationDiagnosticInput = {
  generationId: string;
  senderId: string;
  style: string;
  success: boolean;
  failureReason?: string;
  durationsMs: Record<string, number | undefined>;
};

function compactDurations(
  durationsMs: Record<string, number | undefined>
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(durationsMs).filter(
      ([, value]) => typeof value === "number" && Number.isFinite(value)
    ) as Array<[string, number]>
  );
}

export function hashSenderId(senderId: string): string {
  return toUserKey(senderId).slice(0, 12);
}

export function emitGenerationDiagnostic(input: GenerationDiagnosticInput): void {
  console.info(
    JSON.stringify({
      level: "info",
      msg: "messenger_generation_diagnostic",
      generation_id: input.generationId,
      sender_id_hash: hashSenderId(input.senderId),
      style: input.style,
      success: input.success,
      failure_reason: input.failureReason,
      durations_ms: compactDurations(input.durationsMs),
    })
  );
}
