import { createHash } from "node:crypto";
import { safeLog } from "./messengerApi";
import { toLogUser } from "./privacy";
import { readScopedState, writeScopedState } from "./stateStore";

const COST_LEDGER_SCOPE = "cost:ledger:period";
const COST_LEDGER_TTL_SECONDS = 90 * 24 * 60 * 60;
const COST_LEDGER_MAX_ENTRIES_PER_PERIOD = 5_000;

export type CostLedgerStatus =
  | "provider_attempt_started"
  | "provider_attempt_succeeded"
  | "provider_attempt_failed"
  | "blocked";

export type CostLedgerEntry = {
  id: string;
  channel: string;
  operation: string;
  provider: string;
  model: string | null;
  userKey: string;
  reqId: string;
  status: CostLedgerStatus;
  estimatedCostUsd: number | null;
  estimatedOutputCostUsd: number | null;
  finalCostUsd: number | null;
  costEstimateComplete: boolean;
  estimateSource: string | null;
  unpricedCostComponents: string[];
};

export type StoredCostLedgerEntry = CostLedgerEntry & {
  period: string;
  recordedAt: string;
};

type CostSummaryBucket = {
  attempts: number;
  estimatedCostUsd: number;
  finalCostUsd: number;
};

type CostRequestSummaryBucket = CostSummaryBucket & {
  operation: string;
  provider: string;
  statuses: Record<string, number>;
  completeEstimateEntries: number;
  incompleteEstimateEntries: number;
  unpricedCostComponents: string[];
};

export type CostLedgerSummary = {
  period: string;
  totalEntries: number;
  uniqueUserCount: number;
  estimatedCostUsd: number;
  finalCostUsd: number;
  completeEstimateEntries: number;
  incompleteEstimateEntries: number;
  unpricedCostComponents: string[];
  byOperation: Record<string, CostSummaryBucket>;
  byProvider: Record<string, CostSummaryBucket>;
  byRequest: Record<string, CostRequestSummaryBucket>;
};

function periodFromDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function costValue(value: number | null): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function toRequestSummaryKey(reqId: string): string {
  return `sha256:${createHash("sha256").update(reqId).digest("hex").slice(0, 12)}`;
}

function mergeSummaryLabel(previous: string, next: string): string {
  if (previous === next) {
    return previous;
  }
  return "mixed";
}

function addToBucket(
  target: Record<string, CostSummaryBucket>,
  key: string,
  entry: StoredCostLedgerEntry
): void {
  const bucket =
    target[key] ??
    (target[key] = {
      attempts: 0,
      estimatedCostUsd: 0,
      finalCostUsd: 0,
    });
  bucket.attempts += 1;
  bucket.estimatedCostUsd = roundUsd(
    bucket.estimatedCostUsd +
      costValue(entry.estimatedCostUsd) +
      costValue(entry.estimatedOutputCostUsd)
  );
  bucket.finalCostUsd = roundUsd(
    bucket.finalCostUsd + costValue(entry.finalCostUsd)
  );
}

function addToRequestBucket(
  target: Record<string, CostRequestSummaryBucket>,
  entry: StoredCostLedgerEntry
): void {
  const key = toRequestSummaryKey(entry.reqId);
  const bucket =
    target[key] ??
    (target[key] = {
      attempts: 0,
      estimatedCostUsd: 0,
      finalCostUsd: 0,
      operation: entry.operation,
      provider: entry.provider,
      statuses: {},
      completeEstimateEntries: 0,
      incompleteEstimateEntries: 0,
      unpricedCostComponents: [],
    });
  bucket.attempts += 1;
  bucket.estimatedCostUsd = roundUsd(
    bucket.estimatedCostUsd +
      costValue(entry.estimatedCostUsd) +
      costValue(entry.estimatedOutputCostUsd)
  );
  bucket.finalCostUsd = roundUsd(
    bucket.finalCostUsd + costValue(entry.finalCostUsd)
  );
  bucket.operation = mergeSummaryLabel(bucket.operation, entry.operation);
  bucket.provider = mergeSummaryLabel(bucket.provider, entry.provider);
  bucket.statuses[entry.status] = (bucket.statuses[entry.status] ?? 0) + 1;
  if (entry.costEstimateComplete) {
    bucket.completeEstimateEntries += 1;
  } else {
    bucket.incompleteEstimateEntries += 1;
  }
  bucket.unpricedCostComponents = [
    ...new Set([
      ...bucket.unpricedCostComponents,
      ...entry.unpricedCostComponents,
    ]),
  ].sort();
}

export async function readCostLedgerPeriod(
  period: string
): Promise<StoredCostLedgerEntry[]> {
  return (
    (await Promise.resolve(
      readScopedState<StoredCostLedgerEntry[]>(COST_LEDGER_SCOPE, period)
    )) ?? []
  );
}

