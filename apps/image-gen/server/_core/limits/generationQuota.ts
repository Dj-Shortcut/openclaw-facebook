import {
  canGenerate,
  commitImageGenerationSuccess,
  increment,
  MessengerQuotaReservationCommitError,
  releaseImageGenerationReservation,
  reserveImageGenerationForAttempt,
  type ImageGenerationQuotaReservation,
} from "../messengerQuota";

export type ImageGenerationQuotaChannel = "messenger" | "whatsapp";

export type ImageGenerationQuotaInput = {
  channel: ImageGenerationQuotaChannel;
  senderId: string;
};

export { MessengerQuotaReservationCommitError };
export type { ImageGenerationQuotaReservation };

function quotaIdentity(input: ImageGenerationQuotaInput): string {
  return input.senderId;
}

export async function canUseImageGeneration(
  input: ImageGenerationQuotaInput
): Promise<boolean> {
  return canGenerate(quotaIdentity(input));
}

export async function reserveImageGenerationUsage(
  input: ImageGenerationQuotaInput
): Promise<ImageGenerationQuotaReservation | null> {
  return reserveImageGenerationForAttempt(quotaIdentity(input));
}

export async function commitImageGenerationUsage(
  input: ImageGenerationQuotaInput & {
    reservation?: ImageGenerationQuotaReservation;
  }
): Promise<boolean> {
  if (input.reservation) {
    return commitImageGenerationSuccess(
      quotaIdentity(input),
      input.reservation
    );
  }

  await increment(quotaIdentity(input));
  return true;
}

export async function releaseImageGenerationUsage(
  input: ImageGenerationQuotaInput & {
    reservation: ImageGenerationQuotaReservation;
  }
): Promise<void> {
  await releaseImageGenerationReservation(
    quotaIdentity(input),
    input.reservation
  );
}
