import { createHash } from "node:crypto";

import {
  getMessengerRequestOwnership,
  getMessengerRequestPageId,
  getMessengerRequestPrivacySubject,
  getMessengerRequestChannel,
  type MessengerChannel,
} from "./messengerRequestContext";

export const MESSENGER_STORAGE_PREFIXES = [
  "inbound-source",
  "generated/images",
  "generated/videos",
] as const;

export type MessengerStorageObjectKind =
  "inbound_source" | "generated_image" | "generated_video";

export type MessengerStorageScope = Readonly<{
  workspaceId: number;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  /** HMAC-derived user key. A raw PSID must never enter an object key. */
  userKey: string;
}>;

export type MessengerStorageRequestScope = MessengerStorageScope &
  Readonly<{
    pageId: string;
    channel?: MessengerChannel;
  }>;

const USER_KEY_PATTERN = /^[a-f0-9]{64}$/u;
const LEGACY_OBJECT_KEY_PATTERN =
  /^(?:inbound-source|generated\/images|generated\/videos)\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/u;
const OBJECT_KEY_PATTERN =
  /^(inbound-source|generated\/images|generated\/videos)\/v1\/workspace-([1-9]\d*)\/connection-([1-9]\d*)\/binding-([1-9]\d*)\/privacy-([1-9]\d*)\/user-([a-f0-9]{64})\/([^/]+)$/u;
const IMAGE_FILE_PATTERN =
  /^[1-9]\d{9,15}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|webp)$/u;
const VIDEO_FILE_PATTERN =
  /^[1-9]\d{9,15}-[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.mp4$/u;

function assertPositiveId(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Messenger storage ${label} is invalid`);
  }
}

export function assertMessengerStorageScope(
  scope: MessengerStorageScope
): void {
  assertPositiveId(scope.workspaceId, "workspace scope");
  assertPositiveId(scope.channelConnectionId, "connection scope");
  assertPositiveId(scope.bindingEpoch, "binding epoch");
  assertPositiveId(scope.privacyEpoch, "privacy epoch");
  if (!USER_KEY_PATTERN.test(scope.userKey)) {
    throw new Error("Messenger storage user scope is invalid");
  }
}

export function formatMessengerStorageScope(
  scope: MessengerStorageScope
): string {
  assertMessengerStorageScope(scope);
  return [
    "v1",
    `workspace-${scope.workspaceId}`,
    `connection-${scope.channelConnectionId}`,
    `binding-${scope.bindingEpoch}`,
    `privacy-${scope.privacyEpoch}`,
    `user-${scope.userKey}`,
  ].join("/");
}

function prefixForKind(kind: MessengerStorageObjectKind): string {
  if (kind === "inbound_source") return "inbound-source";
  if (kind === "generated_image") return "generated/images";
  return "generated/videos";
}

function assertFileName(
  kind: MessengerStorageObjectKind,
  fileName: string
): void {
  const matches =
    kind === "generated_video"
      ? VIDEO_FILE_PATTERN.test(fileName)
      : IMAGE_FILE_PATTERN.test(fileName);
  if (!matches || fileName === "." || fileName === "..") {
    throw new Error("Messenger storage object filename is invalid");
  }
}

export function buildMessengerStorageObjectKey(input: {
  kind: MessengerStorageObjectKind;
  scope: MessengerStorageScope;
  fileName: string;
}): string {
  assertFileName(input.kind, input.fileName);
  return `${prefixForKind(input.kind)}/${formatMessengerStorageScope(input.scope)}/${input.fileName}`;
}

export function parseMessengerStorageObjectKey(objectKey: string): Readonly<{
  kind: MessengerStorageObjectKind;
  scope: MessengerStorageScope;
  fileName: string;
}> | null {
  if (
    !objectKey ||
    objectKey.trim() !== objectKey ||
    objectKey.includes("\\") ||
    objectKey.includes("\0") ||
    objectKey.includes("%") ||
    objectKey.length > 512
  ) {
    return null;
  }
  const match = OBJECT_KEY_PATTERN.exec(objectKey);
  if (!match) return null;
  const kind: MessengerStorageObjectKind =
    match[1] === "inbound-source"
      ? "inbound_source"
      : match[1] === "generated/images"
        ? "generated_image"
        : "generated_video";
  const scope: MessengerStorageScope = {
    workspaceId: Number(match[2]),
    channelConnectionId: Number(match[3]),
    bindingEpoch: Number(match[4]),
    privacyEpoch: Number(match[5]),
    userKey: match[6],
  };
  try {
    assertMessengerStorageScope(scope);
    assertFileName(kind, match[7]);
  } catch {
    return null;
  }
  return { kind, scope, fileName: match[7] };
}

export function messengerStorageObjectMatchesScope(
  objectKey: string,
  expectedScope: MessengerStorageScope
): boolean {
  const parsed = parseMessengerStorageObjectKey(objectKey);
  if (!parsed) return false;
  const actual = parsed.scope;
  return (
    actual.workspaceId === expectedScope.workspaceId &&
    actual.channelConnectionId === expectedScope.channelConnectionId &&
    actual.bindingEpoch === expectedScope.bindingEpoch &&
    actual.privacyEpoch === expectedScope.privacyEpoch &&
    actual.userKey === expectedScope.userKey
  );
}

export function isMessengerStorageLegacyBridgeEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" ||
    process.env.STORAGE_ALLOW_LEGACY_KEYS === "true"
  );
}

export function isLegacyMessengerStorageObjectKey(objectKey: string): boolean {
  return LEGACY_OBJECT_KEY_PATTERN.test(objectKey);
}

/**
 * Accepts an immutable scoped key only for its exact owner. Unscoped keys are
 * limited to the explicit migration bridge (and tests/development), matching
 * the storage proxy authorization policy.
 */
export function messengerStorageObjectIsAllowedForScope(
  objectKey: string,
  expectedScope: MessengerStorageScope
): boolean {
  const parsed = parseMessengerStorageObjectKey(objectKey);
  if (parsed) {
    return messengerStorageObjectMatchesScope(objectKey, expectedScope);
  }
  return (
    isMessengerStorageLegacyBridgeEnabled() &&
    isLegacyMessengerStorageObjectKey(objectKey)
  );
}

export function getMessengerStorageRequestScope(): MessengerStorageRequestScope | null {
  const ownership = getMessengerRequestOwnership();
  const privacy = getMessengerRequestPrivacySubject();
  const pageId = getMessengerRequestPageId()?.trim();
  const channel = getMessengerRequestChannel();
  if (!ownership || !privacy || !pageId) return null;
  const scope = { ...ownership, ...privacy };
  assertMessengerStorageScope(scope);
  return { ...scope, pageId, ...(channel ? { channel } : {}) };
}

export function hashStorageObjectKeyForLog(objectKey: string): string {
  return createHash("sha256").update(objectKey).digest("hex").slice(0, 16);
}
