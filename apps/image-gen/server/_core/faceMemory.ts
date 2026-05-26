import type express from "express";
import {
  clearFaceMemoryState,
  getState,
  getOrCreateState,
  rememberFaceSourceImage,
  setPendingSourceImageDeleteUrl,
  type MessengerUserState,
} from "./messengerState";
import { forEachStoredState } from "./stateStore";
import { storageDelete, storageKeyFromPublicUrl } from "../storage";
import { createAdminAuthRateLimiter, verifyAdminToken } from "./adminAuth";
import { getFaceMemoryRetentionMs } from "./faceMemoryRetention";
import { safeLog } from "./messengerApi";

export const FACE_MEMORY_CONSENT_YES = "CONSENT_FACE_YES";
export const FACE_MEMORY_CONSENT_NO = "CONSENT_FACE_NO";

export function isFaceMemoryEnabled(): boolean {
  return process.env.ENABLE_FACE_MEMORY === "true";
}

async function deleteStoredImageUrl(imageUrl: string | null | undefined): Promise<boolean> {
  if (!imageUrl) {
    return true;
  }

  const key = storageKeyFromPublicUrl(imageUrl);
  if (!key) {
    return true;
  }

  try {
    await storageDelete(key);
    return true;
  } catch (error) {
    safeLog("face_memory_storage_delete_failed", {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function deleteFaceMemoryForUser(psid: string): Promise<void> {
  const state = await getState(psid);
  if (!state) {
    return;
  }

  const urlsToDelete = [
    state.pendingSourceImageDeleteUrl,
    state.lastSourceImageUrl,
  ].filter((url): url is string => Boolean(url));
  let pendingDeleteUrl: string | null = null;

  for (const imageUrl of new Set(urlsToDelete)) {
    const deleted = await deleteStoredImageUrl(imageUrl);
    if (!deleted && !pendingDeleteUrl) {
      pendingDeleteUrl = imageUrl;
    }
  }

  await clearFaceMemoryState(psid, Date.now(), pendingDeleteUrl);
}

export async function expireFaceMemory(
  now = Date.now(),
  options: { force?: boolean; matchAll?: boolean } = {}
): Promise<number> {
  const finiteNow = Number.isFinite(now) ? now : Date.now();
  const expiredBefore = options.matchAll
    ? Number.POSITIVE_INFINITY
    : finiteNow - getFaceMemoryRetentionMs();
  let deletedCount = 0;

  await forEachStoredState<Partial<MessengerUserState>>(async (psid, state) => {
    if (state.pendingSourceImageDeleteUrl) {
      const retryDeleted = await deleteStoredImageUrl(state.pendingSourceImageDeleteUrl);
      if (retryDeleted) {
        await clearFaceMemoryState(psid, finiteNow);
      }
      return;
    }

    const updatedAt = state.lastSourceImageUpdatedAt;
    const shouldClear = options.matchAll
      ? Boolean(state.faceMemoryConsent || state.lastSourceImageUrl)
      : Boolean(updatedAt && updatedAt < expiredBefore);

    if (!shouldClear) {
      return;
    }

    const deleted = await deleteStoredImageUrl(state.lastSourceImageUrl);
    await clearFaceMemoryState(
      psid,
      finiteNow,
      deleted ? null : state.lastSourceImageUrl ?? null
    );
    deletedCount += 1;
  });

  return deletedCount;
}

export async function updateConsentedFaceMemorySource(
  psid: string,
  imageUrl: string
): Promise<void> {
  if (!isFaceMemoryEnabled()) {
    return;
  }

  const state = await getOrCreateState(psid);
  if (state.faceMemoryConsent?.given) {
    const deleted = await deleteStoredImageUrl(state.lastSourceImageUrl);
    await rememberFaceSourceImage(psid, imageUrl);
    if (!deleted && state.lastSourceImageUrl) {
      await setPendingSourceImageDeleteUrl(psid, state.lastSourceImageUrl);
    }
  }
}

export function registerFaceMemoryAdminRoutes(app: express.Express): void {
  app.post(
    "/admin/disable-face-memory",
    createAdminAuthRateLimiter({
      eventName: "face_memory_kill_switch_auth_rate_limited",
    }),
    async (req, res) => {
      if (
        !verifyAdminToken({
          providedToken: req.header("x-admin-token"),
          eventName: "face_memory_kill_switch_auth_failed",
        })
      ) {
        res.sendStatus(403);
        return;
      }

      const deleted = await expireFaceMemory(Date.now(), {
        force: true,
        matchAll: true,
      });
      safeLog("face_memory_kill_switch_success", { deleted });
      res.status(200).json({ ok: true, deleted });
    }
  );
}

export function scheduleFaceMemoryExpiry(): void {
  const run = () => {
    expireFaceMemory().catch(error => {
      safeLog("face_memory_expiry_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };

  run();
  const timer = setInterval(run, 24 * 60 * 60 * 1000);
  timer.unref();
}
