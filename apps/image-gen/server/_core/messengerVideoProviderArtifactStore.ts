import { createHash } from "node:crypto";
import { getRedisClient, isRedisEnabled } from "./redis";
import {
  assertMessengerStorageScope,
  type MessengerStorageRequestScope,
} from "./messengerStorageObject";

const ARTIFACT_RETENTION_SECONDS = 31 * 24 * 60 * 60;
const PROVIDER_PATTERN = /^openai$/u;
const PROVIDER_JOB_ID_PATTERN = /^[A-Za-z0-9_.-]{1,200}$/u;

export type MessengerVideoProviderArtifact = Readonly<{
  provider: string;
  providerJobId: string;
}>;

const memoryArtifacts = new Map<string, Map<string, number>>();
const memoryErasedEpochs = new Map<string, number>();

function assertArtifact(
  artifact: MessengerVideoProviderArtifact
): MessengerVideoProviderArtifact {
  const provider = artifact.provider.trim().toLowerCase();
  const providerJobId = artifact.providerJobId.trim();
  if (!PROVIDER_PATTERN.test(provider)) {
    throw new Error("Messenger video provider artifact is not allowlisted");
  }
  if (!PROVIDER_JOB_ID_PATTERN.test(providerJobId)) {
    throw new Error("Messenger video provider job id is invalid");
  }
  return { provider, providerJobId };
}

function scopeDigest(
  scope: MessengerStorageRequestScope,
  includePrivacyEpoch: boolean
): string {
  assertMessengerStorageScope(scope);
  if (!scope.pageId.trim()) {
    throw new Error("Messenger video provider artifact Page scope is required");
  }
  const parts: Array<string | number> = [
    scope.workspaceId,
    scope.channelConnectionId,
    scope.bindingEpoch,
    scope.userKey,
    scope.pageId,
  ];
  if (includePrivacyEpoch) parts.push(scope.privacyEpoch);
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}

function indexKey(scope: MessengerStorageRequestScope): string {
  return `messenger-video-provider-artifact:v3:index:${scopeDigest(scope, true)}`;
}

function tombstoneKey(scope: MessengerStorageRequestScope): string {
  return `messenger-video-provider-artifact:v3:erased:${scopeDigest(scope, false)}`;
}

function artifactDigest(serialized: string): string {
  return createHash("sha256").update(serialized).digest("hex");
}

function artifactKeyPrefix(scope: MessengerStorageRequestScope): string {
  return `messenger-video-provider-artifact:v3:artifact:${scopeDigest(scope, true)}:`;
}

function artifactKey(
  scope: MessengerStorageRequestScope,
  serialized: string
): string {
  return `${artifactKeyPrefix(scope)}${artifactDigest(serialized)}`;
}

function pruneMemoryArtifacts(index: string, now: number): Map<string, number> {
  const entries = memoryArtifacts.get(index) ?? new Map<string, number>();
  for (const [serialized, expiresAt] of entries) {
    if (expiresAt <= now) entries.delete(serialized);
  }
  if (entries.size === 0) memoryArtifacts.delete(index);
  return entries;
}

function serializeArtifact(artifact: MessengerVideoProviderArtifact): string {
  return JSON.stringify(assertArtifact(artifact));
}

function parseArtifact(value: string): MessengerVideoProviderArtifact | null {
  try {
    const parsed = JSON.parse(value) as Partial<MessengerVideoProviderArtifact>;
    if (
      typeof parsed.provider !== "string" ||
      typeof parsed.providerJobId !== "string"
    ) {
      return null;
    }
    return assertArtifact({
      provider: parsed.provider,
      providerJobId: parsed.providerJobId,
    });
  } catch {
    return null;
  }
}

