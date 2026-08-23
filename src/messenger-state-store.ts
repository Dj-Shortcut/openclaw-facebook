import { createHash, randomUUID } from "node:crypto";
import { createRedisMessengerEphemeralStateStore } from "./messenger-state-store-redis.js";

export type MessengerSharedStateStoreMode = "memory" | "redis";

export type MessengerStateScope = Readonly<{
  accountId: string;
  pageId: string;
}>;

export type MessengerBudgetKind = "image_forward" | "audio_transcription";

export type MessengerDailyBudgetResult =
  | { ok: true; count: number; cap: number }
  | { ok: false; count: number; cap: number };

export interface MessengerEphemeralStateStore {
  readonly mode: MessengerSharedStateStoreMode;
  ensureReady(): Promise<void>;
  claimMessage(
    input: Readonly<{
      scope: MessengerStateScope;
      eventIdentity: string;
      ownerToken: string;
      ttlMs: number;
      now?: number;
    }>,
  ): Promise<boolean>;
  reserveDaily(
    input: Readonly<{
      scope: MessengerStateScope;
      kind: MessengerBudgetKind;
      dayKey: string;
      eventIdentity: string;
      cap: number;
      expiresAtMs: number;
      now?: number;
    }>,
  ): Promise<MessengerDailyBudgetResult>;
  close(): Promise<void>;
}

export class MessengerSharedStateUnavailableError extends Error {
  readonly code: "config" | "connect" | "command" | "protocol";

  constructor(
    code: MessengerSharedStateUnavailableError["code"],
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "MessengerSharedStateUnavailableError";
    this.code = code;
  }
}

export function validateMessengerStateIdentity(
  scope: MessengerStateScope,
  eventIdentity: string,
): void {
  for (const [label, value] of [
    ["accountId", scope.accountId],
    ["pageId", scope.pageId],
    ["eventIdentity", eventIdentity],
  ] as const) {
    if (typeof value !== "string" || !value.trim()) {
      throw new MessengerSharedStateUnavailableError(
        "config",
        `Messenger shared state ${label} must not be empty`,
      );
    }
  }
}

const MESSAGE_DEDUPE_MAX_ENTRIES = 5_000;

class MemoryMessengerEphemeralStateStore implements MessengerEphemeralStateStore {
  readonly mode = "memory" as const;
  private readonly claims = new Map<
    string,
    { ownerToken: string; expiresAt: number }
  >();
  private readonly counters = new Map<
    string,
    { count: number; expiresAt: number }
  >();
  private readonly reservations = new Map<
    string,
    { result: MessengerDailyBudgetResult; expiresAt: number }
  >();

  async ensureReady(): Promise<void> {}

