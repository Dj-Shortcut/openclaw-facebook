import { createHash, randomUUID } from "node:crypto";
import {
  ensureRedisReady,
  getRedisClient,
  isRedisEnabled,
  type RedisLike,
  resetRedisClientForTests,
} from "../redis";
import { safeLog } from "../messengerApi";
import type { Lang } from "../i18n";
import {
  isDeleteCommand,
  isWhatsAppPrivacyOrConsentControl,
} from "../consentService";
import { GDPR_DELETE_CONFIRM } from "../consentActionIds";
import { extractWhatsAppEvents } from "../inbound/whatsappInbound";
import { toUserKey } from "../privacy";
import { classifyInboundEvent } from "../messengerInboundClassification";
import {
  admitMessengerPrivacySubjectFromMetaEvent,
  getErasingMessengerPrivacySubject,
  MessengerPrivacyFenceError,
  runWithLockedMessengerPrivacyErasure,
  type MessengerErasingPrivacySubject,
} from "../messengerPrivacySubject";
import { runWithMessengerRequestContext } from "../messengerRequestContext";
import type { FacebookWebhookEvent } from "../webhookHelpers";
import type { NormalizedWhatsAppEvent } from "../whatsappTypes";
import {
  admitWhatsAppGenerationScope,
  resolveWhatsAppGenerationOwnership,
  WhatsAppGenerationScopeError,
  type WhatsAppGenerationOwnership,
} from "../whatsappGenerationScope";
import { resolveMessengerGenerationOwnership } from "../workspaceEntitlementRuntime";

const WEBHOOK_INGRESS_QUEUE_KEY = "{meta-webhook-ingress}:queued";
const WEBHOOK_INGRESS_PROCESSING_KEY = "{meta-webhook-ingress}:processing";
const WEBHOOK_INGRESS_DEAD_LETTER_KEY = "{meta-webhook-ingress}:dead";
const WEBHOOK_INGRESS_DELIVERY_PREFIX = "{meta-webhook-ingress}:delivery:";
const WEBHOOK_INGRESS_SUBJECT_PREFIX = "{meta-webhook-ingress}:subject:";
const WEBHOOK_INGRESS_SUBJECT_LEASE_PREFIX =
  "{meta-webhook-ingress}:subject-lease:";
const WEBHOOK_INGRESS_LEASE_PREFIX = "{meta-webhook-ingress}:lease:";
const DEFAULT_WEBHOOK_INGRESS_CONTENT_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_WEBHOOK_INGRESS_DELIVERY_LEASE_SECONDS = 15 * 60;
const DEFAULT_WEBHOOK_INGRESS_MAX_ATTEMPTS = 3;
const DEFAULT_WEBHOOK_INGRESS_RETRY_DELAY_MS = 1_000;
const DEFAULT_WEBHOOK_INGRESS_DEAD_MAX_ITEMS = 1_000;

type WebhookChannel = "facebook" | "whatsapp";
type WebhookIngressPrivacyControl = "erasure_retry";

type WebhookIngressSubject = {
  workspaceId: number;
  channelConnectionId: number;
  bindingEpoch: number;
  privacyEpoch: number;
  pageId: string;
  userKey: string;
};

type QueuedWebhookDelivery = {
  deliveryId: string;
  channel: WebhookChannel;
  payload: unknown;
  receivedAt: string;
  expiresAt: number;
  attempts?: number;
  privacyControl?: WebhookIngressPrivacyControl;
  erasureControl?: MessengerErasingPrivacySubject;
  subjects: WebhookIngressSubject[];
};

type ReservedWebhookDelivery = {
  raw: string;
  delivery: QueuedWebhookDelivery;
  legacyInline: boolean;
  subjectLease?: WebhookIngressSubjectLease;
};

type WebhookIngressSubjectLease = {
  keys: string[];
  token: string;
};

type WebhookIngressUnit = {
  payload: unknown;
  subjects: WebhookIngressSubject[];
  privacyControl?: WebhookIngressPrivacyControl;
  erasureControl?: MessengerErasingPrivacySubject;
};

let drainPromise: Promise<void> | null = null;
let drainRequested = false;

function serializeError(error: unknown): {
  class: string;
  code?: string | number;
} {
  try {
    const errorClass =
      error instanceof Error ? error.constructor.name : "UnknownError";
    if (!error || typeof error !== "object" || !("code" in error)) {
      return { class: errorClass };
    }

    const code = (error as { code?: unknown }).code;
    if (
      typeof code === "number" &&
      Number.isInteger(code) &&
      code >= 0 &&
      code <= 99_999
    ) {
      return { class: errorClass, code };
    }

    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) {
      return { class: errorClass, code };
    }

    return { class: errorClass };
  } catch {
    return { class: "UnknownError" };
  }
}

