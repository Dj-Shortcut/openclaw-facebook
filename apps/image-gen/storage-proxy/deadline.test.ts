import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Redis } from "ioredis";

import {
  assertRequiredR2LifecycleRules,
  buildStorageRequestSignature,
  createSharedStorageRateLimitBackend,
  parseStorageObjectKey,
  runStorageOperationWithDeadline,
  StorageOperationTimeoutError,
  verifyStorageRequestAuthorization,
} from "./index.ts";

const scopedObjectKey = `generated/images/v1/workspace-42/connection-7/binding-3/privacy-5/user-${"a".repeat(64)}/1787461200000-123e4567-e89b-42d3-a456-426614174000.png`;

function buildTestConfig(
  rateLimitKeySecret = "test-rate-limit-secret-at-least-32-bytes"
) {
  return {
    forgeApiKey: "test-storage-secret",
    publicBaseUrl: "https://assets.example",
    r2Bucket: "test-bucket",
    r2Endpoint: "https://127.0.0.1.invalid",
    r2AccessKeyId: "access",
    r2SecretAccessKey: "secret",
    port: 0,
    maxUploadBytes: 1024,
    storageOperationTimeoutMs: 20,
    allowLegacyBearerAuth: false,
    allowLegacyObjectKeys: false,
    rateLimitRedisUrl: "redis://127.0.0.1:6379/13",
    rateLimitKeySecret,
    trustFlyClientIp: false,
  };
}

async function listenOnLoopback(app: import("express").Express): Promise<{
  baseUrl: string;
  server: import("node:http").Server;
}> {
  const server = await new Promise<import("node:http").Server>(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { baseUrl: `http://127.0.0.1:${address.port}`, server };
}

function buildSignedStorageHeaders(
  method: string,
  objectKey = scopedObjectKey,
  apiKey = "test-storage-secret"
): Record<string, string> {
  const parsedKey = parseStorageObjectKey(objectKey);
  assert.ok(parsedKey);
  const expiresAt = Math.floor(Date.now() / 1_000) + 60;
  return {
    Authorization: `Bearer ${apiKey}`,
    "X-Leaderbot-Storage-Scope": parsedKey.authorizationScope,
    "X-Leaderbot-Storage-Expires": String(expiresAt),
    "X-Leaderbot-Storage-Signature": `v1=${buildStorageRequestSignature({
      apiKey,
      method,
      objectKey,
      scope: parsedKey.authorizationScope,
      expiresAt,
    })}`,
  };
}

async function closeServer(server: import("node:http").Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve()))
  );
}

test("a storage operation cannot outlive its configured deadline", async () => {
  let operationSignal: AbortSignal | undefined;
  let resolveRemote!: (value: string) => void;
  const remote = new Promise<string>(resolve => {
    resolveRemote = resolve;
  });

  const result = runStorageOperationWithDeadline(signal => {
    operationSignal = signal;
    return remote;
  }, 20);

  await assert.rejects(
    result,
    error =>
      error instanceof StorageOperationTimeoutError && error.timeoutMs === 20
  );
  assert.equal(operationSignal?.aborted, true);

  // A late provider completion cannot turn the already-terminal proxy result
  // into success. The Messenger object inventory stays ambiguous meanwhile.
  resolveRemote("late-success");
  await new Promise(resolve => setImmediate(resolve));
});

test("unsafe operation deadlines fail before contacting storage", async () => {
  let called = false;
  await assert.rejects(
    runStorageOperationWithDeadline(
      async () => {
        called = true;
        return "unreachable";
      },
      5 * 60_000 + 1
    ),
    /outside the safe range/
  );
  assert.equal(called, false);
});

test("startup requires the exact source and generated retention rules", () => {
  assert.doesNotThrow(() =>
    assertRequiredR2LifecycleRules([
      {
        ID: "expire-inbound-source-after-30-days",
        Status: "Enabled",
        Filter: { Prefix: "inbound-source/" },
        Expiration: { Days: 30 },
      },
      {
        ID: "expire-generated-images-after-30-days",
        Status: "Enabled",
        Filter: { Prefix: "generated/images/" },
        Expiration: { Days: 30 },
      },
      {
        ID: "expire-generated-videos-after-30-days",
        Status: "Enabled",
        Filter: { Prefix: "generated/videos/" },
        Expiration: { Days: 30 },
      },
    ])
  );
  assert.throws(
    () =>
      assertRequiredR2LifecycleRules([
        {
          ID: "expire-inbound-source-after-30-days",
          Status: "Disabled",
          Filter: { Prefix: "inbound-source/" },
          Expiration: { Days: 30 },
        },
      ]),
    /missing or unsafe/
  );
});