export async function registerMessengerVideoProviderArtifact(
  artifact: MessengerVideoProviderArtifact,
  scope: MessengerStorageRequestScope
): Promise<boolean> {
  const serialized = serializeArtifact(artifact);
  const index = indexKey(scope);
  const tombstone = tombstoneKey(scope);
  const durableArtifactKey = artifactKey(scope, serialized);
  const digest = artifactDigest(serialized);
  const now = Date.now();
  const expiresAt = now + ARTIFACT_RETENTION_SECONDS * 1000;
  if (!isRedisEnabled()) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Messenger video provider artifact Redis store is unavailable"
      );
    }
    const entries = pruneMemoryArtifacts(index, now);
    if ((memoryErasedEpochs.get(tombstone) ?? 0) >= scope.privacyEpoch) {
      entries.set(serialized, expiresAt);
      memoryArtifacts.set(index, entries);
      return false;
    }
    entries.set(serialized, expiresAt);
    memoryArtifacts.set(index, entries);
    return true;
  }

  const redis = await getRedisClient();
  const result = Number(
    await redis.eval(
      `
        local erasedEpoch = tonumber(redis.call('get', KEYS[2]) or '0')
        local incomingEpoch = tonumber(ARGV[3])
        if not incomingEpoch or incomingEpoch <= 0 then
          return redis.error_reply('invalid video artifact privacy epoch')
        end
        local now = tonumber(ARGV[5])
        if not now or now <= 0 then
          return redis.error_reply('invalid video artifact timestamp')
        end
        redis.call('zremrangebyscore', KEYS[1], '-inf', now)
        redis.call('set', KEYS[3], ARGV[1], 'EX', ARGV[4])
        redis.call('zadd', KEYS[1], now + (tonumber(ARGV[4]) * 1000), ARGV[2])
        redis.call('expire', KEYS[1], ARGV[4])
        if erasedEpoch >= incomingEpoch then
          return 0
        end
        return 1
      `,
      3,
      index,
      tombstone,
      durableArtifactKey,
      serialized,
      digest,
      scope.privacyEpoch,
      ARTIFACT_RETENTION_SECONDS,
      now
    )
  );
  return result === 1;
}

export async function beginMessengerVideoProviderArtifactErasure(
  scope: MessengerStorageRequestScope
): Promise<MessengerVideoProviderArtifact[]> {
  const index = indexKey(scope);
  const tombstone = tombstoneKey(scope);
  const artifactPrefix = artifactKeyPrefix(scope);
  const now = Date.now();
  let serialized: string[];
  if (!isRedisEnabled()) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Messenger video provider artifact Redis store is unavailable"
      );
    }
    memoryErasedEpochs.set(
      tombstone,
      Math.max(memoryErasedEpochs.get(tombstone) ?? 0, scope.privacyEpoch)
    );
    serialized = [...pruneMemoryArtifacts(index, now).keys()];
  } else {
    const redis = await getRedisClient();
    serialized = (await redis.eval(
      `
        local currentEpoch = tonumber(redis.call('get', KEYS[2]) or '0')
        local requestedEpoch = tonumber(ARGV[1])
        if not requestedEpoch or requestedEpoch <= 0 then
          return redis.error_reply('invalid video artifact erasure epoch')
        end
        if currentEpoch < requestedEpoch then
          redis.call('set', KEYS[2], ARGV[1], 'EX', ARGV[2])
        end
        redis.call('zremrangebyscore', KEYS[1], '-inf', ARGV[3])
        local digests = redis.call('zrangebyscore', KEYS[1], ARGV[3], '+inf')
        local artifacts = {}
        for _, digest in ipairs(digests) do
          local artifact = redis.call('get', ARGV[4] .. digest)
          if artifact then
            table.insert(artifacts, artifact)
          else
            redis.call('zrem', KEYS[1], digest)
          end
        end
        return artifacts
      `,
      2,
      index,
      tombstone,
      scope.privacyEpoch,
      ARTIFACT_RETENTION_SECONDS,
      now,
      artifactPrefix
    )) as string[];
  }

  return serialized
    .map(parseArtifact)
    .filter((artifact): artifact is MessengerVideoProviderArtifact =>
      Boolean(artifact)
    );
}

export async function removeMessengerVideoProviderArtifact(
  artifact: MessengerVideoProviderArtifact,
  scope: MessengerStorageRequestScope
): Promise<void> {
  const serialized = serializeArtifact(artifact);
  const index = indexKey(scope);
  const durableArtifactKey = artifactKey(scope, serialized);
  const digest = artifactDigest(serialized);
  if (!isRedisEnabled()) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "Messenger video provider artifact Redis store is unavailable"
      );
    }
    const entries = memoryArtifacts.get(index);
    entries?.delete(serialized);
    if (entries?.size === 0) memoryArtifacts.delete(index);
    return;
  }
  const redis = await getRedisClient();
  await redis.eval(
    "redis.call('del', KEYS[2]); return redis.call('zrem', KEYS[1], ARGV[1])",
    2,
    index,
    durableArtifactKey,
    digest
  );
}

export function resetMessengerVideoProviderArtifactStoreForTests(): void {
  memoryArtifacts.clear();
  memoryErasedEpochs.clear();
}
