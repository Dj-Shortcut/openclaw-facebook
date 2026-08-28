import { createHash } from "node:crypto";

import { safeLog } from "../logger";
import { getConfiguredBillingMode } from "./config";
import {
  listExpiredCreditReservations,
  type ExpiredCreditReservation,
} from "./creditReservationExpiryStore";
import { expireCreditReservation } from "./creditWalletStore";

const POLL_INTERVAL_MS = 60_000;
let timer: NodeJS.Timeout | null = null;
let running = false;

type Dependencies = Readonly<{
  mode: typeof getConfiguredBillingMode;
  list: typeof listExpiredCreditReservations;
  expire: typeof expireCreditReservation;
}>;

const defaultDependencies: Dependencies = Object.freeze({
  mode: getConfiguredBillingMode,
  list: listExpiredCreditReservations,
  expire: expireCreditReservation,
});

export async function runCreditReservationExpiryOnce(
  limit = 25,
  now = new Date(),
  dependencies: Dependencies = defaultDependencies
): Promise<number> {
  const rows = await dependencies.list(dependencies.mode(), now, limit);
  let expired = 0;
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
    expired += 1;
  }
  return expired;
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
