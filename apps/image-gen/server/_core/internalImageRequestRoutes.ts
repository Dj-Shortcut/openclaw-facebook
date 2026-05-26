import type { Express, Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import {
  processFacebookWebhookPayload,
  processInternalMessengerImageRequest,
} from "./messengerWebhook";

const internalImageRequestSchema = z.object({
  psid: z.string().trim().min(1),
  prompt: z.string().trim().min(1).max(2_000),
  reqId: z.string().trim().min(1).max(128),
  lang: z.enum(["nl", "en"]).optional(),
  timestamp: z.number().int().positive().optional(),
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

function authorizeInternalRequest(req: Request, res: Response): boolean {
  const expectedToken = getInternalImageRequestToken();
  const providedToken = readBearerToken(req.header("authorization"));

  if (!expectedToken || providedToken !== expectedToken) {
    res.sendStatus(403);
    return false;
  }

  return true;
}

export function registerInternalImageRequestRoutes(app: Express): void {
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

      res.status(202).json({ status: "queued" });

      void processInternalMessengerImageRequest(parsed.data).catch(
        (error: unknown) => {
          console.error("[internal image request] failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      );
    }
  );

  app.post(
    "/internal/messenger/webhook-event",
    internalMessengerRequestLimiter,
    async (req, res) => {
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
        console.error("[internal messenger event] failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  );
}
