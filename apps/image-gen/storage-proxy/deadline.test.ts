import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRequiredR2LifecycleRules,
  buildStorageRequestSignature,
  parseStorageObjectKey,
  runStorageOperationWithDeadline,
  StorageOperationTimeoutError,
  verifyStorageRequestAuthorization,
} from "./index.ts";

const scopedObjectKey = `generated/images/v1/workspace-42/connection-7/binding-3/privacy-5/user-${"a".repeat(64)}/1787461200000-123e4567-e89b-42d3-a456-426614174000.png`;

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
