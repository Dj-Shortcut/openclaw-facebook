import { createHash, createHmac } from "node:crypto";

import {
  getCreditCheckoutPilotConfig,
  isPaidMessengerCreditsEnabled,
  withCreditCheckoutHmacSecret,
  type CreditCheckoutPilotConfig,
} from "./creditCheckoutConfig";
import {
  deriveCreditWalletIdentity,
  type CreditCheckoutMessengerScope,
} from "./creditCheckoutIdentity";
import {
  readCreditGenerationReservation,
  readSpendableCreditWallet,
  type CreditGenerationReservationState,
  type SpendableCreditWallet,
} from "./creditGenerationAdmissionStore";
import {
  commitCreditReservation,
  createCreditReservationHold,
  markCreditReservationProviderAccepted,
  markCreditReservationTransportStarted,
  releaseCreditReservationAfterProviderRejection,
  releaseCreditReservation,
  type CreditWalletScope,
} from "./creditWalletStore";

const MAX_DATABASE_ID = 2_147_483_647;
const REQUEST_ID_MAX_LENGTH = 160;
const USER_KEY_PATTERN =
  /^(?:[0-9a-f]{64}|u2[.]k[1-9][0-9]{0,5}[.][0-9a-f]{64})$/;

export type PaidCreditGenerationInput = Readonly<{
  workspaceId: number;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  userKey: string;
  requestId: string;
}>;

export type PaidCreditGenerationReservation = Readonly<{
  reservationId: string;
  imageQuality: "medium";
  markTransportStarted: () => Promise<void>;
  commitProviderSuccess: () => Promise<void>;
  releaseProviderRejected: (status: number) => Promise<void>;
  releaseBeforeTransport: () => Promise<void>;
  toJSON: () => Readonly<{
    reservationId: string;
    imageQuality: "medium";
  }>;
}>;

export type PaidCreditGenerationDecision =
  | Readonly<{
      available: false;
      reason:
        | "disabled"
        | "outside_pilot"
        | "empty"
        | "request_in_progress"
        | "request_closed";
    }>
  | Readonly<{
      available: true;
      reservation: PaidCreditGenerationReservation;
    }>;

type ReservationMaterial = Readonly<{
  reservationId: string;
  generationRequestKeyHash: string;
  ownerTokenHash: string;
  holdEntryId: string;
  holdEvidenceHash: string;
  commitEntryId: string;
  commitEvidenceHash: string;
  releaseEntryId: string;
  releaseEvidenceHash: string;
  providerRejectedEntryId: string;
}>;

/**
 * Immutable proof needed to settle a provider response that was accepted
 * before the process could debit the held credit.
 */
export type CreditReservationCommitRecoveryInput = CreditWalletScope &
  Readonly<{
    reservationId: string;
    generationRequestKeyHash: string;
    ownerTokenHash: string;
  }>;

export type CreditReservationProviderRejectedRecoveryInput =
  CreditReservationCommitRecoveryInput &
    Readonly<{
      rejectionStatus: number;
    }>;

export type CreditGenerationAdmissionDependencies = Readonly<{
  enabled: () => boolean;
  config: () => CreditCheckoutPilotConfig;
  withSecret: typeof withCreditCheckoutHmacSecret;
  readWallet: (
    scope: CreditWalletScope
  ) => Promise<SpendableCreditWallet | null>;
  readReservation: (input: {
    scope: CreditWalletScope;
    reservationId: string;
    generationRequestKeyHash: string;
    ownerTokenHash: string;
    reservedCreditCount: 1;
  }) => Promise<CreditGenerationReservationState | null>;
  reserve: typeof createCreditReservationHold;
  markTransportStarted: typeof markCreditReservationTransportStarted;
  markProviderAccepted: typeof markCreditReservationProviderAccepted;
  commit: typeof commitCreditReservation;
  release: typeof releaseCreditReservation;
  releaseProviderRejected: typeof releaseCreditReservationAfterProviderRejection;
}>;

const defaultDependencies: CreditGenerationAdmissionDependencies =
  Object.freeze({
    enabled: isPaidMessengerCreditsEnabled,
    config: getCreditCheckoutPilotConfig,
    withSecret: withCreditCheckoutHmacSecret,
    readWallet: readSpendableCreditWallet,
    readReservation: readCreditGenerationReservation,
    reserve: createCreditReservationHold,
    markTransportStarted: markCreditReservationTransportStarted,
    markProviderAccepted: markCreditReservationProviderAccepted,
    commit: commitCreditReservation,
    release: releaseCreditReservation,
    releaseProviderRejected: releaseCreditReservationAfterProviderRejection,
  });

export class PaidCreditGenerationAdmissionError extends Error {
  constructor() {
    super("Paid credit generation admission is unavailable");
    this.name = "PaidCreditGenerationAdmissionError";
  }
}

