import { createHash } from "node:crypto";

import { safeLog } from "../logger";
import type { MollieMode } from "./config";
import {
  enqueueCreditReservationTransportReview,
  listDueCreditReservationResolutions,
  listExpiredPristineCreditCheckouts,
  listExpiredCreditReservations,
  listTerminalCreditReservationsForScrub,
  type ExpiredCreditReservation,
} from "./creditReservationExpiryStore";
import {
  expirePristineCreditCheckout,
  expireCreditReservation,
  scrubTerminalCreditReservation,
} from "./creditWalletStore";

const POLL_INTERVAL_MS = 60_000;
let timer: NodeJS.Timeout | null = null;
let running = false;

export type CreditReservationExpiryDependencies = Readonly<{
  modes: () => readonly MollieMode[];
  list: typeof listExpiredCreditReservations;
  listDue: typeof listDueCreditReservationResolutions;
  listPristineCheckouts: typeof listExpiredPristineCreditCheckouts;
  listTerminalForScrub: typeof listTerminalCreditReservationsForScrub;
  expire: typeof expireCreditReservation;
  expirePristineCheckout: typeof expirePristineCreditCheckout;
  scrubTerminal: typeof scrubTerminalCreditReservation;
  review: typeof enqueueCreditReservationTransportReview;
}>;

const defaultDependencies: CreditReservationExpiryDependencies = Object.freeze({
  // Historical holds retain their immutable payment mode. Scanning only the
  // currently configured provider mode would strand Test Mode holds after a
  // later live cutover and could block privacy erasure indefinitely.
  modes: () => ["test", "live"] as const,
  list: listExpiredCreditReservations,
  listDue: listDueCreditReservationResolutions,
  listPristineCheckouts: listExpiredPristineCreditCheckouts,
  listTerminalForScrub: listTerminalCreditReservationsForScrub,
  expire: expireCreditReservation,
  expirePristineCheckout: expirePristineCreditCheckout,
  scrubTerminal: scrubTerminalCreditReservation,
  review: enqueueCreditReservationTransportReview,
});

export async function runCreditReservationExpiryOnce(
  limit = 25,
  now = new Date(),
  dependencies: CreditReservationExpiryDependencies = defaultDependencies
): Promise<number> {
  let resolved = 0;
  const modes = [...new Set(dependencies.modes())];
  if (
    modes.length !== 2 ||
    !modes.includes("test") ||
    !modes.includes("live")
  ) {
    throw new Error("credit reservation expiry modes are incomplete");
  }
  for (const mode of modes) {
    const rows = await dependencies.list(mode, now, limit);
    for (const row of rows) {
      const terminal = deriveExpiryEvidence(row);
      await dependencies.expire({
        workspaceId: row.workspaceId,
        mode: row.mode,
        channelConnectionId: row.channelConnectionId,
        bindingEpoch: row.bindingEpoch,
        privacyEpoch: row.privacyEpoch,
        userKey: row.userKey,
        walletId: row.walletId,
        financialSubjectRef: row.financialSubjectRef,
        reservationId: row.reservationId,
        ownerTokenHash: row.ownerTokenHash,
        entryId: terminal.entryId,
        evidenceHash: terminal.evidenceHash,
      });
      resolved += 1;
    }

    const dueRows = await dependencies.listDue(mode, now, limit);
    for (const row of dueRows) {
      // Provider acceptance prevents an unsafe transport retry, but does not
      // prove that a usable image was parsed, published, and delivered. Keep
      // every unresolved transport held for the durable manual-review plane.
      await dependencies.review(row);
      resolved += 1;
    }

    const pristineCheckouts = await dependencies.listPristineCheckouts(
      mode,
      now,
      limit
    );
    for (const checkout of pristineCheckouts) {
      const outcome = await dependencies.expirePristineCheckout(checkout);
      if (outcome.result === "applied") resolved += 1;
    }

    const terminalRows = await dependencies.listTerminalForScrub(
      mode,
      now,
      limit
    );
    for (const row of terminalRows) {
      const outcome = await dependencies.scrubTerminal(row);
      if (outcome.result === "applied") resolved += 1;
    }
  }
  return resolved;
}

export function startCreditReservationExpiryWorker(): void {
  if (timer) return;
  timer = setInterval(() => void runSafely(), POLL_INTERVAL_MS);
  timer.unref();
  void runSafely();
}

async function runSafely(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const expired = await runCreditReservationExpiryOnce();
    if (expired > 0) {
      safeLog("credit_reservation_expiry_completed", { count: expired });
    }
  } catch (error) {
    safeLog("credit_reservation_expiry_failed", {
      level: "error",
      errorCode: error instanceof Error ? error.name : "UnknownError",
    });
  } finally {
    running = false;
  }
}

function deriveExpiryEvidence(row: ExpiredCreditReservation): Readonly<{
  entryId: string;
  evidenceHash: string;
}> {
  const canonical = [
    "leaderbot.premium-credit-expiry.v1",
    String(row.workspaceId),
    row.mode,
    String(row.channelConnectionId),
    String(row.bindingEpoch),
    String(row.privacyEpoch),
    row.walletId,
    row.financialSubjectRef,
    row.reservationId,
    row.ownerTokenHash,
  ].join("\n");
  const entryDigest = createHash("sha256")
    .update("leaderbot.premium-credit-expiry-entry.v1\0", "utf8")
    .update(canonical, "utf8")
    .digest();
  const bytes = Buffer.from(entryDigest.subarray(0, 16));
  try {
    bytes[6] = (bytes[6] & 0x0f) | 0x80;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = bytes.toString("hex");
    const entryId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
      12,
      16
    )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    const evidenceHash = createHash("sha256")
      .update("leaderbot.premium-credit-expiry-evidence.v1\0", "utf8")
      .update(canonical, "utf8")
      .digest("hex");
    return Object.freeze({ entryId, evidenceHash });
  } finally {
    bytes.fill(0);
    entryDigest.fill(0);
  }
}
