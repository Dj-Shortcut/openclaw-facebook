import type { IncomingMessage, ServerResponse } from "node:http";
import { readWebhookBodyOrReject } from "openclaw/plugin-sdk/webhook-request-guards";
import { validateMessengerSignature } from "./signature.js";
import type { MessengerWebhookBody, MessengerWebhookMessaging } from "./types.js";

export function handleMessengerWebhookVerification(params: {
  url: URL;
  verifyToken: string;
  res: ServerResponse;
}): boolean {
  if (params.url.searchParams.get("hub.mode") !== "subscribe") {
    params.res.statusCode = 403;
    params.res.end("Forbidden");
    return true;
  }
  if (params.url.searchParams.get("hub.verify_token") !== params.verifyToken) {
    params.res.statusCode = 403;
    params.res.end("Forbidden");
    return true;
  }
  params.res.statusCode = 200;
  params.res.setHeader("Content-Type", "text/plain");
  params.res.end(params.url.searchParams.get("hub.challenge") ?? "");
  return true;
}

export async function readVerifiedMessengerWebhookBody(params: {
  req: IncomingMessage;
  res: ServerResponse;
  appSecret: string;
}): Promise<{ ok: true; body: MessengerWebhookBody } | { ok: false }> {
  const signatureHeader = params.req.headers["x-hub-signature-256"];
  const signature =
    typeof signatureHeader === "string"
      ? signatureHeader
      : Array.isArray(signatureHeader)
        ? (signatureHeader[0] ?? "")
        : "";
  if (!signature.trim()) {
    params.res.statusCode = 401;
    params.res.end("Missing X-Hub-Signature-256");
    return { ok: false };
  }
  const raw = await readWebhookBodyOrReject({
    req: params.req,
    res: params.res,
    profile: "pre-auth",
    invalidBodyMessage: "Invalid webhook body",
  });
  if (!raw.ok) {
    return { ok: false };
  }
  if (!validateMessengerSignature(raw.value, signature, params.appSecret)) {
    params.res.statusCode = 401;
    params.res.end("Invalid signature");
    return { ok: false };
  }
  try {
    const body = JSON.parse(raw.value) as MessengerWebhookBody;
    return { ok: true, body };
  } catch {
    params.res.statusCode = 400;
    params.res.end("Invalid webhook payload");
    return { ok: false };
  }
}

export function extractMessengerTextMessages(
  body: MessengerWebhookBody,
): MessengerWebhookMessaging[] {
  if (body.object !== "page") {
    return [];
  }
  const messages: MessengerWebhookMessaging[] = [];
  for (const entry of body.entry ?? []) {
    for (const event of entry.messaging ?? []) {
      const text = event.message?.text?.trim();
      if (!text || event.message?.is_echo) {
        continue;
      }
      if (!event.sender?.id || !event.recipient?.id) {
        continue;
      }
      messages.push(event);
    }
  }
  return messages;
}