test("storage signatures bind method, exact key, scope, and short expiry", () => {
  const apiKey = "test-storage-secret";
  const parsedKey = parseStorageObjectKey(scopedObjectKey);
  assert.ok(parsedKey);
  const expiresAt = 1_787_461_260;
  const signature = buildStorageRequestSignature({
    apiKey,
    method: "POST",
    objectKey: scopedObjectKey,
    scope: parsedKey.authorizationScope,
    expiresAt,
  });
  const request = {
    apiKey,
    method: "POST",
    parsedKey,
    scopeHeader: parsedKey.authorizationScope,
    expiresHeader: String(expiresAt),
    signatureHeader: `v1=${signature}`,
    nowSeconds: expiresAt - 60,
  };

  assert.equal(verifyStorageRequestAuthorization(request), true);
  assert.equal(
    verifyStorageRequestAuthorization({ ...request, method: "DELETE" }),
    false
  );
  assert.equal(
    verifyStorageRequestAuthorization({
      ...request,
      scopeHeader: request.scopeHeader.replace("workspace-42", "workspace-43"),
    }),
    false
  );
  assert.equal(
    verifyStorageRequestAuthorization({
      ...request,
      nowSeconds: expiresAt + 6,
    }),
    false
  );
});

test("unknown prefixes, traversal, and unscoped keys fail closed", () => {
  assert.equal(
    parseStorageObjectKey("generated/images/../other/result.png"),
    null
  );
  assert.equal(
    parseStorageObjectKey("generated/images/%2e%2e/result.png"),
    null
  );
  assert.equal(parseStorageObjectKey("unknown/result.png"), null);
  assert.equal(parseStorageObjectKey("generated/images/legacy.png"), null);
  assert.equal(
    parseStorageObjectKey("generated/images/legacy.png", true)?.legacy,
    true
  );
});

test("proxy rejects unsigned, scope-mismatched, and traversal requests before R2", async () => {
  const apiKey = "test-storage-secret";
  const app = (await import("./index.ts")).createStorageProxyApp({
    forgeApiKey: apiKey,
    publicBaseUrl: "https://assets.example",
    r2Bucket: "test-bucket",
    r2Endpoint: "https://127.0.0.1.invalid",
    r2AccessKeyId: "access",
    r2SecretAccessKey: "secret",
    port: 0,
    maxUploadBytes: 1024,
    storageOperationTimeoutMs: 20,
    allowLegacyBearerAuth: false,
    allowLegacyObjectKeys: false,
    rateLimitRedisUrl: "redis://127.0.0.1:6379/13",
    rateLimitKeySecret: "test-rate-limit-secret-at-least-32-bytes",
    trustFlyClientIp: false,
  });
  const server = await new Promise<import("node:http").Server>(resolve => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const unsigned = await fetch(
      `${baseUrl}/v1/storage/downloadUrl?path=${encodeURIComponent(scopedObjectKey)}`,
      { headers: { Authorization: `Bearer ${apiKey}` } }
    );
    assert.equal(unsigned.status, 401);

    const parsedKey = parseStorageObjectKey(scopedObjectKey);
    assert.ok(parsedKey);
    const expiresAt = Math.floor(Date.now() / 1_000) + 60;
    const wrongScope = parsedKey.authorizationScope.replace(
      "workspace-42",
      "workspace-43"
    );
    const mismatched = await fetch(
      `${baseUrl}/v1/storage/downloadUrl?path=${encodeURIComponent(scopedObjectKey)}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "X-Leaderbot-Storage-Scope": wrongScope,
          "X-Leaderbot-Storage-Expires": String(expiresAt),
          "X-Leaderbot-Storage-Signature": `v1=${buildStorageRequestSignature({
            apiKey,
            method: "GET",
            objectKey: scopedObjectKey,
            scope: wrongScope,
            expiresAt,
          })}`,
        },
      }
    );
    assert.equal(mismatched.status, 403);

    const traversal = await fetch(
      `${baseUrl}/v1/storage/downloadUrl?path=${encodeURIComponent("generated/images/../../other/result.png")}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "X-Leaderbot-Storage-Scope": "legacy-v1",
          "X-Leaderbot-Storage-Expires": String(expiresAt),
          "X-Leaderbot-Storage-Signature": `v1=${"0".repeat(64)}`,
        },
      }
    );
    assert.equal(traversal.status, 400);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  }
});