function getRetainedLedgerPeriods(now = new Date()): string[] {
  const periods = new Set<string>();
  const cursor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  for (let offset = 0; offset < 90; offset += 1) {
    periods.add(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return [...periods];
}

export async function appendCostLedgerEntry(
  entry: CostLedgerEntry,
  recordedAt = new Date()
): Promise<StoredCostLedgerEntry> {
  const period = periodFromDate(recordedAt);
  const storedEntry: StoredCostLedgerEntry = {
    ...entry,
    period,
    recordedAt: recordedAt.toISOString(),
  };
  const current = await readCostLedgerPeriod(period);
  const next = [...current, storedEntry].slice(-COST_LEDGER_MAX_ENTRIES_PER_PERIOD);
  await Promise.resolve(
    writeScopedState(
      COST_LEDGER_SCOPE,
      period,
      next,
      COST_LEDGER_TTL_SECONDS
    )
  );
  return storedEntry;
}

export async function deleteCostLedgerEntriesForUser(
  userKey: string,
  now = new Date()
): Promise<number> {
  let deleted = 0;
  for (const period of getRetainedLedgerPeriods(now)) {
    const current = await readCostLedgerPeriod(period);
    if (!current.length) {
      continue;
    }
    const next = current.filter(entry => entry.userKey !== userKey);
    deleted += current.length - next.length;
    if (next.length === current.length) {
      continue;
    }
    await Promise.resolve(
      writeScopedState(
        COST_LEDGER_SCOPE,
        period,
        next,
        COST_LEDGER_TTL_SECONDS
      )
    );
  }
  return deleted;
}

export async function updateCostLedgerEntry(
  id: string,
  updates: Partial<
    Pick<CostLedgerEntry, "status" | "finalCostUsd" | "costEstimateComplete" | "estimateSource">
  >,
  periodDate = new Date()
): Promise<StoredCostLedgerEntry | null> {
  const period = periodFromDate(periodDate);
  const current = await readCostLedgerPeriod(period);
  const index = current.findIndex(entry => entry.id === id);
  if (index < 0) {
    return null;
  }

  const updatedEntry: StoredCostLedgerEntry = {
    ...current[index],
    ...updates,
  };
  const next = [...current];
  next[index] = updatedEntry;
  await Promise.resolve(
    writeScopedState(
      COST_LEDGER_SCOPE,
      period,
      next,
      COST_LEDGER_TTL_SECONDS
    )
  );
  return updatedEntry;
}

export async function safelyUpdateCostLedgerEntry(
  id: string,
  updates: Partial<
    Pick<CostLedgerEntry, "status" | "finalCostUsd" | "costEstimateComplete" | "estimateSource">
  >,
  periodDate = new Date()
): Promise<StoredCostLedgerEntry | null> {
  try {
    return await updateCostLedgerEntry(id, updates, periodDate);
  } catch (error) {
    safeLog("cost_ledger_update_failed", {
      id: toRequestSummaryKey(id),
      status: updates.status,
      errorCode: error instanceof Error ? error.constructor.name : "UnknownError",
    });
    return null;
  }
}

export async function safelyAppendCostLedgerEntry(
  entry: CostLedgerEntry,
  recordedAt = new Date()
): Promise<StoredCostLedgerEntry | null> {
  try {
    return await appendCostLedgerEntry(entry, recordedAt);
  } catch (error) {
    safeLog("cost_ledger_append_failed", {
      reqId: entry.reqId,
      channel: entry.channel,
      operation: entry.operation,
      provider: entry.provider,
      model: entry.model,
      status: entry.status,
      user: toLogUser(entry.userKey),
      errorCode: error instanceof Error ? error.constructor.name : "UnknownError",
    });
    return null;
  }
}

function summarizeCostLedgerEntries(
  period: string,
  entries: StoredCostLedgerEntry[]
): CostLedgerSummary {
  const users = new Set<string>();
  const unpriced = new Set<string>();
  const byOperation: Record<string, CostSummaryBucket> = {};
  const byProvider: Record<string, CostSummaryBucket> = {};
  const byRequest: Record<string, CostRequestSummaryBucket> = {};
  let estimatedCostUsd = 0;
  let finalCostUsd = 0;
  let completeEstimateEntries = 0;
  let incompleteEstimateEntries = 0;

  for (const entry of entries) {
    users.add(entry.userKey);
    estimatedCostUsd +=
      costValue(entry.estimatedCostUsd) + costValue(entry.estimatedOutputCostUsd);
    finalCostUsd += costValue(entry.finalCostUsd);
    if (entry.costEstimateComplete) {
      completeEstimateEntries += 1;
    } else {
      incompleteEstimateEntries += 1;
    }
    for (const component of entry.unpricedCostComponents) {
      unpriced.add(component);
    }
    addToBucket(byOperation, entry.operation, entry);
    addToBucket(byProvider, entry.provider, entry);
    addToRequestBucket(byRequest, entry);
  }

  return {
    period,
    totalEntries: entries.length,
    uniqueUserCount: users.size,
    estimatedCostUsd: roundUsd(estimatedCostUsd),
    finalCostUsd: roundUsd(finalCostUsd),
    completeEstimateEntries,
    incompleteEstimateEntries,
    unpricedCostComponents: [...unpriced].sort(),
    byOperation,
    byProvider,
    byRequest,
  };
}

export async function summarizeCostLedgerPeriod(
  period: string
): Promise<CostLedgerSummary> {
  return summarizeCostLedgerEntries(period, await readCostLedgerPeriod(period));
}

export async function summarizeCostLedgerPeriods(
  periods: string[],
  summaryPeriod = periods.join(",")
): Promise<CostLedgerSummary> {
  const entries = (
    await Promise.all(periods.map(period => readCostLedgerPeriod(period)))
  ).flat();
  return summarizeCostLedgerEntries(summaryPeriod, entries);
}

export async function summarizeCostLedgerPeriodForUser(
  period: string,
  userKey: string
): Promise<CostLedgerSummary> {
  const entries = (await readCostLedgerPeriod(period)).filter(
    entry => entry.userKey === userKey
  );
  return summarizeCostLedgerEntries(period, entries);
}
