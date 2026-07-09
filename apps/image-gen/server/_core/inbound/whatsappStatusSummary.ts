import {
  arrayProperty,
  objectValue,
  stringProperty,
} from "./whatsappPayloadAccess";

type WhatsAppStatusErrorSummary = {
  code: number | string | null;
  title: string | null;
};

export type WhatsAppStatusSummary = {
  statusCount?: number;
  statuses?: Record<string, number>;
  errors?: WhatsAppStatusErrorSummary[];
};

export function summarizeWhatsAppStatuses(payload: unknown): WhatsAppStatusSummary {
  const statuses = arrayPropertyFromPayload(payload, "statuses");
  if (statuses.length === 0) {
    return {};
  }

  const counts: Record<string, number> = {};
  const errors: WhatsAppStatusErrorSummary[] = [];
  for (const status of statuses) {
    incrementStatusCount(counts, status);
    errors.push(...readStatusErrors(status));
  }

  return {
    statusCount: statuses.length,
    statuses: counts,
    ...(errors.length > 0 ? { errors: errors.slice(0, 5) } : {}),
  };
}

function incrementStatusCount(counts: Record<string, number>, status: unknown): void {
  const statusName = stringProperty(status, "status") ?? "unknown";
  counts[statusName] = (counts[statusName] ?? 0) + 1;
}

function readStatusErrors(status: unknown): WhatsAppStatusErrorSummary[] {
  return arrayProperty(status, "errors").map(readStatusError);
}

function readStatusError(error: unknown): WhatsAppStatusErrorSummary {
  return {
    code: normalizeStatusErrorCode(objectValue(error)?.code),
    title: stringProperty(error, "title"),
  };
}

function normalizeStatusErrorCode(code: unknown): number | string | null {
  return typeof code === "number" || typeof code === "string" ? code : null;
}

function arrayPropertyFromPayload(payload: unknown, key: string): unknown[] {
  return arrayProperty(payload, "entry")
    .flatMap(entry => arrayProperty(entry, "changes"))
    .flatMap(change => arrayProperty(objectValue(change)?.value, key));
}
