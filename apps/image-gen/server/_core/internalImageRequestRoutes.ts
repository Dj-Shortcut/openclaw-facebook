import type { Express, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import {
  acceptInternalMessengerImageRequest,
  processFacebookWebhookPayload,
} from "./messengerWebhook";
import { safeLog } from "./logger";
import { isInternalMessengerImageRequestNotQueuedError } from "./internalImageRequestErrors";
import { MESSENGER_SEND_SKIPPED } from "./webhookFallback";
import type { MessengerSendOutcome } from "./messengerApi";
import {
  finalizeInternalAiAnswerQuota,
  getInternalAiAnswerQuotaReadiness,
  markInternalAiAnswerDeliveryStarted,
  markInternalAiAnswerDeliveryKnownRejected,
  heartbeatInternalAiAnswerReservation,
  reserveInternalAiAnswerQuota,
  safeInternalAiAnswerQuotaErrorCode,
} from "./internalAiAnswerQuota";

const internalImageRequestSchema = z.object({
  psid: z.string().trim().min(1),
  pageId: z.string().trim().min(1).max(160),
  prompt: z.string().trim().min(1).max(2_000),
  reqId: z.string().trim().min(1).max(128),
  lang: z.enum(["nl", "en"]).optional(),
  timestamp: z.number().int().positive().optional(),
  sourceImageUrl: z.string().trim().url().max(4_096).optional(),
});

const internalMessengerEventSchema = z.object({
  event: z
    .object({
      sender: z.object({ id: z.string().trim().min(1) }).optional(),
      recipient: z.object({ id: z.string().trim().min(1) }).optional(),
      timestamp: z.number().int().positive().optional(),
    })
    .passthrough(),
});

const internalAiAnswerQuotaReserveSchema = z.object({
  pageId: z.string().trim().min(1).max(160),
  idempotencyKey: z.string().regex(/^[A-Za-z0-9:_-]{16,160}$/),
  ownerToken: z.uuid(),
});

const internalAiAnswerQuotaFinalizeSchema = z.object({
  pageId: z.string().trim().min(1).max(160),
  reservationId: z.uuid(),
  ownerToken: z.uuid(),
  outcome: z.enum(["committed", "released"]),
});
const internalAiAnswerQuotaDeliveryStartedSchema = z.object({
  pageId: z.string().trim().min(1).max(160),
  reservationId: z.uuid(),
  ownerToken: z.uuid(),
  deliveryAttemptToken: z.uuid(),
});
const internalAiAnswerQuotaDeliveryKnownRejectedSchema =
  internalAiAnswerQuotaDeliveryStartedSchema;
const internalAiAnswerQuotaHeartbeatSchema = z.object({
  reservationId: z.uuid(),
  ownerToken: z.uuid(),
});

const internalMessengerRequestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1_000,
  standardHeaders: true,
  legacyHeaders: false,
});

function getInternalImageRequestToken(): string {
  return (
    process.env.INTERNAL_IMAGE_REQUEST_TOKEN?.trim() ||
    process.env.ADMIN_TOKEN?.trim() ||
    ""
  );
}

function readBearerToken(header: string | undefined): string {
  const value = header?.trim() ?? "";
  const spaceIndex = value.indexOf(" ");

  if (spaceIndex === -1) {
    return "";
  }

  const scheme = value.slice(0, spaceIndex);
  const token = value.slice(spaceIndex + 1).trim();

  if (scheme.toLowerCase() !== "bearer" || !token) {
    return "";
  }

  return token;
}

export function timingSafeTokenEqual(
  expectedToken: string,
  providedToken: string
): boolean {
  if (!expectedToken || !providedToken) {
    return false;
  }

  const expected = Buffer.from(expectedToken);
  const provided = Buffer.from(providedToken);
  if (expected.length !== provided.length) {
    return false;
  }

  return timingSafeEqual(expected, provided);
}

function authorizeInternalRequest(req: Request, res: Response): boolean {
  const expectedToken = getInternalImageRequestToken();
  const providedToken = readBearerToken(req.header("authorization"));

  if (!timingSafeTokenEqual(expectedToken, providedToken)) {
    res.sendStatus(403);
    return false;
  }

  return true;
}

function isSkippedInternalImageRequestOutcome(
  outcome: MessengerSendOutcome | undefined
): boolean {
  return (
    outcome === MESSENGER_SEND_SKIPPED ||
    (outcome?.sent === false && outcome.reason === "response_window_closed")
  );
}

function sendNotQueuedResponse(res: Response): void {
  res.status(409).json({
    error: "Image request was not queued",
    reason: "not_queued",
    retryable: false,
  });
}

