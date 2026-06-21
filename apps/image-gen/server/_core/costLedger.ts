import { createHash } from "node:crypto";
import {
  isRedisStateStoreEnabled,
  readScopedState,
  writeScopedState,
} from "./stateStore";
import { getRedisClient } from "./redis";
import { safeLog } from "./logger";
import { toLogUser } from "./privacy";

const COST_LEDGER_SCOPE = "cost:ledger:period";
const COST_LEDGER_TTL_SECONDS = 90 * 24 * 60 * 60;
const MAX_LEDGER_ENTRIES_PER_PERIOD = 5000;
const memoryAppendLocks = new Map<string, Promise<void>>();

export type CostLedgerEntry = {
  id: string;
  createdAt: string;
  period: string;
  channel: "facebook_messenger" | "whatsapp";
  operation: "image_generation" | "audio_transcription" | "video_generation";
  provider: string;
  model: string;
  pricingModel?: string;
  userKey: string;
  reqId: string;
  generationKind?: string | null;
  status:
    | "provider_attempt_started"
    | "provider_response_received"
    | "provider_failed";
  estimatedCostUsd?: number | null;
  estimatedOutputCostUsd?: number | null;
  finalCostUsd?: number | null;
  costEstimateComplete: boolean;
  estimateSource?: string;
  unpricedCostComponents?: string[];
};

export type CostLedgerAggregate = {
  attempts: number;
  estimatedCostUsd: number;
  finalCostUsd: number;
  incompleteEstimateEntries: number;
};

export type CostLedgerPeriodSummary = {
  period: string;
  totalEntries: number;
  uniqueUserCount: number;
  estimatedCostUsd: number;
  finalCostUsd: number;
  completeEstimateEntries: number;
  incompleteEstimateEntries: number;
  unpricedCostComponents: Record<string, number>;
  byOperation: Partial<Record<CostLedgerEntry["operation"], CostLedgerAggregate>>;
  byProvider: Record<string, CostLedgerAggregate>;
};

function utcPeriod(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function scopedLedgerKey(period: string): string {
  return `${COST_LEDGER_SCOPE}:${period}`;
}

function hashReference(prefix: string, value: string): string {
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 24);
  return `${prefix}_${digest}`;
}

function sanitizeLedgerEntry(
  entry: Omit<CostLedgerEntry, "createdAt" | "period">
): Omit<CostLedgerEntry, "createdAt" | "period"> {
  return {
    ...entry,
    id: hashReference("ledger", entry.id),
    reqId: hashReference("req", entry.reqId),
  };
}