for (const route of [
  { method: "POST", path: "/v1/storage/upload" },
  { method: "GET", path: "/v1/storage/downloadUrl" },
  { method: "DELETE", path: "/v1/storage/object" },
] as const) {
  test(`${route.method} ${route.path} is rate-limited before storage access`, async () => {
    const app = (await import("./index.ts")).createStorageProxyApp(
      buildTestConfig(),
      {
        windowMs: 60_000,
        authMaxRequests: 10,
        operationMaxRequests: 2,
      }
    );
    const { baseUrl, server } = await listenOnLoopback(app);
    try {
      const requestUrl = `${baseUrl}${route.path}?path=${encodeURIComponent(scopedObjectKey)}`;
      const headers = buildSignedStorageHeaders(route.method);

      const first = await fetch(requestUrl, { method: route.method, headers });
      const second = await fetch(requestUrl, { method: route.method, headers });
      const limited = await fetch(requestUrl, {
        method: route.method,
        headers,
      });

      assert.notEqual(first.status, 429);
      assert.notEqual(second.status, 429);
      assert.equal(limited.status, 429);
      assert.equal(limited.headers.get("retry-after"), "60");
      assert.deepEqual(await limited.json(), {
        error: "Too many storage requests",
      });

      const health = await fetch(`${baseUrl}/healthz`);
      assert.equal(health.status, 200);
    } finally {
      await closeServer(server);
    }
  });
}

test("the edge limiter ignores spoofed forwarding headers and keeps health live", async () => {
  const app = (await import("./index.ts")).createStorageProxyApp(
    buildTestConfig(),
    { authMaxRequests: 1, operationMaxRequests: 10 }
  );
  const { baseUrl, server } = await listenOnLoopback(app);
  try {
    const first = await fetch(`${baseUrl}/v1/storage/downloadUrl`, {
      headers: { "X-Forwarded-For": "198.51.100.10" },
    });
    const spoofed = await fetch(`${baseUrl}/v1/storage/downloadUrl`, {
      headers: { "X-Forwarded-For": "203.0.113.20" },
    });
    assert.equal(first.status, 401);
    assert.equal(spoofed.status, 429);

    const health = await fetch(`${baseUrl}/healthz`);
    assert.equal(health.status, 200);
    assert.equal(health.headers.get("x-content-type-options"), "nosniff");
    assert.equal(health.headers.get("x-powered-by"), null);
  } finally {
    await closeServer(server);
  }
});

test("production refuses to start without the shared Redis limiter", async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    const { createStorageProxyApp } = await import("./index.ts");
    assert.throws(
      () => createStorageProxyApp(buildTestConfig()),
      /requires shared Redis rate limiting/
    );
  } finally {
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  }
});

test("only verified tenant scopes get separate method-specific buckets", async () => {
  const app = (await import("./index.ts")).createStorageProxyApp(
    buildTestConfig(),
    { authMaxRequests: 20, operationMaxRequests: 1 }
  );
  const { baseUrl, server } = await listenOnLoopback(app);
  const secondWorkspaceKey = scopedObjectKey.replace(
    "workspace-42",
    "workspace-43"
  );
  try {
    const firstUpload = await fetch(
      `${baseUrl}/v1/storage/upload?path=${encodeURIComponent(scopedObjectKey)}`,
      { method: "POST", headers: buildSignedStorageHeaders("POST") }
    );
    assert.notEqual(firstUpload.status, 429);

    const forgedHeaders = buildSignedStorageHeaders("POST");
    forgedHeaders["X-Leaderbot-Storage-Scope"] = forgedHeaders[
      "X-Leaderbot-Storage-Scope"
    ].replace("workspace-42", "workspace-43");
    const forgedScope = await fetch(
      `${baseUrl}/v1/storage/upload?path=${encodeURIComponent(scopedObjectKey)}`,
      { method: "POST", headers: forgedHeaders }
    );
    assert.equal(forgedScope.status, 403);

    const limitedOriginalScope = await fetch(
      `${baseUrl}/v1/storage/upload?path=${encodeURIComponent(scopedObjectKey)}`,
      { method: "POST", headers: buildSignedStorageHeaders("POST") }
    );
    assert.equal(limitedOriginalScope.status, 429);

    const isolatedWorkspace = await fetch(
      `${baseUrl}/v1/storage/upload?path=${encodeURIComponent(secondWorkspaceKey)}`,
      {
        method: "POST",
        headers: buildSignedStorageHeaders("POST", secondWorkspaceKey),
      }
    );
    assert.notEqual(isolatedWorkspace.status, 429);

    const privacyDelete = await fetch(
      `${baseUrl}/v1/storage/object?path=${encodeURIComponent(scopedObjectKey)}`,
      { method: "DELETE", headers: buildSignedStorageHeaders("DELETE") }
    );
    assert.notEqual(privacyDelete.status, 429);
  } finally {
    await closeServer(server);
  }
});

