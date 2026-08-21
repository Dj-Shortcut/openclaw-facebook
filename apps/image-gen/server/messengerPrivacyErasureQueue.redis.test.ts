import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  claimDueMessengerPrivacyErasureJobs,
  claimMessengerPrivacyErasureJob,
  completeMessengerPrivacyErasureJob,
  enqueueMessengerPrivacyErasureJob,
  ensureMessengerPrivacyErasureQueueReadable,
  ensureMessengerPrivacyErasureWorkerReady,
  getMessengerPrivacyErasurePendingCount,
  recordMessengerPrivacyErasureWorkerPollFailure,
  recordMessengerPrivacyErasureWorkerPollSuccess,
  rescheduleMessengerPrivacyErasureJob,
  setMessengerPrivacyErasureEpoch,
} from "./_core/messengerPrivacyErasureQueue";
import { getRedisClient, resetRedisClientForTests } from "./_core/redis";

const suite = describe.runIf(process.env.RUN_REDIS_INTEGRATION === "1");
const originalRedisUrl = process.env.REDIS_URL;
const originalJwtSecret = process.env.JWT_SECRET;
const originalActiveKeyId =
  process.env.MESSENGER_PRIVACY_ERASURE_ENCRYPTION_ACTIVE_KEY_ID;
const originalEncryptionKeys =
  process.env.MESSENGER_PRIVACY_ERASURE_ENCRYPTION_KEYS_JSON;
const ENCRYPTION_KEY_1 = Buffer.alloc(32, 0x11).toString("base64url");
const ENCRYPTION_KEY_2 = Buffer.alloc(32, 0x22).toString("base64url");

