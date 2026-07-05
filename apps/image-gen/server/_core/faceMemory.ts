import type express from "express";
import rateLimit from "express-rate-limit";
import {
  clearPendingSourceImageDeleteUrls,
  clearFaceMemoryState,
  getState,
  getOrCreateState,
  rememberFaceSourceImage,
  setPendingSourceImageDeleteUrl,
  setPendingSourceImageDeleteUrls,
  type MessengerUserState,
} from "./messengerState";
import { forEachStoredState } from "./stateStore";
import { storageDelete, storageKeyFromPublicUrl } from "../storage";
import { createAdminAuthRateLimiter, verifyAdminToken } from "./adminAuth";
import { getFaceMemoryRetentionMs } from "./faceMemoryRetention";
import { safeLog } from "./messengerApi";

export const FACE_MEMORY_CONSENT_YES = "CONSENT_FACE_YES";
export const FACE_MEMORY_CONSENT_NO = "CONSENT_FACE_NO";
const INBOUND_SOURCE_PREFIX = "inbound-source/";

const faceMemoryAdminRouteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
});

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

function getInboundSourceUrl(imageUrl: string | null | undefined): string | null {
  if (!imageUrl) {
    return null;
  }

  const key = storageKeyFromPublicUrl(imageUrl);
  if (!key?.startsWith(INBOUND_SOURCE_PREFIX)) {
    return null;
  }

  return imageUrl;
}

function getExpiredInboundSourceUrls(
  state: Partial<MessengerUserState>,
  expiredBefore: number
): string[] {
  const hasRetainedSource = Boolean(
    state.faceMemoryConsent?.given && state.lastSourceImageUrl
  );
  const candidates = [state.lastPhotoUrl, state.pendingImageUrl].map(url => {
    const inboundSourceUrl = getInboundSourceUrl(url);
    const isRetainedSource =
      hasRetainedSource && inboundSourceUrl === state.lastSourceImageUrl;
    const timestamp = isRetainedSource
      ? state.lastSourceImageUpdatedAt ?? state.pendingImageAt ?? state.updatedAt
      : state.pendingImageAt ?? state.lastSourceImageUpdatedAt ?? state.updatedAt;
    return { url: inboundSourceUrl, timestamp };
  });

  return Array.from(
    new Set(
      candidates
        .filter(candidate => candidate.timestamp && candidate.timestamp < expiredBefore)
        .map(candidate => candidate.url)
        .filter((url): url is string => Boolean(url))
    )
  );
}

function getPendingSourceDeleteUrls(
  state: Partial<MessengerUserState>
): string[] {
  return Array.from(
    new Set(
      [
        state.pendingSourceImageDeleteUrl,
        ...(state.pendingSourceImageDeleteUrls ?? []),
      ].filter((url): url is string => Boolean(url))
    )
  );
}

export async function deleteFaceMemoryForUser(psid: string): Promise<void> {
  const state = await getState(psid);
  if (!state) {
    return;
  }

  const urlsToDelete = [
    ...getPendingSourceDeleteUrls(state),
    state.lastSourceImageUrl,
  ].filter((url): url is string => Boolean(url));
  const failedDeleteUrls: string[] = [];

  for (const imageUrl of new Set(urlsToDelete)) {
    const deleted = await deleteStoredImageUrl(imageUrl);
    if (!deleted) {
      failedDeleteUrls.push(imageUrl);
    }
  }

  await clearFaceMemoryState(
    psid,
    Date.now(),
    failedDeleteUrls[0] ?? null,
    failedDeleteUrls
  );
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
    const pendingDeleteUrls = getPendingSourceDeleteUrls(state);
    const expiredInboundSourceUrls = options.matchAll
      ? []
      : getExpiredInboundSourceUrls(state, expiredBefore);
    const updatedAt = state.lastSourceImageUpdatedAt;
    const shouldClear = options.matchAll
      ? Boolean(state.faceMemoryConsent || state.lastSourceImageUrl)
      : Boolean(updatedAt && updatedAt < expiredBefore);

    if (
      pendingDeleteUrls.length === 0 &&
      !shouldClear &&
      expiredInboundSourceUrls.length === 0
    ) {
      return;
    }

    const urlsToDelete = Array.from(
      new Set([
        ...pendingDeleteUrls,
        ...(shouldClear ? [state.lastSourceImageUrl] : []),
        ...expiredInboundSourceUrls,
      ].filter((url): url is string => Boolean(url)))
    );
    const failedDeleteUrls: string[] = [];
    for (const imageUrl of urlsToDelete) {
      const deleted = await deleteStoredImageUrl(imageUrl);
      if (!deleted) {
        failedDeleteUrls.push(imageUrl);
      }
    }

    if (!shouldClear && expiredInboundSourceUrls.length === 0) {
      if (failedDeleteUrls.length) {
        await setPendingSourceImageDeleteUrls(psid, failedDeleteUrls, finiteNow);
      } else {
        await clearPendingSourceImageDeleteUrls(psid, finiteNow);
      }
      return;
    }

    await clearFaceMemoryState(
      psid,
      finiteNow,
      failedDeleteUrls[0] ?? null,
      failedDeleteUrls
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
    faceMemoryAdminRouteLimiter,
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
