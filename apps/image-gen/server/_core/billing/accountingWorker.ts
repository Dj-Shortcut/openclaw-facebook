import { safeLog } from "../logger";
import {
  importMollieAccountingEvents,
  reconcileMollieAccountingQuarantine,
} from "./accountingImporter";
import { MollieBalanceAccountingReader } from "./mollieAccountingReader";
import type { MollieMode } from "./config";

const ACCOUNTING_INTERVAL_MS = 5 * 60_000;

export function isMollieAccountingImportEnabled(): boolean {
  return process.env.MOLLIE_ACCOUNTING_IMPORT_ENABLED === "true";
}

export function getMollieAccountingImportConfig(): Readonly<{
  providerAccountId: string;
  balanceId: string;
  accessToken: string;
  mode: MollieMode;
}> {
  const providerAccountId =
    process.env.MOLLIE_ACCOUNTING_PROVIDER_ACCOUNT_ID?.trim() ?? "";
  const accessToken = process.env.MOLLIE_ACCOUNTING_ACCESS_TOKEN?.trim() ?? "";
  const balanceId = process.env.MOLLIE_ACCOUNTING_BALANCE_ID?.trim() ?? "";
  const mode = process.env.MOLLIE_MODE?.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{7,95}$/.test(providerAccountId)) {
    throw new Error("MOLLIE_ACCOUNTING_PROVIDER_ACCOUNT_ID is invalid");
  }
  if (!/^access_[A-Za-z0-9]{20,}$/.test(accessToken)) {
    throw new Error("MOLLIE_ACCOUNTING_ACCESS_TOKEN is invalid");
  }
  if (!/^bal_[A-Za-z0-9]{8,61}$/.test(balanceId)) {
    throw new Error("MOLLIE_ACCOUNTING_BALANCE_ID is invalid");
  }
  if (mode !== "test" && mode !== "live") {
    throw new Error("MOLLIE_MODE must be test or live");
  }
  return Object.freeze({ providerAccountId, balanceId, accessToken, mode });
}

export async function runMollieAccountingImportWorkerOnce(): Promise<void> {
  const config = getMollieAccountingImportConfig();
  const result = await importMollieAccountingEvents({
    providerAccountId: config.providerAccountId,
    mode: config.mode,
    reader: new MollieBalanceAccountingReader(
      config.accessToken,
      fetch,
      "https://api.mollie.com",
      undefined,
      config.balanceId
    ),
  });
  const relinked = await reconcileMollieAccountingQuarantine({
    providerAccountId: config.providerAccountId,
    mode: config.mode,
    limit: 250,
  });
  safeLog("mollie_accounting_import_completed", {
    runId: result.runId,
    imported: result.imported,
    quarantined: result.quarantined,
    relinked,
    mode: config.mode,
  });
}

export function startMollieAccountingImportWorker(): void {
  if (!isMollieAccountingImportEnabled()) return;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await runMollieAccountingImportWorkerOnce();
    } catch (error) {
      safeLog("mollie_accounting_import_failed", {
        level: "error",
        errorCode:
          error instanceof Error ? error.constructor.name : "UnknownError",
      });
    } finally {
      running = false;
    }
  };
  void run();
  const timer = setInterval(() => void run(), ACCOUNTING_INTERVAL_MS);
  timer.unref();
}