function fail(): never {
  throw new PaidCreditGenerationAdmissionError();
}

function isDatabaseId(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_DATABASE_ID;
}

function assertInput(input: PaidCreditGenerationInput): void {
  if (
    !input ||
    typeof input !== "object" ||
    !isDatabaseId(input.workspaceId) ||
    !isDatabaseId(input.channelConnectionId) ||
    !isDatabaseId(input.bindingEpoch) ||
    !isDatabaseId(input.privacyEpoch) ||
    typeof input.userKey !== "string" ||
    !USER_KEY_PATTERN.test(input.userKey) ||
    typeof input.requestId !== "string" ||
    input.requestId.length < 1 ||
    input.requestId.length > REQUEST_ID_MAX_LENGTH
  ) {
    fail();
  }
}

function uuidV8FromDigest(digest: Buffer): string {
  const bytes = Buffer.from(digest.subarray(0, 16));
  try {
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
      12,
      16
    )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } finally {
    bytes.fill(0);
  }
}

function hmac(
  secret: Uint8Array,
  domain: string,
  fields: readonly string[]
): Buffer {
  const digest = createHmac("sha256", secret).update(domain, "utf8");
  for (const field of fields) {
    const bytes = Buffer.from(field, "utf8");
    const length = Buffer.alloc(4);
    try {
      length.writeUInt32BE(bytes.byteLength);
      digest.update(length).update(bytes);
    } finally {
      bytes.fill(0);
      length.fill(0);
    }
  }
  return digest.digest();
}

function evidenceHash(
  purpose: "hold" | "commit" | "release" | "provider_rejected",
  reservationId: string,
  requestHash: string,
  providerStatus?: number
): string {
  return createHash("sha256")
    .update("leaderbot.premium-credit-evidence.v1\0", "utf8")
    .update(purpose, "utf8")
    .update("\0", "utf8")
    .update(reservationId, "utf8")
    .update("\0", "utf8")
    .update(requestHash, "utf8")
    .update(providerStatus === undefined ? "" : `\0${providerStatus}`, "utf8")
    .digest("hex");
}

function deriveReservationMaterialFromRequestHash(
  secret: Uint8Array,
  scope: CreditWalletScope,
  requestHash: string
): ReservationMaterial {
  const fields = [
    String(scope.workspaceId),
    scope.mode,
    String(scope.channelConnectionId),
    String(scope.bindingEpoch),
    String(scope.privacyEpoch),
    scope.userKey,
    scope.walletId,
    scope.financialSubjectRef,
    requestHash,
  ];
  const reservationDigest = hmac(
    secret,
    "leaderbot.premium-credit-reservation-id.v1\0",
    fields
  );
  const ownerDigest = hmac(
    secret,
    "leaderbot.premium-credit-owner.v1\0",
    fields
  );
  const holdDigest = hmac(
    secret,
    "leaderbot.premium-credit-hold-entry.v1\0",
    fields
  );
  const commitDigest = hmac(
    secret,
    "leaderbot.premium-credit-commit-entry.v1\0",
    fields
  );
  const releaseDigest = hmac(
    secret,
    "leaderbot.premium-credit-release-entry.v1\0",
    fields
  );
  const providerRejectedDigest = hmac(
    secret,
    "leaderbot.premium-credit-provider-rejected-entry.v1\0",
    fields
  );
  try {
    const reservationId = uuidV8FromDigest(reservationDigest);
    return Object.freeze({
      reservationId,
      generationRequestKeyHash: requestHash,
      ownerTokenHash: ownerDigest.toString("hex"),
      holdEntryId: uuidV8FromDigest(holdDigest),
      holdEvidenceHash: evidenceHash("hold", reservationId, requestHash),
      commitEntryId: uuidV8FromDigest(commitDigest),
      commitEvidenceHash: evidenceHash("commit", reservationId, requestHash),
      releaseEntryId: uuidV8FromDigest(releaseDigest),
      releaseEvidenceHash: evidenceHash("release", reservationId, requestHash),
      providerRejectedEntryId: uuidV8FromDigest(providerRejectedDigest),
    });
  } finally {
    reservationDigest.fill(0);
    ownerDigest.fill(0);
    holdDigest.fill(0);
    commitDigest.fill(0);
    releaseDigest.fill(0);
    providerRejectedDigest.fill(0);
  }
}

function deriveReservationMaterial(
  secret: Uint8Array,
  scope: CreditWalletScope,
  requestId: string
): ReservationMaterial {
  const requestHash = createHash("sha256")
    .update("leaderbot.premium-credit-generation.v1\0", "utf8")
    .update(requestId, "utf8")
    .digest("hex");
  return deriveReservationMaterialFromRequestHash(secret, scope, requestHash);
}

