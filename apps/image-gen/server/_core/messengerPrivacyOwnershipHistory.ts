import { createHash } from "node:crypto";

import { getRedisClient, isRedisEnabled } from "./redis";

const HISTORY_PREFIX = "messenger-privacy-ownership-v1";
const MAX_HISTORY_SCOPES = 1_024;
const HISTORY_SCAN_COUNT = 100;
const MAX_HISTORY_SCAN_PAGES = MAX_HISTORY_SCOPES * 2 + 2;

export type MessengerPrivacyOwnershipChannel =
  "facebook_messenger" | "whatsapp";

export type MessengerPrivacyOwnershipScope = Readonly<{
  workspaceId: number;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  channel?: MessengerPrivacyOwnershipChannel;
}>;

type MessengerPrivacyOwnershipSubject = Readonly<{
  pageId: string;
  userKey: string;
  channel?: MessengerPrivacyOwnershipChannel;
}>;

function validateSubject(input: MessengerPrivacyOwnershipSubject): void {
  if (!input.pageId.trim() || !/^[A-Za-z0-9:_-]{16,96}$/.test(input.userKey)) {
    throw new Error("Messenger privacy ownership subject is invalid");
  }
}

function validateScope(input: MessengerPrivacyOwnershipScope): void {
  if (
    !Number.isSafeInteger(input.workspaceId) ||
    input.workspaceId <= 0 ||
    !Number.isSafeInteger(input.channelConnectionId) ||
    input.channelConnectionId <= 0 ||
    !Number.isSafeInteger(input.bindingEpoch) ||
    input.bindingEpoch <= 0 ||
    !Number.isSafeInteger(input.privacyEpoch) ||
    input.privacyEpoch <= 0 ||
    (input.channel !== undefined &&
      input.channel !== "facebook_messenger" &&
      input.channel !== "whatsapp")
  ) {
    throw new Error("Messenger privacy ownership scope is invalid");
  }
}

function subjectTag(input: MessengerPrivacyOwnershipSubject): string {
  const digest = createHash("sha256")
    .update(input.channel ?? "facebook_messenger")
    .update("\0")
    .update(input.pageId.trim())
    .update("\0")
    .update(input.userKey)
    .digest("hex");
  return `{messenger-privacy-ownership-${digest}}`;
}

function historyKey(input: MessengerPrivacyOwnershipSubject): string {
  return `${HISTORY_PREFIX}:${subjectTag(input)}:scopes`;
}

function tombstoneKey(input: MessengerPrivacyOwnershipSubject): string {
  return `${HISTORY_PREFIX}:${subjectTag(input)}:erased`;
}

function scrubbedKey(input: MessengerPrivacyOwnershipSubject): string {
  return `${HISTORY_PREFIX}:${subjectTag(input)}:scrubbed`;
}

function scopeField(input: MessengerPrivacyOwnershipScope): string {
  return `${input.workspaceId}:${input.channelConnectionId}:${input.bindingEpoch}:${input.channel ?? "facebook_messenger"}`;
}

/**
 * Registers metadata before tenant content is committed. A crash can leave an
 * empty historical scope, which is safe; it can never leave unindexed content.
 * The key contains only a Page+privacy-hash digest and numeric ownership. It
 * intentionally has no TTL: billing identity can outlive short-lived content,
 * and successful erasure deletes the history after every scope is scrubbed.
 */
export async function registerMessengerPrivacyOwnership(
  input: MessengerPrivacyOwnershipSubject & MessengerPrivacyOwnershipScope
): Promise<void> {
  validateSubject(input);
  validateScope(input);
  if (!isRedisEnabled()) return;
  const redis = await getRedisClient();
  const result = Number(
    await redis.eval(
      `
        if redis.call("EXISTS", KEYS[2]) == 1 then return 0 end
        local current = tonumber(redis.call("HGET", KEYS[1], ARGV[1]) or "0")
        local requested = tonumber(ARGV[2])
        if current < requested then
          redis.call("HSET", KEYS[1], ARGV[1], ARGV[2])
        end
        return 1
      `,
      2,
      historyKey(input),
      tombstoneKey(input),
      scopeField(input),
      input.privacyEpoch
    )
  );
  if (result !== 1) {
    throw new Error("Messenger privacy ownership subject is erased");
  }
}

