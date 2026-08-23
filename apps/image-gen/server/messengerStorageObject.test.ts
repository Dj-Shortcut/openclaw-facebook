import { afterEach, describe, expect, it } from "vitest";

import {
  buildMessengerStorageObjectKey,
  formatMessengerStorageScope,
  messengerStorageObjectIsAllowedForScope,
  messengerStorageObjectMatchesScope,
  parseMessengerStorageObjectKey,
} from "./_core/messengerStorageObject";

const scope = {
  workspaceId: 42,
  channelConnectionId: 7,
  bindingEpoch: 3,
  privacyEpoch: 5,
  userKey: "a".repeat(64),
};
const originalNodeEnv = process.env.NODE_ENV;
const originalLegacyKeys = process.env.STORAGE_ALLOW_LEGACY_KEYS;

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  if (originalLegacyKeys === undefined) {
    delete process.env.STORAGE_ALLOW_LEGACY_KEYS;
  } else {
    process.env.STORAGE_ALLOW_LEGACY_KEYS = originalLegacyKeys;
  }
});

describe("Messenger storage object namespace", () => {
  it("round-trips every immutable tenant and privacy boundary", () => {
    const key = buildMessengerStorageObjectKey({
      kind: "generated_image",
      scope,
      fileName: "1787461200000-123e4567-e89b-42d3-a456-426614174000.png",
    });

    expect(key).toBe(
      `generated/images/${formatMessengerStorageScope(scope)}/1787461200000-123e4567-e89b-42d3-a456-426614174000.png`
    );
    expect(parseMessengerStorageObjectKey(key)).toEqual({
      kind: "generated_image",
      scope,
      fileName: "1787461200000-123e4567-e89b-42d3-a456-426614174000.png",
    });
    expect(messengerStorageObjectMatchesScope(key, scope)).toBe(true);
    expect(
      messengerStorageObjectMatchesScope(key, {
        ...scope,
        workspaceId: scope.workspaceId + 1,
      })
    ).toBe(false);
  });

  it.each([
    "generated/images/../../another-tenant/result.png",
    "generated/images/%2e%2e/result.png",
    "generated/images/v1/workspace-42/connection-7/binding-3/privacy-5/user-short/result.png",
    `unknown/v1/workspace-42/connection-7/binding-3/privacy-5/user-${"a".repeat(64)}/result.png`,
  ])("rejects an unsafe or incomplete object key: %s", key => {
    expect(parseMessengerStorageObjectKey(key)).toBeNull();
  });

  it("allows only the exact owner, with legacy keys confined to the bridge", () => {
    const ownKey = buildMessengerStorageObjectKey({
      kind: "generated_image",
      scope,
      fileName: "1787461200000-123e4567-e89b-42d3-a456-426614174000.png",
    });
    expect(messengerStorageObjectIsAllowedForScope(ownKey, scope)).toBe(true);
    expect(
      messengerStorageObjectIsAllowedForScope(ownKey, {
        ...scope,
        privacyEpoch: scope.privacyEpoch + 1,
      })
    ).toBe(false);

    process.env.NODE_ENV = "production";
    delete process.env.STORAGE_ALLOW_LEGACY_KEYS;
    expect(
      messengerStorageObjectIsAllowedForScope(
        "generated/images/legacy.png",
        scope
      )
    ).toBe(false);
    process.env.STORAGE_ALLOW_LEGACY_KEYS = "true";
    expect(
      messengerStorageObjectIsAllowedForScope(
        "generated/images/legacy.png",
        scope
      )
    ).toBe(true);
  });
});
