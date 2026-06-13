import {
  canGenerate,
  commitImageGenerationSuccess,
  releaseImageGenerationReservation,
  reserveImageGenerationForAttempt,
  type ImageGenerationQuotaReservation,
} from "../messengerQuota";

export type GenerationQuotaSubject = {
  channel: "messenger" | "whatsapp";
  senderId: string;
  workspaceId?: string;
};

export type GenerationQuotaReservation = ImageGenerationQuotaReservation;

export async function canUseImageGeneration(
  subject: GenerationQuotaSubject
): Promise<boolean> {
  return canGenerate(subject.senderId);
}

export async function reserveImageGeneration(
  subject: GenerationQuotaSubject
): Promise<GenerationQuotaReservation | null> {
  return reserveImageGenerationForAttempt(subject.senderId);
}

export async function commitImageGeneration(
  subject: GenerationQuotaSubject,
  reservation: GenerationQuotaReservation
): Promise<boolean> {
  return commitImageGenerationSuccess(subject.senderId, reservation);
}

export async function releaseImageGeneration(
  subject: GenerationQuotaSubject,
  reservation: GenerationQuotaReservation
): Promise<void> {
  await releaseImageGenerationReservation(subject.senderId, reservation);
}
