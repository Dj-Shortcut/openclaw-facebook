import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { storageDeleteMock } = vi.hoisted(() => ({
  storageDeleteMock: vi.fn(async () => undefined),
}));

vi.mock("./storage", () => ({
  storageDelete: storageDeleteMock,
  storageKeyFromPublicUrl: (publicUrl: string) => {
    try {
      return new URL(publicUrl).pathname.replace(/^\/+/, "") || null;
    } catch {
      return null;
    }
  },
}));

import {
  deleteFaceMemoryForUser,
  expireFaceMemory,
  updateConsentedFaceMemorySource,
} from "./_core/faceMemory";
import { getFaceMemoryRetentionDays } from "./_core/faceMemoryRetention";
import {
  getState,
  rememberFaceSourceImage,
  resetStateStore,
  setPendingStoredImage,
} from "./_core/messengerState";
import { writeState } from "./_core/stateStore";

describe("face memory deletion", () => {
  const originalPrivacyPepper = process.env.PRIVACY_PEPPER;
  const originalEnableFaceMemory = process.env.ENABLE_FACE_MEMORY;
  const originalFaceMemoryRetentionDays = process.env.FACE_MEMORY_RETENTION_DAYS;

  beforeEach(() => {
    process.env.PRIVACY_PEPPER = "ci-test-pepper";
    delete process.env.FACE_MEMORY_RETENTION_DAYS;
    resetStateStore();
    storageDeleteMock.mockClear();
  });

  afterEach(() => {
    resetStateStore();
    if (originalPrivacyPepper === undefined) {
      delete process.env.PRIVACY_PEPPER;
    } else {
      process.env.PRIVACY_PEPPER = originalPrivacyPepper;
    }
    if (originalEnableFaceMemory === undefined) {
      delete process.env.ENABLE_FACE_MEMORY;
    } else {
      process.env.ENABLE_FACE_MEMORY = originalEnableFaceMemory;
    }
    if (originalFaceMemoryRetentionDays === undefined) {
      delete process.env.FACE_MEMORY_RETENTION_DAYS;
    } else {
      process.env.FACE_MEMORY_RETENTION_DAYS = originalFaceMemoryRetentionDays;
    }
  });

  it("deletes active retained face-memory source data", async () => {
    const sourceUrl = "https://assets.example/generated/face-source.jpg";
    await rememberFaceSourceImage("user-1", sourceUrl, Date.now());

    await deleteFaceMemoryForUser("user-1");

    const state = await getState("user-1");
    expect(storageDeleteMock).toHaveBeenCalledWith("generated/face-source.jpg");
    expect(state?.faceMemoryConsent).toBeNull();
    expect(state?.lastSourceImageUrl).toBeNull();
    expect(state?.lastSourceImageUpdatedAt).toBeNull();
    expect(state?.lastPhotoUrl).toBeNull();
    expect(state?.pendingSourceImageDeleteUrl).toBeNull();
  });

  it("does not delete unrelated photo state when no face-memory source is active", async () => {
    const sessionPhotoUrl = "https://assets.example/generated/session-photo.jpg";
    await setPendingStoredImage("user-2", sessionPhotoUrl, Date.now());

    await deleteFaceMemoryForUser("user-2");

    const state = await getState("user-2");
    expect(storageDeleteMock).not.toHaveBeenCalled();
    expect(state?.faceMemoryConsent).toBeNull();
    expect(state?.lastSourceImageUrl).toBeNull();
    expect(state?.lastSourceImageUpdatedAt).toBeNull();
    expect(state?.pendingSourceImageDeleteUrl).toBeNull();
  });

  it("records a pending delete marker when retained source deletion fails", async () => {
    const sourceUrl = "https://assets.example/generated/face-source-fail.jpg";
    storageDeleteMock.mockRejectedValueOnce(new Error("storage unavailable"));
    await rememberFaceSourceImage("user-3", sourceUrl, Date.now());

    await deleteFaceMemoryForUser("user-3");

    const state = await getState("user-3");
    expect(storageDeleteMock).toHaveBeenCalledWith("generated/face-source-fail.jpg");
    expect(state?.faceMemoryConsent).toBeNull();
    expect(state?.lastSourceImageUrl).toBeNull();
    expect(state?.lastSourceImageUpdatedAt).toBeNull();
    expect(state?.lastPhotoUrl).toBeNull();
    expect(state?.pendingSourceImageDeleteUrl).toBe(sourceUrl);
  });

  it("preserves existing pending delete markers during user deletion", async () => {
    const pendingUrl = "https://assets.example/generated/pending-source.jpg";
    storageDeleteMock.mockRejectedValueOnce(new Error("still unavailable"));
    writeState("user-4", {
      pendingSourceImageDeleteUrl: pendingUrl,
    });

    await deleteFaceMemoryForUser("user-4");

    const state = await getState("user-4");
    expect(storageDeleteMock).toHaveBeenCalledWith("generated/pending-source.jpg");
    expect(state?.pendingSourceImageDeleteUrl).toBe(pendingUrl);
  });

  it("runs retention cleanup even when new face-memory capture is disabled", async () => {
    delete process.env.ENABLE_FACE_MEMORY;
    const oldSourceUrl = "https://assets.example/generated/old-source.jpg";
    const now = Date.now();
    writeState("user-5", {
      faceMemoryConsent: { given: true, timestamp: now - 40, version: "v1" },
      lastSourceImageUrl: oldSourceUrl,
      lastSourceImageUpdatedAt: now - 31 * 24 * 60 * 60 * 1000,
    });

    const deleted = await expireFaceMemory(now);

    const state = await getState("user-5");
    expect(deleted).toBe(1);
    expect(storageDeleteMock).toHaveBeenCalledWith("generated/old-source.jpg");
    expect(state?.faceMemoryConsent).toBeNull();
    expect(state?.lastSourceImageUrl).toBeNull();
  });

  it("backfills deletion for expired inbound source session images", async () => {
    const sourceUrl = "https://assets.example/inbound-source/session-source.jpg";
    const now = Date.now();
    writeState("user-stale-session-source", {
      lastPhotoUrl: sourceUrl,
      lastPhoto: sourceUrl,
      lastPhotoSource: "stored",
      pendingImageUrl: sourceUrl,
      pendingImageAt: now - 31 * 24 * 60 * 60 * 1000,
    });

    const deleted = await expireFaceMemory(now);

    const state = await getState("user-stale-session-source");
    expect(deleted).toBe(1);
    expect(storageDeleteMock).toHaveBeenCalledWith(
      "inbound-source/session-source.jpg"
    );
    expect(state?.lastPhotoUrl).toBeNull();
    expect(state?.pendingImageUrl).toBeUndefined();
    expect(state?.pendingSourceImageDeleteUrl).toBeNull();
  });

  it("does not delete fresh inbound source session images", async () => {
    const sourceUrl = "https://assets.example/inbound-source/fresh-source.jpg";
    const now = Date.now();
    writeState("user-fresh-session-source", {
      lastPhotoUrl: sourceUrl,
      lastPhoto: sourceUrl,
      lastPhotoSource: "stored",
      pendingImageUrl: sourceUrl,
      pendingImageAt: now - 29 * 24 * 60 * 60 * 1000,
    });

    const deleted = await expireFaceMemory(now);

    const state = await getState("user-fresh-session-source");
    expect(deleted).toBe(0);
    expect(storageDeleteMock).not.toHaveBeenCalled();
    expect(state?.lastPhotoUrl).toBe(sourceUrl);
    expect(state?.pendingImageUrl).toBe(sourceUrl);
  });

  it("does not delete generated image URLs during inbound source cleanup", async () => {
    const generatedUrl = "https://assets.example/generated/session-output.jpg";
    const now = Date.now();
    writeState("user-stale-generated-session", {
      lastPhotoUrl: generatedUrl,
      lastPhoto: generatedUrl,
      lastPhotoSource: "stored",
      pendingImageUrl: generatedUrl,
      pendingImageAt: now - 31 * 24 * 60 * 60 * 1000,
    });

    const deleted = await expireFaceMemory(now);

    const state = await getState("user-stale-generated-session");
    expect(deleted).toBe(0);
    expect(storageDeleteMock).not.toHaveBeenCalled();
    expect(state?.lastPhotoUrl).toBe(generatedUrl);
  });

  it("records a pending delete marker when expired inbound source cleanup fails", async () => {
    const sourceUrl = "https://assets.example/inbound-source/stale-fail.jpg";
    const now = Date.now();
    storageDeleteMock.mockRejectedValueOnce(new Error("storage unavailable"));
    writeState("user-stale-session-source-fail", {
      lastPhotoUrl: sourceUrl,
      lastPhoto: sourceUrl,
      lastPhotoSource: "stored",
      pendingImageUrl: sourceUrl,
      pendingImageAt: now - 31 * 24 * 60 * 60 * 1000,
    });

    const deleted = await expireFaceMemory(now);

    const state = await getState("user-stale-session-source-fail");
    expect(deleted).toBe(1);
    expect(storageDeleteMock).toHaveBeenCalledWith("inbound-source/stale-fail.jpg");
    expect(state?.lastPhotoUrl).toBeNull();
    expect(state?.pendingSourceImageDeleteUrl).toBe(sourceUrl);
  });

  it("uses FACE_MEMORY_RETENTION_DAYS when expiring retained source data", async () => {
    process.env.FACE_MEMORY_RETENTION_DAYS = "7";
    const oldSourceUrl = "https://assets.example/generated/env-retention-source.jpg";
    const now = Date.now();
    writeState("user-env-retention", {
      faceMemoryConsent: { given: true, timestamp: now, version: "v1" },
      lastSourceImageUrl: oldSourceUrl,
      lastSourceImageUpdatedAt: now - 8 * 24 * 60 * 60 * 1000,
    });

    const deleted = await expireFaceMemory(now);

    expect(deleted).toBe(1);
    expect(storageDeleteMock).toHaveBeenCalledWith("generated/env-retention-source.jpg");
  });

  it("falls back to 30 retention days for invalid FACE_MEMORY_RETENTION_DAYS", () => {
    process.env.FACE_MEMORY_RETENTION_DAYS = "not-a-number";

    expect(getFaceMemoryRetentionDays()).toBe(30);
  });

  it("clears consent-only records during match-all cleanup", async () => {
    const now = Date.now();
    writeState("user-6", {
      faceMemoryConsent: { given: true, timestamp: now, version: "v1" },
    });

    await expireFaceMemory(now, { force: true, matchAll: true });

    const state = await getState("user-6");
    expect(storageDeleteMock).not.toHaveBeenCalled();
    expect(state?.faceMemoryConsent).toBeNull();
    expect(state?.lastSourceImageUrl).toBeNull();
  });

  it("preserves failed old-source delete marker when rotating retained source", async () => {
    process.env.ENABLE_FACE_MEMORY = "true";
    const oldSourceUrl = "https://assets.example/generated/old-rotate-source.jpg";
    const newSourceUrl = "https://assets.example/generated/new-rotate-source.jpg";
    await rememberFaceSourceImage("user-7", oldSourceUrl, Date.now());
    storageDeleteMock.mockRejectedValueOnce(new Error("old source unavailable"));

    await updateConsentedFaceMemorySource("user-7", newSourceUrl);

    const state = await getState("user-7");
    expect(storageDeleteMock).toHaveBeenCalledWith("generated/old-rotate-source.jpg");
    expect(state?.lastSourceImageUrl).toBe(newSourceUrl);
    expect(state?.pendingSourceImageDeleteUrl).toBe(oldSourceUrl);
  });
});