/**
 * Rebuilds only the deterministic commit proof for a persisted, known-2xx
 * reservation. It returns null when the current secret no longer proves the
 * stored owner/reservation binding; callers must contain that case for review
 * rather than guessing whether a provider charge occurred.
 */
export function deriveCreditReservationCommitRecovery(
  input: CreditReservationCommitRecoveryInput,
  dependencies: Pick<
    CreditGenerationAdmissionDependencies,
    "withSecret"
  > = defaultDependencies
): Readonly<{ entryId: string; evidenceHash: string }> | null {
  if (
    !isDatabaseId(input.workspaceId) ||
    !isDatabaseId(input.channelConnectionId) ||
    !isDatabaseId(input.bindingEpoch) ||
    !isDatabaseId(input.privacyEpoch) ||
    !USER_KEY_PATTERN.test(input.userKey)
  ) {
    fail();
  }
  if (input.mode !== "test" && input.mode !== "live") fail();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      input.walletId
    ) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      input.reservationId
    )
  ) {
    fail();
  }
  if (
    !/^[0-9a-f]{64}$/.test(input.financialSubjectRef) ||
    !/^[0-9a-f]{64}$/.test(input.generationRequestKeyHash) ||
    !/^[0-9a-f]{64}$/.test(input.ownerTokenHash)
  ) {
    fail();
  }
  return dependencies.withSecret(secret => {
    const material = deriveReservationMaterialFromRequestHash(
      secret,
      {
        workspaceId: input.workspaceId,
        mode: input.mode,
        channelConnectionId: input.channelConnectionId,
        bindingEpoch: input.bindingEpoch,
        privacyEpoch: input.privacyEpoch,
        userKey: input.userKey,
        walletId: input.walletId,
        financialSubjectRef: input.financialSubjectRef,
      },
      input.generationRequestKeyHash
    );
    if (
      material.reservationId !== input.reservationId ||
      material.ownerTokenHash !== input.ownerTokenHash
    ) {
      return null;
    }
    return Object.freeze({
      entryId: material.commitEntryId,
      evidenceHash: material.commitEvidenceHash,
    });
  });
}

/**
 * Rebuilds the deterministic terminal proof for an operator-confirmed,
 * non-retryable provider rejection. The same persisted request/owner binding
 * used by the live path must still verify; otherwise the hold remains for
 * review. Retryable or ambiguous HTTP outcomes are deliberately rejected.
 */
export function deriveCreditReservationProviderRejectedRecovery(
  input: CreditReservationProviderRejectedRecoveryInput,
  dependencies: Pick<
    CreditGenerationAdmissionDependencies,
    "withSecret"
  > = defaultDependencies
): Readonly<{ entryId: string; evidenceHash: string }> | null {
  if (
    !Number.isSafeInteger(input.rejectionStatus) ||
    input.rejectionStatus < 400 ||
    input.rejectionStatus > 499 ||
    input.rejectionStatus === 408 ||
    input.rejectionStatus === 429
  ) {
    fail();
  }
  const commitProof = deriveCreditReservationCommitRecovery(
    input,
    dependencies
  );
  if (!commitProof) return null;
  return dependencies.withSecret(secret => {
    const material = deriveReservationMaterialFromRequestHash(
      secret,
      input,
      input.generationRequestKeyHash
    );
    return Object.freeze({
      entryId: material.providerRejectedEntryId,
      evidenceHash: evidenceHash(
        "provider_rejected",
        input.reservationId,
        input.generationRequestKeyHash,
        input.rejectionStatus
      ),
    });
  });
}

function exactScope(
  input: PaidCreditGenerationInput,
  config: CreditCheckoutPilotConfig,
  dedicatedSecret: Uint8Array
): CreditWalletScope {
  const messengerScope: CreditCheckoutMessengerScope = {
    workspaceId: input.workspaceId,
    mode: config.mode,
    channel: "facebook_messenger",
    channelConnectionId: input.channelConnectionId,
    bindingEpoch: input.bindingEpoch,
    privacyEpoch: input.privacyEpoch,
    userKey: input.userKey,
  };
  const identity = deriveCreditWalletIdentity({
    dedicatedSecret,
    scope: messengerScope,
  });
  return Object.freeze({
    workspaceId: input.workspaceId,
    mode: config.mode,
    channelConnectionId: input.channelConnectionId,
    bindingEpoch: input.bindingEpoch,
    privacyEpoch: input.privacyEpoch,
    userKey: input.userKey,
    walletId: identity.walletId,
    financialSubjectRef: identity.financialSubjectRef,
  });
}