function getWebhookIngressDeliveryLeaseSeconds(): number {
  const configured = Number(process.env.WEBHOOK_INGRESS_DELIVERY_LEASE_SECONDS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_WEBHOOK_INGRESS_DELIVERY_LEASE_SECONDS;
}

function getWebhookIngressMaxAttempts(): number {
  const configured = Number(process.env.WEBHOOK_INGRESS_MAX_ATTEMPTS);
  return Number.isFinite(configured) && configured > 0
    ? Math.floor(configured)
    : DEFAULT_WEBHOOK_INGRESS_MAX_ATTEMPTS;
}

function getWebhookIngressRetryDelayMs(): number {
  const configured = Number(process.env.WEBHOOK_INGRESS_RETRY_DELAY_MS);
  const delayMs = Math.floor(configured);
  return Number.isFinite(delayMs) && delayMs >= 1
    ? delayMs
    : DEFAULT_WEBHOOK_INGRESS_RETRY_DELAY_MS;
}

function getWebhookIngressContentTtlSeconds(): number {
  const maximumSeconds = 24 * 60 * 60;
  const minimumSeconds =
    getWebhookIngressDeliveryLeaseSeconds() * getWebhookIngressMaxAttempts();
  if (minimumSeconds > maximumSeconds) {
    throw new Error("Webhook ingress operation exceeds the content TTL cap");
  }
  const configured = Number(process.env.WEBHOOK_INGRESS_CONTENT_TTL_SECONDS);
  const requested =
    Number.isFinite(configured) && configured > 0
      ? Math.floor(configured)
      : DEFAULT_WEBHOOK_INGRESS_CONTENT_TTL_SECONDS;
  if (requested < minimumSeconds || requested > maximumSeconds) {
    throw new Error(
      "WEBHOOK_INGRESS_CONTENT_TTL_SECONDS must cover retries and be at most 24h"
    );
  }
  return requested;
}

function getWebhookIngressDeliveryKey(deliveryId: string): string {
  return `${WEBHOOK_INGRESS_DELIVERY_PREFIX}${deliveryId}`;
}

function isCanonicalWebhookIngressDeliveryId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function getWebhookIngressSubjectId(
  subject: Pick<
    WebhookIngressSubject,
    "workspaceId" | "channelConnectionId" | "userKey"
  >
): string {
  return createHash("sha256")
    .update(String(subject.workspaceId))
    .update("\0")
    .update(String(subject.channelConnectionId))
    .update("\0")
    .update(subject.userKey)
    .digest("hex");
}

function getWebhookIngressSubjectKey(subject: WebhookIngressSubject): string {
  return `${WEBHOOK_INGRESS_SUBJECT_PREFIX}${getWebhookIngressSubjectId(subject)}`;
}

function getWebhookIngressSubjectLeaseKey(
  subject: WebhookIngressSubject
): string {
  return `${WEBHOOK_INGRESS_SUBJECT_LEASE_PREFIX}${getWebhookIngressSubjectId(subject)}`;
}

function getWebhookIngressSubjectTombstoneKey(
  subject: Pick<
    WebhookIngressSubject,
    "workspaceId" | "channelConnectionId" | "userKey"
  >
): string {
  return `{meta-webhook-ingress}:erased:${getWebhookIngressSubjectId(subject)}`;
}

function getWebhookIngressDeliveryLeaseKey(rawDelivery: string): string {
  if (isCanonicalWebhookIngressDeliveryId(rawDelivery)) {
    return `${WEBHOOK_INGRESS_LEASE_PREFIX}${rawDelivery}`;
  }
  const digest = createHash("sha256").update(rawDelivery).digest("hex");
  return `${WEBHOOK_INGRESS_LEASE_PREFIX}${digest}`;
}

function parseQueuedWebhookDelivery(
  rawDelivery: string
): QueuedWebhookDelivery | null {
  try {
    const parsed = JSON.parse(rawDelivery) as Partial<QueuedWebhookDelivery>;
    const legacyTestDelivery =
      parsed.expiresAt === undefined && process.env.NODE_ENV === "test";
    const subjects =
      parsed.subjects === undefined && legacyTestDelivery
        ? []
        : Array.isArray(parsed.subjects) &&
            parsed.subjects.every(isWebhookIngressSubject)
          ? parsed.subjects
          : null;
    const privacyControl =
      parsed.privacyControl === undefined
        ? undefined
        : parsed.privacyControl === "erasure_retry"
          ? parsed.privacyControl
          : null;
    const erasureControl = isWebhookIngressErasureControl(parsed.erasureControl)
      ? parsed.erasureControl
      : parsed.erasureControl === undefined
        ? undefined
        : null;
    if (
      (parsed.channel === "facebook" || parsed.channel === "whatsapp") &&
      typeof parsed.receivedAt === "string" &&
      subjects !== null &&
      privacyControl !== null &&
      erasureControl !== null &&
      (isWebhookIngressExpiry(parsed.receivedAt, parsed.expiresAt) ||
        legacyTestDelivery) &&
      (parsed.attempts === undefined ||
        (typeof parsed.attempts === "number" &&
          Number.isInteger(parsed.attempts) &&
          parsed.attempts >= 0))
    ) {
      return {
        deliveryId:
          typeof parsed.deliveryId === "string" ? parsed.deliveryId : "legacy",
        channel: parsed.channel,
        payload: parsed.payload,
        receivedAt: legacyTestDelivery
          ? new Date().toISOString()
          : parsed.receivedAt,
        expiresAt:
          typeof parsed.expiresAt === "number"
            ? parsed.expiresAt
            : Date.now() + getWebhookIngressContentTtlSeconds() * 1_000,
        attempts: parsed.attempts,
        ...(privacyControl === undefined ? {} : { privacyControl }),
        ...(erasureControl === undefined ? {} : { erasureControl }),
        subjects,
      };
    }
  } catch {
    // Invalid queue payloads are handled by the caller.
  }

  return null;
}

function isWebhookIngressErasureControl(
  value: unknown
): value is MessengerErasingPrivacySubject {
  if (!value || typeof value !== "object") return false;
  const control = value as Partial<MessengerErasingPrivacySubject>;
  return (
    Number.isSafeInteger(control.privacyEpoch) &&
    Number(control.privacyEpoch) > 0 &&
    Number.isSafeInteger(control.dataPrivacyEpoch) &&
    Number(control.dataPrivacyEpoch) > 0 &&
    Number(control.dataPrivacyEpoch) < Number(control.privacyEpoch)
  );
}

function isWebhookIngressExpiry(
  receivedAt: string,
  expiresAt: unknown
): expiresAt is number {
  const receivedAtMs = Date.parse(receivedAt);
  return (
    Number.isFinite(receivedAtMs) &&
    typeof expiresAt === "number" &&
    Number.isSafeInteger(expiresAt) &&
    expiresAt >= receivedAtMs &&
    expiresAt <= receivedAtMs + 24 * 60 * 60 * 1_000
  );
}

function isWebhookIngressSubject(
  value: unknown
): value is WebhookIngressSubject {
  if (!value || typeof value !== "object") return false;
  const subject = value as Partial<WebhookIngressSubject>;
  return (
    Number.isSafeInteger(subject.workspaceId) &&
    Number(subject.workspaceId) > 0 &&
    Number.isSafeInteger(subject.channelConnectionId) &&
    Number(subject.channelConnectionId) > 0 &&
    Number.isSafeInteger(subject.bindingEpoch) &&
    Number(subject.bindingEpoch) > 0 &&
    Number.isSafeInteger(subject.privacyEpoch) &&
    Number(subject.privacyEpoch) > 0 &&
    typeof subject.pageId === "string" &&
    Boolean(subject.pageId.trim()) &&
    typeof subject.userKey === "string" &&
    /^[a-f0-9]{64}$/i.test(subject.userKey)
  );
}

function hasExactWebhookIngressPrivacyScope(
  delivery: QueuedWebhookDelivery
): boolean {
  if (delivery.subjects.length !== 1) return false;
  if (delivery.channel === "facebook") {
    return (
      delivery.privacyControl === undefined &&
      delivery.erasureControl === undefined
    );
  }
  try {
    const events = extractWhatsAppEvents(delivery.payload);
    const event = events[0];
    const subject = delivery.subjects[0];
    return Boolean(
      events.length === 1 &&
      event &&
      subject &&
      event.userId === subject.userKey &&
      event.endpoint.phoneNumberId === subject.pageId &&
      (delivery.privacyControl === undefined
        ? delivery.erasureControl === undefined
        : delivery.privacyControl === "erasure_retry" &&
          isWhatsAppDeletionRetryControl(event) &&
          delivery.erasureControl?.privacyEpoch === subject.privacyEpoch)
    );
  } catch {
    return false;
  }
}

async function createFacebookIngressDeliveries(
  payload: unknown
): Promise<WebhookIngressUnit[]> {
  if (!payload || typeof payload !== "object") return [];
  const entries = (payload as { entry?: unknown; object?: unknown }).entry;
  if (!Array.isArray(entries)) return [];
  const object = (payload as { object?: unknown }).object;
  const deliveries: Array<{
    payload: unknown;
    subjects: WebhookIngressSubject[];
  }> = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const pageId =
      typeof (entry as { id?: unknown }).id === "string"
        ? String((entry as { id?: unknown }).id).trim()
        : "";
    const ownership = pageId
      ? await resolveMessengerGenerationOwnership(pageId)
      : null;
    if (!ownership) {
      throw new Error("Webhook ingress Page ownership is unavailable");
    }
    const messaging = (entry as { messaging?: unknown }).messaging;
    if (!Array.isArray(messaging)) continue;
    for (const event of messaging) {
      if (!event || typeof event !== "object") continue;
      const recipient = (event as { recipient?: unknown }).recipient;
      const recipientId =
        recipient && typeof recipient === "object"
          ? (recipient as { id?: unknown }).id
          : undefined;
      if (recipientId !== pageId) {
        throw new Error("Webhook ingress recipient Page does not match entry");
      }
      const sender = (event as { sender?: unknown }).sender;
      const senderId =
        sender && typeof sender === "object"
          ? (sender as { id?: unknown }).id
          : undefined;
      if (typeof senderId !== "string" || !senderId.trim()) {
        continue;
      }
      const messengerEvent = event as FacebookWebhookEvent;
      const eventOccurredAt = parseMetaEventOccurredAt(
        messengerEvent.timestamp
      );
      const userKey = toUserKey(senderId);
      let privacyEpoch: number;
      try {
        privacyEpoch = await admitMessengerPrivacySubjectFromMetaEvent({
          workspaceId: ownership.workspaceId,
          channelConnectionId: ownership.channelConnectionId,
          userKey,
          eventOccurredAt,
          allowReactivation:
            classifyInboundEvent(messengerEvent).isInboundUserEvent,
        });
      } catch (error) {
        if (error instanceof MessengerPrivacyFenceError) {
          safeLog("webhook_ingress_event_privacy_rejected", {});
          continue;
        }
        throw error;
      }
      deliveries.push({
        payload: { object, entry: [{ ...entry, messaging: [event] }] },
        subjects: [{ ...ownership, userKey, privacyEpoch }],
      });
    }
  }
  return deliveries;
}