  async claimMessage(
    input: Readonly<{
      scope: MessengerStateScope;
      eventIdentity: string;
      ownerToken: string;
      ttlMs: number;
      now?: number;
    }>,
  ): Promise<boolean> {
    validateMessengerStateIdentity(input.scope, input.eventIdentity);
    if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
      throw new MessengerSharedStateUnavailableError(
        "config",
        "Messenger shared state ttlMs must be a positive integer",
      );
    }
    const now = input.now ?? Date.now();
    this.prune(now);
    const key = this.claimKey(input.scope, input.eventIdentity);
    const current = this.claims.get(key);
    if (current && current.expiresAt > now) {
      return current.ownerToken === input.ownerToken;
    }
    this.claims.set(key, {
      ownerToken: input.ownerToken,
      expiresAt: now + input.ttlMs,
    });
    this.prune(now);
    return true;
  }

  async reserveDaily(
    input: Readonly<{
      scope: MessengerStateScope;
      kind: MessengerBudgetKind;
      dayKey: string;
      eventIdentity: string;
      cap: number;
      expiresAtMs: number;
      now?: number;
    }>,
  ): Promise<MessengerDailyBudgetResult> {
    validateMessengerStateIdentity(input.scope, input.eventIdentity);
    if (!Number.isSafeInteger(input.cap) || input.cap <= 0) {
      throw new MessengerSharedStateUnavailableError(
        "config",
        "Messenger shared state cap must be a positive integer",
      );
    }
    const now = input.now ?? Date.now();
    if (!Number.isSafeInteger(input.expiresAtMs) || input.expiresAtMs <= now) {
      throw new MessengerSharedStateUnavailableError(
        "config",
        "Messenger shared state expiry must be in the future",
      );
    }
    this.prune(now);
    const counterKey = this.counterKey(input.scope, input.kind, input.dayKey);
    const reservationKey = this.opaqueKey(
      "reservation",
      counterKey,
      input.eventIdentity,
    );
    const prior = this.reservations.get(reservationKey);
    if (prior && prior.expiresAt > now) {
      return prior.result;
    }

    const current = this.counters.get(counterKey);
    const currentCount =
      current?.expiresAt && current.expiresAt > now ? current.count : 0;
    const result: MessengerDailyBudgetResult =
      currentCount >= input.cap
        ? { ok: false, count: currentCount, cap: input.cap }
        : { ok: true, count: currentCount + 1, cap: input.cap };
    if (result.ok) {
      this.counters.set(counterKey, {
        count: result.count,
        expiresAt: input.expiresAtMs,
      });
      this.reservations.set(reservationKey, {
        result,
        expiresAt: input.expiresAtMs,
      });
    }
    return result;
  }

  async close(): Promise<void> {}

  reset(): void {
    this.claims.clear();
    this.counters.clear();
    this.reservations.clear();
  }

  statsForTests(): { claims: number; counters: number; reservations: number } {
    return {
      claims: this.claims.size,
      counters: this.counters.size,
      reservations: this.reservations.size,
    };
  }

  private claimKey(scope: MessengerStateScope, eventIdentity: string): string {
    return this.opaqueKey(
      "dedupe",
      scope.accountId,
      scope.pageId,
      eventIdentity,
    );
  }

  private counterKey(
    scope: MessengerStateScope,
    kind: MessengerBudgetKind,
    dayKey: string,
  ): string {
    return this.opaqueKey(
      "budget",
      scope.accountId,
      scope.pageId,
      kind,
      dayKey,
    );
  }

  private opaqueKey(...parts: string[]): string {
    const hash = createHash("sha256");
    for (const part of parts) {
      const bytes = Buffer.from(part, "utf8");
      hash.update(String(bytes.length));
      hash.update(":");
      hash.update(bytes);
    }
    return hash.digest("hex");
  }

  private prune(now: number): void {
    for (const [key, value] of this.claims) {
      if (value.expiresAt <= now) {
        this.claims.delete(key);
      }
    }
    while (this.claims.size > MESSAGE_DEDUPE_MAX_ENTRIES) {
      const oldestKey = this.claims.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.claims.delete(oldestKey);
    }
    for (const [key, value] of this.counters) {
      if (value.expiresAt <= now) this.counters.delete(key);
    }
    for (const [key, value] of this.reservations) {
      if (value.expiresAt <= now) this.reservations.delete(key);
    }
  }
}

const memoryStore = new MemoryMessengerEphemeralStateStore();
let sharedStore:
  | { mode: MessengerSharedStateStoreMode; store: MessengerEphemeralStateStore }
  | undefined;

export function getMemoryMessengerEphemeralStateStore(): MessengerEphemeralStateStore {
  return memoryStore;
}

export function resetMemoryMessengerEphemeralStateStoreForTests(): void {
  memoryStore.reset();
}

export function getMemoryMessengerEphemeralStateStoreStatsForTests(): {
  claims: number;
  counters: number;
  reservations: number;
} {
  return memoryStore.statsForTests();
}

export async function getMessengerEphemeralStateStore(
  mode: MessengerSharedStateStoreMode,
): Promise<MessengerEphemeralStateStore> {
  if (sharedStore) {
    if (sharedStore.mode !== mode) {
      throw new MessengerSharedStateUnavailableError(
        "config",
        "Messenger shared state mode changed after initialization",
      );
    }
    return sharedStore.store;
  }
  const store =
    mode === "memory" ? memoryStore : createRedisMessengerEphemeralStateStore();
  sharedStore = { mode, store };
  return store;
}

export function createMessengerStateOwnerToken(): string {
  return randomUUID();
}

export async function resetMessengerEphemeralStateStoreForTests(): Promise<void> {
  memoryStore.reset();
  if (sharedStore) {
    await sharedStore.store.close();
    sharedStore = undefined;
  }
}