suite("Messenger privacy erasure durable Redis queue", () => {
  beforeAll(() => {
    process.env.REDIS_URL ||= "redis://127.0.0.1:6379/14";
    process.env.JWT_SECRET =
      "messenger-privacy-erasure-test-secret-at-least-32-bytes";
    configureEncryptionKeys("rotation-k1", [
      { id: "rotation-k1", key: ENCRYPTION_KEY_1 },
    ]);
    resetRedisClientForTests();
  });

  beforeEach(async () => {
    configureEncryptionKeys("rotation-k1", [
      { id: "rotation-k1", key: ENCRYPTION_KEY_1 },
    ]);
    const redis = await getRedisClient();
    await redis.eval("return redis.call('FLUSHDB')", 0);
  });

  afterAll(() => {
    resetRedisClientForTests();
    restoreEnv("REDIS_URL", originalRedisUrl);
    restoreEnv("JWT_SECRET", originalJwtSecret);
    restoreEnv(
      "MESSENGER_PRIVACY_ERASURE_ENCRYPTION_ACTIVE_KEY_ID",
      originalActiveKeyId
    );
    restoreEnv(
      "MESSENGER_PRIVACY_ERASURE_ENCRYPTION_KEYS_JSON",
      originalEncryptionKeys
    );
  });

  it("atomically deduplicates, seals identity, survives restart, and completes once", async () => {
    const psid = "raw-psid-must-never-appear-in-redis";
    const scope = {
      workspaceId: 41,
      channelConnectionId: 9,
      pageId: "page-privacy-queue",
      bindingEpoch: 3,
      userKey: "privacy_user_key_1234567890",
      oldPrivacyEpoch: 7,
    };
    const [firstId, duplicateId] = await Promise.all([
      enqueueMessengerPrivacyErasureJob({ psid, scope, now: 1_000 }),
      enqueueMessengerPrivacyErasureJob({ psid, scope, now: 1_000 }),
    ]);
    expect(duplicateId).toBe(firstId);
    await expect(getMessengerPrivacyErasurePendingCount()).resolves.toBe(1);

    const keys = await scanAllKeys();
    expect(JSON.stringify(keys)).not.toContain(psid);
    const redis = await getRedisClient();
    for (const key of keys.filter(key => key.includes(":job:"))) {
      const raw = await redis.get(key);
      expect(raw).not.toContain(psid);
      expect(JSON.parse(raw ?? "{}").sealedPsid).toMatch(/^v2:rotation-k1:/);
    }

    const firstClaim = await claimMessengerPrivacyErasureJob(firstId, 1_000);
    expect(firstClaim).not.toBeNull();
    expect(firstClaim?.psid).toBe(psid);
    await expect(
      claimMessengerPrivacyErasureJob(firstId, 1_000)
    ).resolves.toBeNull();

    await setMessengerPrivacyErasureEpoch({
      claim: firstClaim!,
      erasureEpoch: 8,
      now: 1_000,
    });
    await rescheduleMessengerPrivacyErasureJob({
      claim: firstClaim!,
      errorCode: "TransientFailure",
      now: 1_000,
    });

    resetRedisClientForTests();
    const resumed = await claimMessengerPrivacyErasureJob(firstId, 5_000);
    expect(resumed).not.toBeNull();
    expect(resumed?.job).toMatchObject({
      erasureEpoch: 8,
      attemptCount: 1,
      lastErrorCode: "TransientFailure",
    });
    await completeMessengerPrivacyErasureJob(resumed!);
    await expect(getMessengerPrivacyErasurePendingCount()).resolves.toBe(0);
    await expect(
      claimMessengerPrivacyErasureJob(firstId, 10_000)
    ).resolves.toBeNull();
  });

  it("publishes a metadata-only process heartbeat and rejects failed or overdue work", async () => {
    const now = Date.now();
    await recordMessengerPrivacyErasureWorkerPollSuccess(0, now);
    await expect(
      ensureMessengerPrivacyErasureWorkerReady(now + 1)
    ).resolves.toBeUndefined();

    await recordMessengerPrivacyErasureWorkerPollFailure(
      new TypeError("claim failed"),
      now + 2
    );
    await expect(
      ensureMessengerPrivacyErasureWorkerReady(now + 3)
    ).rejects.toThrow("last poll failed");

    await recordMessengerPrivacyErasureWorkerPollSuccess(0, now + 4);
    await enqueueMessengerPrivacyErasureJob({
      psid: "privacy-erasure-overdue-real-redis",
      scope: {
        workspaceId: 42,
        channelConnectionId: 10,
        pageId: "page-overdue-worker",
        bindingEpoch: 2,
        userKey: "privacy_user_key_overdue_worker_1",
        oldPrivacyEpoch: 3,
      },
      now: now - 60_001,
    });
    await expect(
      ensureMessengerPrivacyErasureWorkerReady(now + 4)
    ).rejects.toThrow("backlog is overdue");
  });

  it("rewraps a non-active v2 key under lease and survives restart without the retired key", async () => {
    const psid = "privacy-erasure-key-rotation-restart";
    const jobId = await enqueueMessengerPrivacyErasureJob({
      psid,
      scope: {
        workspaceId: 43,
        channelConnectionId: 19,
        pageId: "page-key-rotation",
        bindingEpoch: 4,
        userKey: "privacy_user_key_rotation_12345",
        oldPrivacyEpoch: 6,
      },
      now: 1_000,
    });

    configureEncryptionKeys("rotation-k2", [
      { id: "rotation-k2", key: ENCRYPTION_KEY_2 },
    ]);
    resetRedisClientForTests();
    await expect(ensureMessengerPrivacyErasureQueueReadable()).rejects.toThrow(
      "envelope key is unavailable"
    );

    configureEncryptionKeys("rotation-k2", [
      { id: "rotation-k1", key: ENCRYPTION_KEY_1 },
      { id: "rotation-k2", key: ENCRYPTION_KEY_2 },
    ]);
    resetRedisClientForTests();
    await expect(
      ensureMessengerPrivacyErasureQueueReadable()
    ).resolves.toBeUndefined();
    const rotated = await claimMessengerPrivacyErasureJob(jobId, 1_000);
    expect(rotated?.psid).toBe(psid);
    expect(rotated?.job.sealedPsid).toMatch(/^v2:rotation-k2:/);
    const redis = await getRedisClient();
    const jobStorageKey = (await scanAllKeys()).find(key =>
      key.endsWith(`:job:${jobId}`)
    );
    expect(
      JSON.parse((await redis.get(jobStorageKey!)) ?? "{}").sealedPsid
    ).toMatch(/^v2:rotation-k2:/);
    await rescheduleMessengerPrivacyErasureJob({
      claim: rotated!,
      errorCode: "RestartProof",
      now: 1_000,
    });

    configureEncryptionKeys("rotation-k2", [
      { id: "rotation-k2", key: ENCRYPTION_KEY_2 },
    ]);
    resetRedisClientForTests();
    await expect(
      ensureMessengerPrivacyErasureQueueReadable()
    ).resolves.toBeUndefined();
    const restarted = await claimMessengerPrivacyErasureJob(jobId, 5_000);
    expect(restarted?.psid).toBe(psid);
    expect(restarted?.job.sealedPsid).toMatch(/^v2:rotation-k2:/);
    await completeMessengerPrivacyErasureJob(restarted!);
  });

  it("opens a legacy current-JWT v1 envelope and rewraps it under the active v2 key", async () => {
    const psid = "privacy-erasure-legacy-current-jwt";
    const jobId = await enqueueMessengerPrivacyErasureJob({
      psid,
      scope: {
        workspaceId: 44,
        channelConnectionId: 20,
        pageId: "page-legacy-rewrap",
        bindingEpoch: 2,
        userKey: "privacy_user_key_legacy_rewrap_1",
        oldPrivacyEpoch: 3,
      },
      now: 2_000,
    });
    const redis = await getRedisClient();
    const jobStorageKey = (await scanAllKeys()).find(key =>
      key.endsWith(`:job:${jobId}`)
    );
    const legacyJob = JSON.parse((await redis.get(jobStorageKey!)) ?? "{}");
    legacyJob.sealedPsid = sealLegacyV1(legacyJob, psid);
    await redis.set(jobStorageKey!, JSON.stringify(legacyJob));

    resetRedisClientForTests();
    const claim = await claimMessengerPrivacyErasureJob(jobId, 2_000);
    expect(claim?.psid).toBe(psid);
    expect(claim?.job.sealedPsid).toMatch(/^v2:rotation-k1:/);
    expect(
      JSON.parse((await (await getRedisClient()).get(jobStorageKey!)) ?? "{}")
        .sealedPsid
    ).toMatch(/^v2:rotation-k1:/);
    await completeMessengerPrivacyErasureJob(claim!);
  });

  it("keeps a pending member when a worker loses its lease", async () => {
    const jobId = await enqueueMessengerPrivacyErasureJob({
      psid: "lease-loss-privacy-psid",
      scope: {
        workspaceId: 52,
        channelConnectionId: 10,
        pageId: "page-lease-loss",
        bindingEpoch: 2,
        userKey: "privacy_user_key_lease_loss_1234",
        oldPrivacyEpoch: 4,
      },
      now: 2_000,
    });
    const claim = await claimMessengerPrivacyErasureJob(jobId, 2_000);
    expect(claim).not.toBeNull();
    const redis = await getRedisClient();
    const lease = (await scanAllKeys()).find(key => key.includes(":lease:"));
    expect(lease).toBeTruthy();
    await redis.del(lease!);

    await expect(completeMessengerPrivacyErasureJob(claim!)).rejects.toThrow(
      "lease was lost"
    );
    await expect(getMessengerPrivacyErasurePendingCount()).resolves.toBe(1);
  });

  it("continues past leased and corrupt due jobs without starving healthy work", async () => {
    const scope = {
      workspaceId: 63,
      channelConnectionId: 11,
      pageId: "page-fair-erasure",
      bindingEpoch: 5,
      userKey: "privacy_user_key_fairness_12345",
      oldPrivacyEpoch: 9,
    };
    const jobIds = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        enqueueMessengerPrivacyErasureJob({
          psid: `fair-erasure-psid-${index}`,
          scope,
          now: 3_000,
        })
      )
    );
    const sortedJobIds = [...jobIds].sort();
    const heldClaims = await Promise.all(
      sortedJobIds
        .slice(0, 10)
        .map(jobId => claimMessengerPrivacyErasureJob(jobId, 3_000))
    );
    expect(heldClaims.every(Boolean)).toBe(true);

    const redis = await getRedisClient();
    const corruptJobId = sortedJobIds[10]!;
    const corruptKey = (await scanAllKeys()).find(key =>
      key.endsWith(`:job:${corruptJobId}`)
    );
    expect(corruptKey).toBeTruthy();
    await redis.set(corruptKey!, "not-json");

    const claims = await claimDueMessengerPrivacyErasureJobs(3_000, 1);
    expect(claims).toHaveLength(1);
    expect(claims[0]?.job.jobId).toBe(sortedJobIds[11]);
    await completeMessengerPrivacyErasureJob(claims[0]!);

    // Held and unreadable work remains durable; only the healthy item completes.
    await expect(getMessengerPrivacyErasurePendingCount()).resolves.toBe(11);
  });

  it("does not orphan job content when the pending registry has an invalid type", async () => {
    const seedId = await enqueueMessengerPrivacyErasureJob({
      psid: "privacy-erasure-key-discovery",
      scope: {
        workspaceId: 64,
        channelConnectionId: 12,
        pageId: "page-failure-point",
        bindingEpoch: 2,
        userKey: "privacy_user_key_failure_point_12",
        oldPrivacyEpoch: 3,
      },
      now: 4_000,
    });
    expect(seedId).toMatch(/^[a-f0-9]{64}$/);
    const pendingKey = (await scanAllKeys()).find(key =>
      key.endsWith(":pending")
    );
    expect(pendingKey).toBeTruthy();

    const redis = await getRedisClient();
    await redis.eval("return redis.call('FLUSHDB')", 0);
    await redis.set(pendingKey!, "wrong-type");

    await expect(
      enqueueMessengerPrivacyErasureJob({
        psid: "privacy-erasure-must-not-orphan",
        scope: {
          workspaceId: 64,
          channelConnectionId: 12,
          pageId: "page-failure-point",
          bindingEpoch: 2,
          userKey: "privacy_user_key_failure_point_12",
          oldPrivacyEpoch: 3,
        },
        now: 4_100,
      })
    ).rejects.toThrow();

    expect((await scanAllKeys()).filter(key => key.includes(":job:"))).toEqual(
      []
    );
  });

  it("claims due work fairly across tenant connections", async () => {
    for (let index = 0; index < 10; index += 1) {
      await enqueueMessengerPrivacyErasureJob({
        psid: `busy-tenant-privacy-user-${index}`,
        scope: {
          workspaceId: 71,
          channelConnectionId: 17,
          pageId: "page-busy-tenant",
          bindingEpoch: 2,
          userKey: "privacy_user_key_busy_tenant_123",
          oldPrivacyEpoch: 3,
        },
        now: 5_000,
      });
    }
    await enqueueMessengerPrivacyErasureJob({
      psid: "quiet-tenant-privacy-user",
      scope: {
        workspaceId: 72,
        channelConnectionId: 18,
        pageId: "page-quiet-tenant",
        bindingEpoch: 2,
        userKey: "privacy_user_key_quiet_tenant_12",
        oldPrivacyEpoch: 3,
      },
      now: 5_001,
    });

    const claims = await claimDueMessengerPrivacyErasureJobs(6_000, 2);
    expect(claims).toHaveLength(2);
    expect(new Set(claims.map(claim => claim.job.workspaceId))).toEqual(
      new Set([71, 72])
    );
  });
});