/** Installs the global subject tombstone before returning exact tenant scopes. */
export async function beginMessengerPrivacyOwnershipErasure(
  input: MessengerPrivacyOwnershipSubject
): Promise<MessengerPrivacyOwnershipScope[]> {
  validateSubject(input);
  if (!isRedisEnabled()) return [];
  const redis = await getRedisClient();
  const historySize = Number(
    await redis.eval(
      `
      local historyType = redis.call("TYPE", KEYS[1]).ok
      local tombstoneType = redis.call("TYPE", KEYS[2]).ok
      if historyType ~= "none" and historyType ~= "hash" then
        return redis.error_reply("privacy ownership history has invalid type")
      end
      if tombstoneType ~= "none" and tombstoneType ~= "string" then
        return redis.error_reply("privacy ownership tombstone has invalid type")
      end
      redis.call("SET", KEYS[2], "1")
      redis.call("PERSIST", KEYS[1])
      return redis.call("HLEN", KEYS[1])
    `,
      2,
      historyKey(input),
      tombstoneKey(input)
    )
  );
  if (
    !Number.isSafeInteger(historySize) ||
    historySize < 0 ||
    historySize > MAX_HISTORY_SCOPES
  ) {
    throw new Error("Messenger privacy ownership history exceeds safety bound");
  }

  const fields = new Map<string, string>();
  const visitedCursors = new Set<string>();
  let pages = 0;
  let cursor = "0";
  do {
    pages += 1;
    if (pages > MAX_HISTORY_SCAN_PAGES) {
      throw new Error(
        "Messenger privacy ownership history scan exceeds safety bound"
      );
    }
    if (visitedCursors.has(cursor)) {
      throw new Error(
        "Messenger privacy ownership history scan did not progress"
      );
    }
    visitedCursors.add(cursor);
    const scanResult = await redis.eval(
      "return redis.call('HSCAN', KEYS[1], ARGV[1], 'COUNT', ARGV[2])",
      1,
      historyKey(input),
      cursor,
      HISTORY_SCAN_COUNT
    );
    if (!Array.isArray(scanResult) || !Array.isArray(scanResult[1])) {
      throw new Error("Messenger privacy ownership history scan failed");
    }
    const batch = scanResult[1].map(String);
    if (batch.length % 2 !== 0) {
      throw new Error("Messenger privacy ownership history is invalid");
    }
    for (let index = 0; index < batch.length; index += 2) {
      const previous = fields.get(batch[index]);
      if (previous !== undefined && previous !== batch[index + 1]) {
        throw new Error(
          "Messenger privacy ownership history changed during scan"
        );
      }
      fields.set(batch[index], batch[index + 1]);
    }
    if (fields.size > MAX_HISTORY_SCOPES) {
      throw new Error(
        "Messenger privacy ownership history exceeds safety bound"
      );
    }
    cursor = String(scanResult[0]);
  } while (cursor !== "0");

  if (fields.size !== historySize) {
    throw new Error("Messenger privacy ownership history is invalid");
  }
  const scopes: MessengerPrivacyOwnershipScope[] = [];
  for (const [field, privacyEpoch] of fields) {
    // Pre-release W:C and W:C:channel fields lack an immutable binding epoch.
    // Guessing the current epoch after reconnect would make old content
    // unreachable, so fail closed instead of claiming that legacy inventory
    // was scrubbed. No such field format has been deployed.
    const match = /^(\d+):(\d+):(\d+):(facebook_messenger|whatsapp)$/.exec(
      field
    );
    const scope = {
      workspaceId: Number(match?.[1]),
      channelConnectionId: Number(match?.[2]),
      bindingEpoch: Number(match?.[3]),
      privacyEpoch: Number(privacyEpoch),
      channel: match?.[4] as MessengerPrivacyOwnershipChannel,
    };
    validateScope(scope);
    scopes.push(scope);
  }
  return scopes;
}

export async function completeMessengerPrivacyOwnershipErasure(
  input: MessengerPrivacyOwnershipSubject
): Promise<void> {
  validateSubject(input);
  if (!isRedisEnabled()) return;
  const redis = await getRedisClient();
  const result = Number(
    await redis.eval(
      `
        if redis.call("GET", KEYS[2]) ~= "1" then return 0 end
        redis.call("DEL", KEYS[1])
        redis.call("SET", KEYS[3], "1")
        return 1
      `,
      3,
      historyKey(input),
      tombstoneKey(input),
      scrubbedKey(input)
    )
  );
  if (result !== 1) {
    throw new Error("Messenger privacy ownership scrub was not fenced");
  }
}

export async function isMessengerPrivacyOwnershipErased(
  input: MessengerPrivacyOwnershipSubject
): Promise<boolean> {
  validateSubject(input);
  if (!isRedisEnabled()) return false;
  const redis = await getRedisClient();
  return (await redis.get(scrubbedKey(input))) === "1";
}