export async function reservePaidCreditGeneration(
  input: PaidCreditGenerationInput,
  dependencies: CreditGenerationAdmissionDependencies = defaultDependencies
): Promise<PaidCreditGenerationDecision> {
  assertInput(input);
  if (!dependencies.enabled()) {
    return { available: false, reason: "disabled" };
  }
  const config = dependencies.config();
  if (config.workspaceId === null || config.workspaceId !== input.workspaceId) {
    return { available: false, reason: "outside_pilot" };
  }

  const derived = dependencies.withSecret(secret => {
    const scope = exactScope(input, config, secret);
    return Object.freeze({
      scope,
      material: deriveReservationMaterial(secret, scope, input.requestId),
    });
  });
  const wallet = await dependencies.readWallet(derived.scope);
  if (!wallet) {
    return { available: false, reason: "empty" };
  }
  const existing = await dependencies.readReservation({
    scope: derived.scope,
    reservationId: derived.material.reservationId,
    generationRequestKeyHash: derived.material.generationRequestKeyHash,
    ownerTokenHash: derived.material.ownerTokenHash,
    reservedCreditCount: 1,
  });
  if (
    existing?.status === "committed" ||
    existing?.status === "released" ||
    existing?.status === "expired"
  ) {
    return { available: false, reason: "request_closed" };
  }
  // A deterministic replay must never receive a second live reservation
  // handle. Otherwise one worker could release the shared hold while another
  // worker is already crossing the provider boundary.
  if (existing !== null) {
    return { available: false, reason: "request_in_progress" };
  }
  if (
    !Number.isSafeInteger(wallet.creditBalance) ||
    !Number.isSafeInteger(wallet.reservedCredits) ||
    wallet.creditBalance - wallet.reservedCredits < 1
  ) {
    return { available: false, reason: "empty" };
  }

  const hold = await dependencies.reserve({
    ...derived.scope,
    reservationId: derived.material.reservationId,
    generationRequestKeyHash: derived.material.generationRequestKeyHash,
    ownerTokenHash: derived.material.ownerTokenHash,
    reservedCreditCount: 1,
    entryId: derived.material.holdEntryId,
    evidenceHash: derived.material.holdEvidenceHash,
  });
  if (hold.result !== "applied") {
    return { available: false, reason: "request_in_progress" };
  }

  let state:
    | "open"
    | "transport_started"
    | "provider_accepted"
    | "committed"
    | "provider_rejected"
    | "released" = "open";
  const jsonView = Object.freeze({
    reservationId: derived.material.reservationId,
    imageQuality: "medium" as const,
  });
  const reservation: PaidCreditGenerationReservation = Object.freeze({
    reservationId: derived.material.reservationId,
    imageQuality: "medium" as const,
    markTransportStarted: async () => {
      if (
        state === "transport_started" ||
        state === "provider_accepted" ||
        state === "committed"
      ) {
        return;
      }
      if (state !== "open") fail();
      await dependencies.markTransportStarted({
        ...derived.scope,
        reservationId: derived.material.reservationId,
        ownerTokenHash: derived.material.ownerTokenHash,
      });
      state = "transport_started";
    },
    commitProviderSuccess: async () => {
      if (state === "committed") return;
      if (state !== "transport_started" && state !== "provider_accepted") {
        fail();
      }
      if (state === "transport_started") {
        await dependencies.markProviderAccepted({
          ...derived.scope,
          reservationId: derived.material.reservationId,
          ownerTokenHash: derived.material.ownerTokenHash,
        });
        state = "provider_accepted";
      }
      await dependencies.commit({
        ...derived.scope,
        reservationId: derived.material.reservationId,
        ownerTokenHash: derived.material.ownerTokenHash,
        entryId: derived.material.commitEntryId,
        evidenceHash: derived.material.commitEvidenceHash,
      });
      state = "committed";
    },
    releaseProviderRejected: async status => {
      if (
        !Number.isSafeInteger(status) ||
        status < 400 ||
        status > 499 ||
        status === 408 ||
        status === 429
      ) {
        fail();
      }
      if (state === "released" || state === "provider_rejected") return;
      if (state !== "transport_started") fail();
      await dependencies.releaseProviderRejected({
        ...derived.scope,
        reservationId: derived.material.reservationId,
        ownerTokenHash: derived.material.ownerTokenHash,
        rejectionStatus: status,
        entryId: derived.material.providerRejectedEntryId,
        evidenceHash: evidenceHash(
          "provider_rejected",
          derived.material.reservationId,
          derived.material.generationRequestKeyHash,
          status
        ),
      });
      state = "provider_rejected";
    },
    releaseBeforeTransport: async () => {
      if (state === "released") return;
      if (state !== "open") return;
      await dependencies.release({
        ...derived.scope,
        reservationId: derived.material.reservationId,
        ownerTokenHash: derived.material.ownerTokenHash,
        entryId: derived.material.releaseEntryId,
        evidenceHash: derived.material.releaseEvidenceHash,
      });
      state = "released";
    },
    toJSON: () => jsonView,
  });
  return { available: true, reservation };
}