async function scanAllKeys(): Promise<string[]> {
  const redis = await getRedisClient();
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", "*", "COUNT", 100);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function configureEncryptionKeys(
  activeKeyId: string,
  keys: Array<{ id: string; key: string }>
): void {
  process.env.MESSENGER_PRIVACY_ERASURE_ENCRYPTION_ACTIVE_KEY_ID = activeKeyId;
  process.env.MESSENGER_PRIVACY_ERASURE_ENCRYPTION_KEYS_JSON =
    JSON.stringify(keys);
}

function sealLegacyV1(
  job: {
    jobId: string;
    workspaceId: number;
    channelConnectionId: number;
    pageId: string;
    bindingEpoch: number;
    userKey: string;
    oldPrivacyEpoch: number;
  },
  psid: string
): string {
  const secret = process.env.JWT_SECRET ?? "";
  const key = createHmac("sha256", secret)
    .update("leaderbot.messenger-privacy-erasure.v1")
    .update("\0")
    .update("seal")
    .digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(
    Buffer.from(
      JSON.stringify({
        domain: "leaderbot.messenger-privacy-erasure.v1",
        jobId: job.jobId,
        workspaceId: job.workspaceId,
        channelConnectionId: job.channelConnectionId,
        pageId: job.pageId,
        bindingEpoch: job.bindingEpoch,
        userKey: job.userKey,
        oldPrivacyEpoch: job.oldPrivacyEpoch,
      }),
      "utf8"
    )
  );
  const ciphertext = Buffer.concat([
    cipher.update(psid, "utf8"),
    cipher.final(),
  ]);
  return `v1:${iv.toString("base64url")}:${cipher
    .getAuthTag()
    .toString("base64url")}:${ciphertext.toString("base64url")}`;
}