/** Registers authenticated internal Messenger image-request and event bridge routes. */
export function registerInternalImageRequestRoutes(app: Express): void {
  app.get(
    "/internal/messenger/ai-answer-quota/readiness",
    internalMessengerRequestLimiter,
    async (req, res) => {
      if (!authorizeInternalRequest(req, res)) return;
      try {
        res.status(200).json(await getInternalAiAnswerQuotaReadiness());
      } catch (error) {
        safeLog("internal_ai_answer_readiness_failed", {
          level: "error",
          errorCode: safeInternalAiAnswerQuotaErrorCode(error),
        });
        res.status(503).json({ error: "AI answer quota is unavailable" });
      }
    }
  );
  app.post(
    "/internal/messenger/ai-answer-quota/heartbeat",
    internalMessengerRequestLimiter,
    async (req, res) => {
      if (!authorizeInternalRequest(req, res)) return;
      const parsed = internalAiAnswerQuotaHeartbeatSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid AI answer reservation lease" });
        return;
      }
      try {
        res
          .status(200)
          .json(await heartbeatInternalAiAnswerReservation(parsed.data));
      } catch (error) {
        safeLog("internal_ai_answer_heartbeat_failed", {
          level: "error",
          errorCode: safeInternalAiAnswerQuotaErrorCode(error),
        });
        res.status(503).json({ error: "AI answer reservation is unavailable" });
      }
    }
  );
  app.post(
    "/internal/messenger/ai-answer-quota/delivery-known-rejected",
    internalMessengerRequestLimiter,
    async (req, res) => {
      if (!authorizeInternalRequest(req, res)) return;
      const parsed = internalAiAnswerQuotaDeliveryKnownRejectedSchema.safeParse(
        req.body
      );
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid AI answer delivery outcome" });
        return;
      }
      try {
        res
          .status(200)
          .json(await markInternalAiAnswerDeliveryKnownRejected(parsed.data));
      } catch (error) {
        safeLog("internal_ai_answer_delivery_reject_failed", {
          level: "error",
          errorCode: safeInternalAiAnswerQuotaErrorCode(error),
        });
        res.status(503).json({ error: "AI answer delivery is unavailable" });
      }
    }
  );
  app.post(
    "/internal/messenger/ai-answer-quota/delivery-started",
    internalMessengerRequestLimiter,
    async (req, res) => {
      if (!authorizeInternalRequest(req, res)) return;
      const parsed = internalAiAnswerQuotaDeliveryStartedSchema.safeParse(
        req.body
      );
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid AI answer delivery fence" });
        return;
      }
      try {
        res
          .status(200)
          .json(await markInternalAiAnswerDeliveryStarted(parsed.data));
      } catch (error) {
        safeLog("internal_ai_answer_delivery_fence_failed", {
          level: "error",
          errorCode: safeInternalAiAnswerQuotaErrorCode(error),
        });
        res.status(503).json({ error: "AI answer delivery is unavailable" });
      }
    }
  );
  app.post(
    "/internal/messenger/ai-answer-quota/reserve",
    internalMessengerRequestLimiter,
    async (req, res) => {
      if (!authorizeInternalRequest(req, res)) return;
      const parsed = internalAiAnswerQuotaReserveSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid AI answer quota request" });
        return;
      }
      try {
        res.status(200).json(await reserveInternalAiAnswerQuota(parsed.data));
      } catch (error) {
        safeLog("internal_ai_answer_quota_reserve_failed", {
          level: "error",
          errorCode: safeInternalAiAnswerQuotaErrorCode(error),
        });
        res.status(503).json({ error: "AI answer quota is unavailable" });
      }
    }
  );

  app.post(
    "/internal/messenger/ai-answer-quota/finalize",
    internalMessengerRequestLimiter,
    async (req, res) => {
      if (!authorizeInternalRequest(req, res)) return;
      const parsed = internalAiAnswerQuotaFinalizeSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: "Invalid AI answer quota finalization" });
        return;
      }
      try {
        res.status(200).json(await finalizeInternalAiAnswerQuota(parsed.data));
      } catch (error) {
        safeLog("internal_ai_answer_quota_finalize_failed", {
          level: "error",
          errorCode: safeInternalAiAnswerQuotaErrorCode(error),
        });
        res.status(503).json({ error: "AI answer quota is unavailable" });
      }
    }
  );

  app.post(
    "/internal/messenger/image-request",
    internalMessengerRequestLimiter,
    async (req, res) => {
      if (!authorizeInternalRequest(req, res)) {
        return;
      }

      const parsed = internalImageRequestSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({ error: "Invalid image request payload" });
        return;
      }

      try {
        const outcome = await acceptInternalMessengerImageRequest(parsed.data);
        if (isSkippedInternalImageRequestOutcome(outcome)) {
          safeLog("internal_image_request_not_queued", {
            level: "warn",
            reason: "send_skipped",
          });
          sendNotQueuedResponse(res);
          return;
        }
      } catch (error) {
        if (isInternalMessengerImageRequestNotQueuedError(error)) {
          safeLog("internal_image_request_not_queued", {
            level: "warn",
            error: error.message,
          });
          sendNotQueuedResponse(res);
          return;
        }

        safeLog("internal_image_request_failed", {
          level: "error",
          error: error instanceof Error ? error.message : String(error),
        });
        res.status(503).json({ error: "Image request was not queued" });
        return;
      }

      res.status(202).json({ status: "queued" });
    }
  );

  app.post(
    "/internal/messenger/webhook-event",
    internalMessengerRequestLimiter,
    (req, res) => {
      if (!authorizeInternalRequest(req, res)) {
        return;
      }

      const parsed = internalMessengerEventSchema.safeParse(req.body);

      if (!parsed.success) {
        res.status(400).json({ error: "Invalid messenger event payload" });
        return;
      }

      const event = parsed.data.event;
      const pageId = event.recipient?.id ?? process.env.MESSENGER_PAGE_ID ?? "";

      res.status(202).json({ status: "queued" });

      void processFacebookWebhookPayload({
        object: "page",
        entry: [
          {
            id: pageId,
            time: event.timestamp,
            messaging: [event],
          },
        ],
      }).catch((error: unknown) => {
        safeLog("internal_messenger_event_failed", {
          level: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  );
}