test(
  "two proxy instances share Redis limits and fail closed on store outage",
  { skip: process.env.RUN_STORAGE_RATE_LIMIT_REDIS_INTEGRATION !== "1" },
  async () => {
    const redisUrl = process.env.STORAGE_RATE_LIMIT_REDIS_URL ?? "";
    const parsedRedisUrl = new URL(redisUrl);
    assert.equal(
      parsedRedisUrl.pathname,
      "/13",
      "the integration test may flush only dedicated Redis database 13"
    );
    const admin = new Redis(redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 0,
      enableOfflineQueue: false,
    });
    await admin.connect();
    await admin.flushdb();

    const backendA = await createSharedStorageRateLimitBackend(redisUrl);
    const backendB = await createSharedStorageRateLimitBackend(redisUrl);
    const rateLimitSecret = `integration-rate-limit-secret-${Date.now()}`;
    let storageRequestCount = 0;
    const storageServer = await new Promise<import("node:http").Server>(
      resolve => {
        const created = createServer((_req, res) => {
          storageRequestCount += 1;
          res.statusCode = 404;
          res.end();
        });
        created.listen(0, "127.0.0.1", () => resolve(created));
      }
    );
    const storageAddress = storageServer.address();
    assert.ok(storageAddress && typeof storageAddress !== "string");
    const config = {
      ...buildTestConfig(rateLimitSecret),
      r2Endpoint: `http://127.0.0.1:${storageAddress.port}`,
    };
    const appA = (await import("./index.ts")).createStorageProxyApp(config, {
      backend: backendA,
      windowMs: 150,
      authMaxRequests: 100,
      operationMaxRequests: 2,
    });
    const appB = (await import("./index.ts")).createStorageProxyApp(config, {
      backend: backendB,
      windowMs: 150,
      authMaxRequests: 100,
      operationMaxRequests: 2,
    });
    const firstServer = await listenOnLoopback(appA);
    const secondServer = await listenOnLoopback(appB);
    const path = `/v1/storage/upload?path=${encodeURIComponent(scopedObjectKey)}`;
    const request = (baseUrl: string) =>
      fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: buildSignedStorageHeaders("POST"),
      });

    try {
      assert.equal((await fetch(`${firstServer.baseUrl}/readyz`)).status, 200);
      assert.notEqual((await request(firstServer.baseUrl)).status, 429);
      assert.notEqual((await request(secondServer.baseUrl)).status, 429);
      assert.equal((await request(firstServer.baseUrl)).status, 429);

      const storedKeys = await admin.keys("leaderbot:storage-proxy:*");
      assert.ok(storedKeys.length > 0);
      for (const key of storedKeys) {
        assert.equal(key.includes("workspace-42"), false);
        assert.equal(key.includes("connection-7"), false);
        assert.equal(key.includes("127.0.0.1"), false);
        assert.equal(key.includes(scopedObjectKey), false);
        assert.equal(key.includes("a".repeat(64)), false);
      }

      await new Promise(resolve => setTimeout(resolve, 220));
      assert.notEqual((await request(secondServer.baseUrl)).status, 429);

      await backendA.close();
      assert.equal((await fetch(`${firstServer.baseUrl}/healthz`)).status, 200);
      assert.equal((await fetch(`${firstServer.baseUrl}/readyz`)).status, 503);
      const storageRequestsBeforeOutage = storageRequestCount;
      const deniedBeforeStorage = await fetch(
        `${firstServer.baseUrl}/v1/storage/downloadUrl?path=${encodeURIComponent(scopedObjectKey)}`,
        { headers: buildSignedStorageHeaders("GET") }
      );
      assert.equal(deniedBeforeStorage.status, 503);
      assert.equal(storageRequestCount, storageRequestsBeforeOutage);
    } finally {
      await closeServer(firstServer.server);
      await closeServer(secondServer.server);
      await closeServer(storageServer);
      await backendA.close();
      await backendB.close();
      await admin.flushdb();
      await admin.quit();
    }
  }
);