function isWhatsAppDeletionRetryControl(
  event: NormalizedWhatsAppEvent
): boolean {
  const interactiveReplyId =
    typeof event.rawEventMeta?.interactiveReplyId === "string"
      ? event.rawEventMeta.interactiveReplyId
      : undefined;
  return (
    interactiveReplyId === GDPR_DELETE_CONFIRM ||
    isDeleteCommand(event.textBody) ||
    isDeleteCommand(interactiveReplyId)
  );
}

function createSingleWhatsAppIngressPayload(
  event: NormalizedWhatsAppEvent
): unknown {
  const rawType =
    event.rawMessageType ??
    (event.messageType === "audio" ? "audio" : event.messageType);
  const message: Record<string, unknown> = {
    from: event.senderId,
    type: rawType,
  };
  if (event.messageId) message.id = event.messageId;
  if (event.timestamp !== undefined) {
    message.timestamp = String(Math.floor(event.timestamp / 1_000));
  }
  if (rawType === "text") {
    message.text = { body: event.textBody ?? "" };
  } else if (rawType === "interactive") {
    const interactiveReplyId =
      typeof event.rawEventMeta?.interactiveReplyId === "string"
        ? event.rawEventMeta.interactiveReplyId
        : undefined;
    const interactiveReplyTitle =
      typeof event.rawEventMeta?.interactiveReplyTitle === "string"
        ? event.rawEventMeta.interactiveReplyTitle
        : undefined;
    message.interactive = {
      button_reply: {
        ...(interactiveReplyId === undefined ? {} : { id: interactiveReplyId }),
        ...(interactiveReplyTitle === undefined
          ? {}
          : { title: interactiveReplyTitle }),
      },
    };
  } else if (rawType === "image") {
    message.image = { id: event.imageId };
  } else if (rawType === "audio" || rawType === "voice" || rawType === "ptt") {
    message[rawType] = { id: event.audioId };
  }

  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: event.endpoint.wabaId,
        changes: [
          {
            field: "messages",
            value: {
              metadata: {
                phone_number_id: event.endpoint.phoneNumberId,
              },
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

function exactWhatsAppIngressSubject(
  event: NormalizedWhatsAppEvent,
  ownership: WhatsAppGenerationOwnership,
  privacyEpoch: number
): WebhookIngressSubject {
  if (!Number.isSafeInteger(privacyEpoch) || privacyEpoch <= 0) {
    throw new WhatsAppGenerationScopeError();
  }
  return {
    ...ownership,
    privacyEpoch,
    pageId: event.endpoint.phoneNumberId,
  };
}

async function createWhatsAppIngressDeliveries(
  payload: unknown
): Promise<WebhookIngressUnit[]> {
  const deliveries: WebhookIngressUnit[] = [];
  for (const event of extractWhatsAppEvents(payload)) {
    try {
      const ownership = await resolveWhatsAppGenerationOwnership({
        endpoint: event.endpoint,
        senderId: event.senderId,
        userKey: event.userId,
      });
      const privacyOrConsentControl = isWhatsAppPrivacyOrConsentControl(event);
      const deletionRetryControl = isWhatsAppDeletionRetryControl(event);
      let subject: WebhookIngressSubject | undefined;
      let privacyControl: WebhookIngressPrivacyControl | undefined;
      let erasureControl: MessengerErasingPrivacySubject | undefined;
      if (deletionRetryControl) {
        const erasure = await getErasingMessengerPrivacySubject(ownership);
        if (erasure) {
          subject = exactWhatsAppIngressSubject(
            event,
            ownership,
            erasure.privacyEpoch
          );
          privacyControl = "erasure_retry";
          erasureControl = erasure;
        }
      }
      if (!subject) {
        const scope = await admitWhatsAppGenerationScope({
          endpoint: event.endpoint,
          ownership,
          eventOccurredAt: parseWhatsAppEventOccurredAt(event.timestamp),
          allowReactivation: !privacyOrConsentControl,
          allowCreation: true,
        });
        if (
          scope.workspaceId !== ownership.workspaceId ||
          scope.channelConnectionId !== ownership.channelConnectionId ||
          scope.bindingEpoch !== ownership.bindingEpoch ||
          scope.userKey !== ownership.userKey
        ) {
          throw new WhatsAppGenerationScopeError();
        }
        subject = exactWhatsAppIngressSubject(
          event,
          ownership,
          scope.privacyEpoch
        );
      }
      deliveries.push({
        payload: createSingleWhatsAppIngressPayload(event),
        subjects: [subject],
        ...(privacyControl === undefined ? {} : { privacyControl }),
        ...(erasureControl === undefined ? {} : { erasureControl }),
      });
    } catch (error) {
      if (error instanceof WhatsAppGenerationScopeError && !error.retryable) {
        safeLog("webhook_ingress_event_privacy_rejected", {
          channel: "whatsapp",
        });
        continue;
      }
      throw error;
    }
  }
  return deliveries;
}

function parseWhatsAppEventOccurredAt(value: unknown): Date {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new WhatsAppGenerationScopeError();
  }
  const eventOccurredAt = new Date(value);
  if (!Number.isSafeInteger(eventOccurredAt.getTime())) {
    throw new WhatsAppGenerationScopeError();
  }
  return eventOccurredAt;
}

function parseMetaEventOccurredAt(value: unknown): Date {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Webhook ingress event timestamp is unavailable");
  }
  const eventOccurredAt = new Date(value);
  if (!Number.isSafeInteger(eventOccurredAt.getTime())) {
    throw new Error("Webhook ingress event timestamp is unavailable");
  }
  return eventOccurredAt;
}

async function processWhatsAppWebhookPayloadSafely(
  payload: unknown,
  expectedScope: Omit<WebhookIngressSubject, "pageId">
): Promise<void> {
  const module = await import("../whatsappWebhook");
  await module.processWhatsAppWebhookPayload(payload, { expectedScope });
}

async function processFacebookWebhookPayloadSafely(
  payload: unknown,
  options: { defaultLang?: Lang } = {}
): Promise<void> {
  const module = await import("../messengerWebhook");
  if (options.defaultLang) {
    await module.processFacebookWebhookPayload(payload, options);
    return;
  }
  await module.processFacebookWebhookPayload(payload);
}

async function processQueuedWebhookDelivery(
  delivery: QueuedWebhookDelivery
): Promise<void> {
  if (
    delivery.channel === "facebook" &&
    delivery.subjects.length === 0 &&
    process.env.NODE_ENV !== "production"
  ) {
    await processFacebookWebhookPayloadSafely(delivery.payload);
    return;
  }
  if (delivery.subjects.length !== 1) {
    throw new Error("Meta webhook delivery privacy scope is unavailable");
  }
  const subject = delivery.subjects[0];
  if (delivery.channel === "whatsapp") {
    const events = extractWhatsAppEvents(delivery.payload);
    const event = events[0];
    if (
      events.length !== 1 ||
      !event ||
      event.userId !== subject.userKey ||
      event.endpoint.phoneNumberId !== subject.pageId
    ) {
      throw new Error("WhatsApp webhook delivery privacy scope is unavailable");
    }
    await runWithMessengerRequestContext(
      subject.pageId,
      () =>
        processWhatsAppWebhookPayloadSafely(delivery.payload, {
          workspaceId: subject.workspaceId,
          channelConnectionId: subject.channelConnectionId,
          bindingEpoch: subject.bindingEpoch,
          privacyEpoch: subject.privacyEpoch,
          userKey: subject.userKey,
        }),
      {
        channel: "whatsapp",
        workspaceId: subject.workspaceId,
        channelConnectionId: subject.channelConnectionId,
        bindingEpoch: subject.bindingEpoch,
        userKey: subject.userKey,
        privacyEpoch: subject.privacyEpoch,
      }
    );
    return;
  }
  await runWithMessengerRequestContext(
    subject.pageId,
    () => processFacebookWebhookPayloadSafely(delivery.payload),
    {
      channel: "facebook_messenger",
      workspaceId: subject.workspaceId,
      channelConnectionId: subject.channelConnectionId,
      bindingEpoch: subject.bindingEpoch,
      userKey: subject.userKey,
      privacyEpoch: subject.privacyEpoch,
    }
  );
}

/** Processes an already-authenticated Meta ingress without granting workers reactivation authority. */
export async function processAuthenticatedFacebookIngressPayload(
  payload: unknown,
  options: { defaultLang?: Lang } = {}
): Promise<void> {
  const units = await createFacebookIngressDeliveries(payload);
  for (const unit of units) {
    const subject = unit.subjects[0];
    await runWithMessengerRequestContext(
      subject.pageId,
      () => processFacebookWebhookPayloadSafely(unit.payload, options),
      {
        channel: "facebook_messenger",
        workspaceId: subject.workspaceId,
        channelConnectionId: subject.channelConnectionId,
        bindingEpoch: subject.bindingEpoch,
        userKey: subject.userKey,
        privacyEpoch: subject.privacyEpoch,
      }
    );
  }
}

async function processAuthenticatedWhatsAppIngressPayload(
  payload: unknown
): Promise<void> {
  const units = await createWhatsAppIngressDeliveries(payload);
  for (const unit of units) {
    await processQueuedWebhookDelivery({
      deliveryId: "inline",
      channel: "whatsapp",
      payload: unit.payload,
      receivedAt: new Date().toISOString(),
      expiresAt: Date.now() + getWebhookIngressContentTtlSeconds() * 1_000,
      subjects: unit.subjects,
    });
  }
}

export function isWebhookIngressQueueEnabled(): boolean {
  return isRedisEnabled();
}

export async function ensureWebhookIngressQueueReady(): Promise<void> {
  await ensureRedisReady();
  const redis = await getRedisClient();
  for (const listKey of [
    WEBHOOK_INGRESS_QUEUE_KEY,
    WEBHOOK_INGRESS_PROCESSING_KEY,
  ]) {
    const refs = await redis.lrange(listKey, 0, 1_000);
    if (refs.length > 1_000) {
      throw new Error("Webhook ingress readiness scan is not bounded");
    }
    for (const ref of refs) {
      const raw = ref.startsWith("{")
        ? ref
        : await redis.get(getWebhookIngressDeliveryKey(ref));
      const delivery = raw ? parseQueuedWebhookDelivery(raw) : null;
      if (
        !delivery ||
        delivery.deliveryId !== ref ||
        !hasExactWebhookIngressPrivacyScope(delivery)
      ) {
        throw new Error(
          "Legacy or unscoped webhook ingress delivery requires purge"
        );
      }
    }
  }

  const deadLetterRefs = await redis.lrange(
    WEBHOOK_INGRESS_DEAD_LETTER_KEY,
    0,
    1_000
  );
  if (deadLetterRefs.length > 1_000) {
    throw new Error("Webhook ingress readiness scan is not bounded");
  }
  if (deadLetterRefs.some(ref => !isCanonicalWebhookIngressDeliveryId(ref))) {
    throw new Error("Legacy webhook ingress dead-letter requires purge");
  }
}

export async function enqueueWebhookIngressDelivery(
  channel: WebhookChannel,
  payload: unknown
): Promise<void> {
  const units =
    channel === "facebook"
      ? await createFacebookIngressDeliveries(payload)
      : await createWhatsAppIngressDeliveries(payload);
  for (const unit of units) {
    const persist = () =>
      enqueueWebhookIngressUnit(
        channel,
        unit.payload,
        unit.subjects,
        unit.privacyControl,
        unit.erasureControl
      );
    const subject = unit.subjects[0];
    if (unit.erasureControl && subject) {
      await runWithLockedMessengerPrivacyErasure(
        {
          workspaceId: subject.workspaceId,
          channelConnectionId: subject.channelConnectionId,
          userKey: subject.userKey,
          ...unit.erasureControl,
        },
        async () => {
          await persist();
          return { value: undefined, complete: false };
        }
      );
      continue;
    }
    await persist();
  }
}

async function enqueueWebhookIngressUnit(
  channel: WebhookChannel,
  payload: unknown,
  subjects: WebhookIngressSubject[],
  privacyControl?: WebhookIngressPrivacyControl,
  erasureControl?: MessengerErasingPrivacySubject
): Promise<void> {
  const deliveryId = randomUUID();
  const now = Date.now();
  const delivery: QueuedWebhookDelivery = {
    deliveryId,
    channel,
    payload,
    receivedAt: new Date(now).toISOString(),
    expiresAt: now + getWebhookIngressContentTtlSeconds() * 1_000,
    ...(privacyControl === undefined ? {} : { privacyControl }),
    ...(erasureControl === undefined ? {} : { erasureControl }),
    subjects,
  };
  if (!hasExactWebhookIngressPrivacyScope(delivery)) {
    throw new Error("Meta webhook delivery privacy scope is unavailable");
  }
  const redis = await getRedisClient();
  const subjectIndexKeys = delivery.subjects.map(getWebhookIngressSubjectKey);
  const subjectTombstoneKeys = delivery.subjects.map(
    getWebhookIngressSubjectTombstoneKey
  );

  const result = Number(
    await redis.eval(
      `
      local subjectCount = tonumber(ARGV[4])
      local deliveryType = redis.call("TYPE", KEYS[1]).ok
      if deliveryType ~= "none" then return -2 end
      local queueType = redis.call("TYPE", KEYS[2]).ok
      if queueType ~= "none" and queueType ~= "list" then return -2 end
      local allowSameEpochErasureRetry = ARGV[5] == "1"
      for i = 1, subjectCount do
        local indexType = redis.call("TYPE", KEYS[2 + i]).ok
        if indexType ~= "none" and indexType ~= "set" then return -2 end
        local tombstoneType = redis.call("TYPE", KEYS[2 + subjectCount + i]).ok
        if tombstoneType ~= "none" and tombstoneType ~= "string" then return -2 end
        local erased = tonumber(redis.call("GET", KEYS[2 + subjectCount + i]) or "0")
        local incoming = tonumber(ARGV[5 + i])
        if (allowSameEpochErasureRetry and erased > incoming)
          or (not allowSameEpochErasureRetry and erased >= incoming) then
          return -1
        end
      end
      local function extendDeadline(key, deadline)
        local ttl = redis.call("PTTL", key)
        if ttl < 0 then
          redis.call("PEXPIREAT", key, deadline)
        else
          redis.call("PEXPIREAT", key, deadline, "GT")
        end
      end

      redis.call("SET", KEYS[1], ARGV[2], "PXAT", ARGV[3])
      redis.call("RPUSH", KEYS[2], ARGV[1])
      extendDeadline(KEYS[2], ARGV[3])
      for i = 3, 2 + subjectCount do
        redis.call("SADD", KEYS[i], ARGV[1])
        extendDeadline(KEYS[i], ARGV[3])
      end
      return 1
    `,
      2 + subjectIndexKeys.length + subjectTombstoneKeys.length,
      getWebhookIngressDeliveryKey(deliveryId),
      WEBHOOK_INGRESS_QUEUE_KEY,
      ...subjectIndexKeys,
      ...subjectTombstoneKeys,
      deliveryId,
      JSON.stringify(delivery),
      delivery.expiresAt,
      subjects.length,
      privacyControl === "erasure_retry" ? 1 : 0,
      ...subjects.map(subject => subject.privacyEpoch)
    )
  );
  if (result !== 1) {
    if (result === -1) {
      throw new Error("Webhook ingress subject epoch is erased");
    }
    throw new Error("Webhook ingress enqueue storage is inconsistent");
  }
}

async function reserveWebhookIngressDelivery(
  redis: RedisLike
): Promise<
  | ReservedWebhookDelivery
  | { raw: string; invalid: true }
  | { subjectBlocked: true }
  | null
> {
  const reservedResult =
    process.env.NODE_ENV === "test"
      ? await (async () => {
          const ref = await redis.lmove(
            WEBHOOK_INGRESS_QUEUE_KEY,
            WEBHOOK_INGRESS_PROCESSING_KEY,
            "LEFT",
            "RIGHT"
          );
          if (ref) {
            await redis.set(
              getWebhookIngressDeliveryLeaseKey(ref),
              "1",
              "EX",
              getWebhookIngressDeliveryLeaseSeconds()
            );
          }
          return ref;
        })()
      : await redis.eval(
          `
      local ref = redis.call("LPOP", KEYS[1])
      if not ref then return nil end
      redis.call("RPUSH", KEYS[2], ref)
      redis.call("SET", ARGV[1] .. ref, "1", "EX", ARGV[2])
      return ref
    `,
          2,
          WEBHOOK_INGRESS_QUEUE_KEY,
          WEBHOOK_INGRESS_PROCESSING_KEY,
          WEBHOOK_INGRESS_LEASE_PREFIX,
          getWebhookIngressDeliveryLeaseSeconds()
        );
  const raw = typeof reservedResult === "string" ? reservedResult : null;
  if (!raw) {
    return null;
  }

  const legacyInline = raw.startsWith("{") && process.env.NODE_ENV === "test";
  const serializedDelivery = legacyInline
    ? raw
    : await redis.get(getWebhookIngressDeliveryKey(raw));
  const delivery = serializedDelivery
    ? parseQueuedWebhookDelivery(serializedDelivery)
    : null;
  if (
    !delivery ||
    (!legacyInline && delivery.deliveryId !== raw) ||
    ((!legacyInline || delivery.channel === "whatsapp") &&
      !hasExactWebhookIngressPrivacyScope(delivery))
  ) {
    return { raw, invalid: true };
  }

  const subjectLease = await acquireWebhookIngressSubjectLease(redis, delivery);
  if (delivery.subjects.length > 0 && !subjectLease) {
    await returnWebhookIngressDeliveryToFront(redis, raw);
    return { subjectBlocked: true };
  }

  return { raw, delivery, legacyInline, subjectLease };
}

async function acquireWebhookIngressSubjectLease(
  redis: RedisLike,
  delivery: QueuedWebhookDelivery
): Promise<WebhookIngressSubjectLease | undefined> {
  const keys = Array.from(
    new Set(delivery.subjects.map(getWebhookIngressSubjectLeaseKey))
  );
  if (keys.length === 0) return undefined;
  const token = randomUUID();
  const acquired = Number(
    await redis.eval(
      `
        for i = 1, #KEYS do
          if redis.call("EXISTS", KEYS[i]) == 1 then return 0 end
        end
        for i = 1, #KEYS do
          redis.call("SET", KEYS[i], ARGV[1], "EX", ARGV[2])
        end
        return 1
      `,
      keys.length,
      ...keys,
      token,
      getWebhookIngressDeliveryLeaseSeconds()
    )
  );
  return acquired === 1 ? { keys, token } : undefined;
}

async function returnWebhookIngressDeliveryToFront(
  redis: RedisLike,
  raw: string
): Promise<void> {
  const returned = Number(
    await redis.eval(
      `
        local removed = redis.call("LREM", KEYS[1], 1, ARGV[1])
        if removed == 1 then
          redis.call("DEL", KEYS[2])
          redis.call("LPUSH", KEYS[3], ARGV[1])
        end
        return removed
      `,
      3,
      WEBHOOK_INGRESS_PROCESSING_KEY,
      getWebhookIngressDeliveryLeaseKey(raw),
      WEBHOOK_INGRESS_QUEUE_KEY,
      raw
    )
  );
  if (returned !== 1) {
    throw new Error("Blocked webhook delivery was not returned to queue");
  }
}

async function releaseWebhookIngressSubjectLease(
  redis: RedisLike,
  lease: WebhookIngressSubjectLease | undefined
): Promise<void> {
  if (!lease) return;
  await redis.eval(
    `
      for i = 1, #KEYS do
        if redis.call("GET", KEYS[i]) == ARGV[1] then
          redis.call("DEL", KEYS[i])
        end
      end
      return 1
    `,
    lease.keys.length,
    ...lease.keys,
    lease.token
  );
}

async function completeWebhookIngressDelivery(
  redis: RedisLike,
  raw: string,
  delivery?: QueuedWebhookDelivery,
  legacyInline = false,
  subjectLease?: WebhookIngressSubjectLease
): Promise<void> {
  await redis.lrem(WEBHOOK_INGRESS_PROCESSING_KEY, 1, raw);
  await redis.del(getWebhookIngressDeliveryLeaseKey(raw));
  if (!legacyInline && !delivery && isCanonicalWebhookIngressDeliveryId(raw)) {
    await redis.del(getWebhookIngressDeliveryKey(raw));
  }
  if (!legacyInline && delivery) {
    await redis.del(getWebhookIngressDeliveryKey(delivery.deliveryId));
    for (const subject of delivery.subjects) {
      await redis.srem(
        getWebhookIngressSubjectKey(subject),
        delivery.deliveryId
      );
    }
  }
  await releaseWebhookIngressSubjectLease(redis, subjectLease);
}

async function isWebhookIngressDeliveryErased(
  redis: RedisLike,
  delivery: QueuedWebhookDelivery
): Promise<boolean> {
  for (const subject of delivery.subjects) {
    const erasedEpoch = Number(
      (await redis.get(getWebhookIngressSubjectTombstoneKey(subject))) ?? "0"
    );
    if (
      delivery.privacyControl === "erasure_retry"
        ? erasedEpoch > subject.privacyEpoch
        : erasedEpoch >= subject.privacyEpoch
    ) {
      return true;
    }
  }
  return false;
}

async function moveFailedWebhookIngressDelivery(
  redis: RedisLike,
  reserved: ReservedWebhookDelivery,
  destinationKey: string,
  serializedDelivery: string,
  pushDirection: "LPUSH" | "RPUSH"
): Promise<void> {
  const removed = await redis.eval(
    `
      local processingType = redis.call("TYPE", KEYS[1]).ok
      if processingType ~= "none" and processingType ~= "list" then
        return redis.error_reply("processing key is not a list")
      end

      local leaseType = redis.call("TYPE", KEYS[2]).ok
      if leaseType ~= "none" and leaseType ~= "string" then
        return redis.error_reply("lease key is not a string")
      end

      local destinationType = redis.call("TYPE", KEYS[3]).ok
      if destinationType ~= "none" and destinationType ~= "list" then
        return redis.error_reply("destination key is not a list")
      end

      local found = 0
      local processingDeliveries = redis.call("LRANGE", KEYS[1], 0, -1)
      for i = 1, #processingDeliveries do
        if processingDeliveries[i] == ARGV[1] then
          found = 1
          break
        end
      end

      if found == 0 then
        return 0
      end

      redis.call(ARGV[2], KEYS[3], ARGV[3])
      if ARGV[4] == "dead" then
        redis.call("LTRIM", KEYS[3], -tonumber(ARGV[5]), -1)
        redis.call("EXPIRE", KEYS[3], ARGV[6])
      end
      local removed = redis.call("LREM", KEYS[1], 1, ARGV[1])
      if removed > 0 then
        redis.call("DEL", KEYS[2])
      end
      return removed
    `,
    3,
    WEBHOOK_INGRESS_PROCESSING_KEY,
    getWebhookIngressDeliveryLeaseKey(reserved.raw),
    destinationKey,
    reserved.raw,
    pushDirection,
    serializedDelivery,
    destinationKey === WEBHOOK_INGRESS_DEAD_LETTER_KEY ? "dead" : "retry",
    DEFAULT_WEBHOOK_INGRESS_DEAD_MAX_ITEMS,
    getWebhookIngressContentTtlSeconds()
  );

  if (removed !== 1) {
    throw new Error("Reserved webhook delivery was not found in processing");
  }
}

async function transitionFailedWebhookIngressDelivery(
  redis: RedisLike,
  reserved: ReservedWebhookDelivery,
  serializedRetryDelivery: string,
  transition: "retry" | "dead",
  forceErase = false
): Promise<"transitioned" | "erased"> {
  if (reserved.legacyInline) {
    await moveFailedWebhookIngressDelivery(
      redis,
      reserved,
      transition === "dead"
        ? WEBHOOK_INGRESS_DEAD_LETTER_KEY
        : WEBHOOK_INGRESS_QUEUE_KEY,
      serializedRetryDelivery,
      "RPUSH"
    );
    return "transitioned";
  }

  const subjectIndexKeys = reserved.delivery.subjects.map(
    getWebhookIngressSubjectKey
  );
  const subjectTombstoneKeys = reserved.delivery.subjects.map(
    getWebhookIngressSubjectTombstoneKey
  );
  const result = Number(
    await redis.eval(
      `
        local subjectCount = tonumber(ARGV[4])
        local transition = ARGV[5]
        local allowSameEpochErasureRetry = ARGV[8] == "1"
        local forceErase = ARGV[9] == "1"

        local queueType = redis.call("TYPE", KEYS[1]).ok
        local processingType = redis.call("TYPE", KEYS[2]).ok
        local deadType = redis.call("TYPE", KEYS[3]).ok
        local leaseType = redis.call("TYPE", KEYS[4]).ok
        local contentType = redis.call("TYPE", KEYS[5]).ok
        if (queueType ~= "none" and queueType ~= "list")
          or (processingType ~= "none" and processingType ~= "list")
          or (deadType ~= "none" and deadType ~= "list")
          or (leaseType ~= "none" and leaseType ~= "string")
          or (contentType ~= "none" and contentType ~= "string") then
          return redis.error_reply("webhook ingress retry storage is inconsistent")
        end

        for i = 1, subjectCount do
          local indexType = redis.call("TYPE", KEYS[5 + i]).ok
          local tombstoneType = redis.call("TYPE", KEYS[5 + subjectCount + i]).ok
          if (indexType ~= "none" and indexType ~= "set")
            or (tombstoneType ~= "none" and tombstoneType ~= "string") then
            return redis.error_reply("webhook ingress retry subject index is inconsistent")
          end
        end

        local function scrubErased()
          redis.call("LREM", KEYS[1], 0, ARGV[1])
          redis.call("LREM", KEYS[2], 0, ARGV[1])
          redis.call("LREM", KEYS[3], 0, ARGV[1])
          redis.call("DEL", KEYS[4])
          redis.call("DEL", KEYS[5])
          for i = 1, subjectCount do
            redis.call("SREM", KEYS[5 + i], ARGV[1])
          end
          return -1
        end

        if forceErase then return scrubErased() end

        for i = 1, subjectCount do
          local erased = tonumber(
            redis.call("GET", KEYS[5 + subjectCount + i]) or "0"
          )
          local incoming = tonumber(ARGV[9 + i])
          local isErased =
            (allowSameEpochErasureRetry and erased > incoming)
            or (not allowSameEpochErasureRetry and erased >= incoming)
          if isErased
            or redis.call("SISMEMBER", KEYS[5 + i], ARGV[1]) ~= 1 then
            return scrubErased()
          end
        end

        local found = 0
        local processingDeliveries = redis.call("LRANGE", KEYS[2], 0, -1)
        for i = 1, #processingDeliveries do
          if processingDeliveries[i] == ARGV[1] then
            found = 1
            break
          end
        end
        if found == 0 then return 0 end

        if transition == "retry" then
          local redisTime = redis.call("TIME")
          local nowMs = tonumber(redisTime[1]) * 1000
            + math.floor(tonumber(redisTime[2]) / 1000)
          if tonumber(ARGV[3]) <= nowMs then return scrubErased() end
          redis.call("SET", KEYS[5], ARGV[2], "PXAT", ARGV[3])
          redis.call("RPUSH", KEYS[1], ARGV[1])
        else
          redis.call("RPUSH", KEYS[3], ARGV[1])
          redis.call("LTRIM", KEYS[3], -tonumber(ARGV[6]), -1)
          redis.call("EXPIRE", KEYS[3], ARGV[7])
          redis.call("DEL", KEYS[5])
          for i = 1, subjectCount do
            redis.call("SREM", KEYS[5 + i], ARGV[1])
          end
        end

        local removed = redis.call("LREM", KEYS[2], 1, ARGV[1])
        if removed ~= 1 then
          return redis.error_reply("webhook ingress processing transition failed")
        end
        redis.call("DEL", KEYS[4])
        return 1
      `,
      5 + subjectIndexKeys.length + subjectTombstoneKeys.length,
      WEBHOOK_INGRESS_QUEUE_KEY,
      WEBHOOK_INGRESS_PROCESSING_KEY,
      WEBHOOK_INGRESS_DEAD_LETTER_KEY,
      getWebhookIngressDeliveryLeaseKey(reserved.raw),
      getWebhookIngressDeliveryKey(reserved.delivery.deliveryId),
      ...subjectIndexKeys,
      ...subjectTombstoneKeys,
      reserved.raw,
      serializedRetryDelivery,
      reserved.delivery.expiresAt,
      reserved.delivery.subjects.length,
      transition,
      DEFAULT_WEBHOOK_INGRESS_DEAD_MAX_ITEMS,
      getWebhookIngressContentTtlSeconds(),
      reserved.delivery.privacyControl === "erasure_retry" ? 1 : 0,
      forceErase ? 1 : 0,
      ...reserved.delivery.subjects.map(subject => subject.privacyEpoch)
    )
  );
  if (result === -1) return "erased";
  if (result !== 1) {
    throw new Error("Reserved webhook delivery was not found in processing");
  }
  return "transitioned";
}

async function releaseFailedWebhookIngressDelivery(
  redis: RedisLike,
  reserved: ReservedWebhookDelivery,
  error: unknown
): Promise<"requeued" | "dead_lettered" | "erased"> {
  const attempts = (reserved.delivery.attempts ?? 0) + 1;
  const retryDelivery: QueuedWebhookDelivery = {
    ...reserved.delivery,
    attempts,
  };
  const serializedRetryDelivery = JSON.stringify(retryDelivery);
  const serializedError = serializeError(error);
  const transitionDelivery = async (
    transition: "retry" | "dead"
  ): Promise<"transitioned" | "erased"> => {
    if (reserved.delivery.privacyControl !== "erasure_retry") {
      return transitionFailedWebhookIngressDelivery(
        redis,
        reserved,
        serializedRetryDelivery,
        transition
      );
    }
    const subject = reserved.delivery.subjects[0];
    const erasure = reserved.delivery.erasureControl;
    if (!subject || !erasure) {
      return transitionFailedWebhookIngressDelivery(
        redis,
        reserved,
        serializedRetryDelivery,
        transition,
        true
      );
    }
    try {
      return await runWithLockedMessengerPrivacyErasure(
        {
          workspaceId: subject.workspaceId,
          channelConnectionId: subject.channelConnectionId,
          userKey: subject.userKey,
          ...erasure,
        },
        async () => ({
          value: await transitionFailedWebhookIngressDelivery(
            redis,
            reserved,
            serializedRetryDelivery,
            transition
          ),
          complete: false,
        })
      );
    } catch (transitionError) {
      if (!(transitionError instanceof MessengerPrivacyFenceError)) {
        throw transitionError;
      }
      return transitionFailedWebhookIngressDelivery(
        redis,
        reserved,
        serializedRetryDelivery,
        transition,
        true
      );
    }
  };
  if (reserved.delivery.expiresAt <= Date.now()) {
    await completeWebhookIngressDelivery(
      redis,
      reserved.raw,
      reserved.delivery,
      reserved.legacyInline,
      reserved.subjectLease
    );
    return "erased";
  }

  if (attempts >= getWebhookIngressMaxAttempts()) {
    const transition = await transitionDelivery("dead");
    await releaseWebhookIngressSubjectLease(redis, reserved.subjectLease);
    if (transition === "erased") return "erased";
    safeLog("webhook_queued_delivery_dead_lettered", {
      channel: reserved.delivery.channel,
      attempts,
      error: serializedError,
    });
    return "dead_lettered";
  }

  const transition = await transitionDelivery("retry");
  await releaseWebhookIngressSubjectLease(redis, reserved.subjectLease);
  if (transition === "erased") return "erased";
  safeLog("webhook_queued_delivery_requeued", {
    channel: reserved.delivery.channel,
    attempts,
    error: serializedError,
  });
  return "requeued";
}

export async function eraseWebhookIngressDeliveriesForSubject(input: {
  workspaceId: number;
  channelConnectionId: number;
  userKey: string;
  privacyEpoch: number;
}): Promise<number> {
  if (!isWebhookIngressQueueEnabled()) {
    throw new Error("Webhook ingress queue is required for privacy erasure");
  }
  const redis = await getRedisClient();
  const subject = {
    ...input,
    bindingEpoch: 1,
    pageId: "privacy-erasure",
  } satisfies WebhookIngressSubject;
  const subjectKey = getWebhookIngressSubjectKey(subject);
  const tombstoneResult = Number(
    await redis.eval(
      `
        local current = tonumber(redis.call("GET", KEYS[1]) or "0")
        local requested = tonumber(ARGV[1])
        if current < requested then
          redis.call("SET", KEYS[1], ARGV[1])
          return requested
        end
        return current
      `,
      1,
      getWebhookIngressSubjectTombstoneKey(subject),
      input.privacyEpoch
    )
  );
  if (
    !Number.isSafeInteger(tombstoneResult) ||
    tombstoneResult < input.privacyEpoch
  ) {
    throw new Error("Webhook ingress privacy tombstone update failed");
  }
  let total = 0;
  while (true) {
    const result = await redis.eval(
      `
        local queueType = redis.call("TYPE", KEYS[1]).ok
        local processingType = redis.call("TYPE", KEYS[2]).ok
        local deadType = redis.call("TYPE", KEYS[3]).ok
        local subjectType = redis.call("TYPE", KEYS[4]).ok
        if (queueType ~= "none" and queueType ~= "list")
          or (processingType ~= "none" and processingType ~= "list")
          or (deadType ~= "none" and deadType ~= "list")
          or (subjectType ~= "none" and subjectType ~= "set") then
          return redis.error_reply("webhook ingress privacy index is inconsistent")
        end

        local ids = redis.call("SRANDMEMBER", KEYS[4], 100)
        if type(ids) ~= "table" then ids = {} end
        for i = 1, #ids do
          local contentType = redis.call("TYPE", ARGV[1] .. ids[i]).ok
          local leaseType = redis.call("TYPE", ARGV[2] .. ids[i]).ok
          if (contentType ~= "none" and contentType ~= "string")
            or (leaseType ~= "none" and leaseType ~= "string") then
            return redis.error_reply("webhook ingress subject reference is inconsistent")
          end
        end
        for i = 1, #ids do
          local id = ids[i]
          redis.call("LREM", KEYS[1], 0, id)
          redis.call("LREM", KEYS[2], 0, id)
          redis.call("LREM", KEYS[3], 0, id)
          redis.call("DEL", ARGV[1] .. id)
          redis.call("DEL", ARGV[2] .. id)
          redis.call("SREM", KEYS[4], id)
        end
        if redis.call("SCARD", KEYS[4]) == 0 then
          redis.call("DEL", KEYS[4])
          redis.call("DEL", KEYS[5])
        end
        return #ids
      `,
      5,
      WEBHOOK_INGRESS_QUEUE_KEY,
      WEBHOOK_INGRESS_PROCESSING_KEY,
      WEBHOOK_INGRESS_DEAD_LETTER_KEY,
      subjectKey,
      getWebhookIngressSubjectLeaseKey(subject),
      WEBHOOK_INGRESS_DELIVERY_PREFIX,
      WEBHOOK_INGRESS_LEASE_PREFIX
    );
    const removed = typeof result === "number" ? result : Number(result) || 0;
    total += removed;
    if (removed < 100) return total;
  }
}

async function reclaimExpiredWebhookIngressDeliveries(
  redis: RedisLike
): Promise<number> {
  const processingDeliveries = await redis.lrange(
    WEBHOOK_INGRESS_PROCESSING_KEY,
    0,
    -1
  );
  let reclaimed = 0;

  for (const raw of processingDeliveries) {
    if ((await redis.get(getWebhookIngressDeliveryLeaseKey(raw))) !== null) {
      continue;
    }

    const removed =
      process.env.NODE_ENV === "test"
        ? await (async () => {
            const count = await redis.lrem(
              WEBHOOK_INGRESS_PROCESSING_KEY,
              1,
              raw
            );
            if (count > 0) await redis.lpush(WEBHOOK_INGRESS_QUEUE_KEY, raw);
            return count;
          })()
        : Number(
            await redis.eval(
              `
          if redis.call("EXISTS", KEYS[3]) == 1 then return 0 end
          local removed = redis.call("LREM", KEYS[1], 1, ARGV[1])
          if removed == 1 then redis.call("LPUSH", KEYS[2], ARGV[1]) end
          return removed
        `,
              3,
              WEBHOOK_INGRESS_PROCESSING_KEY,
              WEBHOOK_INGRESS_QUEUE_KEY,
              getWebhookIngressDeliveryLeaseKey(raw),
              raw
            )
          );
    if (removed > 0) {
      reclaimed += 1;
    }
  }

  if (reclaimed > 0) {
    safeLog("webhook_ingress_deliveries_reclaimed", { count: reclaimed });
  }

  return reclaimed;
}

export function scheduleWebhookIngressDrain(): void {
  if (!isWebhookIngressQueueEnabled()) {
    return;
  }

  if (!drainPromise) {
    drainRequested = false;
    drainPromise = (async () => {
      try {
        const redis = await getRedisClient();
        await reclaimExpiredWebhookIngressDeliveries(redis);

        while (true) {
          const reserved = await reserveWebhookIngressDelivery(redis);
          if (!reserved) {
            return;
          }

          if ("subjectBlocked" in reserved) {
            setTimeout(() => {
              drainRequested = true;
              if (!drainPromise) scheduleWebhookIngressDrain();
            }, getWebhookIngressRetryDelayMs());
            return;
          }

          if ("invalid" in reserved) {
            safeLog("webhook_queued_delivery_invalid", {});
            await completeWebhookIngressDelivery(redis, reserved.raw);
            continue;
          }

          if (
            !reserved.legacyInline &&
            (await isWebhookIngressDeliveryErased(redis, reserved.delivery))
          ) {
            await completeWebhookIngressDelivery(
              redis,
              reserved.raw,
              reserved.delivery,
              false,
              reserved.subjectLease
            );
            continue;
          }

          try {
            await processQueuedWebhookDelivery(reserved.delivery);
          } catch (error) {
            const result = await releaseFailedWebhookIngressDelivery(
              redis,
              reserved,
              error
            );
            if (result === "dead_lettered" || result === "erased") {
              continue;
            }
            setTimeout(() => {
              drainRequested = true;
              if (!drainPromise) scheduleWebhookIngressDrain();
            }, getWebhookIngressRetryDelayMs());
            return;
          }

          await completeWebhookIngressDelivery(
            redis,
            reserved.raw,
            reserved.delivery,
            reserved.legacyInline,
            reserved.subjectLease
          );
        }
      } catch (error) {
        safeLog("webhook_ingress_queue_drain_failed", {
          error: serializeError(error),
        });
      } finally {
        drainPromise = null;
        if (drainRequested) {
          drainRequested = false;
          scheduleWebhookIngressDrain();
        }
      }
    })();
  }
}

export function processWebhookDeliveryInline(
  channel: WebhookChannel,
  payload: unknown
): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Production webhook ingress requires the durable queue");
  }
  setImmediate(() => {
    const processing =
      channel === "facebook"
        ? processAuthenticatedFacebookIngressPayload(payload)
        : processAuthenticatedWhatsAppIngressPayload(payload);
    void processing.catch(error => {
      safeLog("webhook_async_processing_failed", {
        channel,
        error: serializeError(error),
      });
    });
  });
}

export function resetWebhookIngressQueueForTests(): void {
  resetRedisClientForTests();
  drainPromise = null;
  drainRequested = false;
}

export const webhookIngressQueueTestHooks = {
  createFacebookIngressDeliveries,
  createWhatsAppIngressDeliveries,
  processQueuedWebhookDelivery,
  reserveWebhookIngressDelivery,
  completeWebhookIngressDelivery,
  releaseFailedWebhookIngressDelivery,
};