function costValue(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function roundCost(value: number): number {
  return Number(value.toFixed(6));
}

function createAggregate(): CostLedgerAggregate {
  return {
    attempts: 0,
    estimatedCostUsd: 0,
    finalCostUsd: 0,
    incompleteEstimateEntries: 0,
  };
}

function addToAggregate(aggregate: CostLedgerAggregate, entry: CostLedgerEntry): void {
  aggregate.attempts += 1;
  aggregate.estimatedCostUsd += costValue(
    entry.estimatedCostUsd ?? entry.estimatedOutputCostUsd
  );
  aggregate.finalCostUsd += costValue(entry.finalCostUsd);
  if (!entry.costEstimateComplete) {
    aggregate.incompleteEstimateEntries += 1;
  }
}

async function appendRedisLedgerEntry(
  period: string,
  fullEntry: CostLedgerEntry
): Promise<void> {
  const redis = await getRedisClient();
  await redis.eval(
    "redis.call('rpush', KEYS[1], ARGV[1]); redis.call('ltrim', KEYS[1], -tonumber(ARGV[2]), -1); redis.call('expire', KEYS[1], tonumber(ARGV[3])); return 1",
    1,
    scopedLedgerKey(period),
    JSON.stringify(fullEntry),
    String(MAX_LEDGER_ENTRIES_PER_PERIOD),
    String(COST_LEDGER_TTL_SECONDS)
  );
}

async function appendMemoryLedgerEntry(
  period: string,
  fullEntry: CostLedgerEntry
): Promise<void> {
  const previous = memoryAppendLocks.get(period) ?? Promise.resolve();
  const currentAppend = previous.catch(() => undefined).then(async () => {
    const current =
      (await Promise.resolve(
        readScopedState<CostLedgerEntry[]>(COST_LEDGER_SCOPE, period)
      )) ?? [];
    const next = [...current, fullEntry].slice(-MAX_LEDGER_ENTRIES_PER_PERIOD);
    await Promise.resolve(
      writeScopedState(COST_LEDGER_SCOPE, period, next, COST_LEDGER_TTL_SECONDS)
    );
  });
  memoryAppendLocks.set(
    period,
    currentAppend.finally(() => {
      if (memoryAppendLocks.get(period) === currentAppend) {
        memoryAppendLocks.delete(period);
      }
    })
  );
  await currentAppend;
}

export async function appendCostLedgerEntry(
  entry: Omit<CostLedgerEntry, "createdAt" | "period">,
  now = new Date()
): Promise<void> {
  const period = utcPeriod(now);
  const fullEntry: CostLedgerEntry = {
    ...sanitizeLedgerEntry(entry),
    createdAt: now.toISOString(),
    period,
  };
  if (isRedisStateStoreEnabled()) {
    await appendRedisLedgerEntry(period, fullEntry);
    return;
  }
  await appendMemoryLedgerEntry(period, fullEntry);
}

export async function safelyAppendCostLedgerEntry(
  entry: Omit<CostLedgerEntry, "createdAt" | "period">,
  now = new Date()
): Promise<void> {
  try {
    await appendCostLedgerEntry(entry, now);
  } catch (error) {
    safeLog("cost_ledger_write_failed", {
      level: "warn",
      reqId: hashReference("req", entry.reqId),
      user: toLogUser(entry.userKey),
      operation: entry.operation,
      provider: entry.provider,
      status: entry.status,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function readCostLedgerPeriod(
  period: string
): Promise<CostLedgerEntry[]> {
  if (isRedisStateStoreEnabled()) {
    const redis = await getRedisClient();
    const values = await redis.lrange(scopedLedgerKey(period), 0, -1);
    return values.map(value => JSON.parse(value) as CostLedgerEntry);
  }

  return (
    (await Promise.resolve(
      readScopedState<CostLedgerEntry[]>(COST_LEDGER_SCOPE, period)
    )) ?? []
  );
}

export async function summarizeCostLedgerPeriod(
  period: string
): Promise<CostLedgerPeriodSummary> {
  const entries = await readCostLedgerPeriod(period);
  const users = new Set<string>();
  const unpricedCostComponents: Record<string, number> = {};
  const byOperation: CostLedgerPeriodSummary["byOperation"] = {};
  const byProvider: CostLedgerPeriodSummary["byProvider"] = {};
  let estimatedCostUsd = 0;
  let finalCostUsd = 0;
  let completeEstimateEntries = 0;
  let incompleteEstimateEntries = 0;

  for (const entry of entries) {
    users.add(entry.userKey);
    estimatedCostUsd += costValue(entry.estimatedCostUsd ?? entry.estimatedOutputCostUsd);
    finalCostUsd += costValue(entry.finalCostUsd);
    if (entry.costEstimateComplete) {
      completeEstimateEntries += 1;
    } else {
      incompleteEstimateEntries += 1;
    }

    for (const component of entry.unpricedCostComponents ?? []) {
      unpricedCostComponents[component] = (unpricedCostComponents[component] ?? 0) + 1;
    }

    const operationAggregate = byOperation[entry.operation] ?? createAggregate();
    addToAggregate(operationAggregate, entry);
    byOperation[entry.operation] = operationAggregate;

    const providerAggregate = byProvider[entry.provider] ?? createAggregate();
    addToAggregate(providerAggregate, entry);
    byProvider[entry.provider] = providerAggregate;
  }

  for (const aggregate of Object.values(byOperation)) {
    aggregate.estimatedCostUsd = roundCost(aggregate.estimatedCostUsd);
    aggregate.finalCostUsd = roundCost(aggregate.finalCostUsd);
  }
  for (const aggregate of Object.values(byProvider)) {
    aggregate.estimatedCostUsd = roundCost(aggregate.estimatedCostUsd);
    aggregate.finalCostUsd = roundCost(aggregate.finalCostUsd);
  }

  return {
    period,
    totalEntries: entries.length,
    uniqueUserCount: users.size,
    estimatedCostUsd: roundCost(estimatedCostUsd),
    finalCostUsd: roundCost(finalCostUsd),
    completeEstimateEntries,
    incompleteEstimateEntries,
    unpricedCostComponents,
    byOperation,
    byProvider,
  };
}
