import { createHash, randomUUID } from "node:crypto";
import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";

import {
  billingAccountingEventLinks,
  billingAccountingImportCursors,
  billingAccountingImportRuns,
  billingAccountingProviderEvents,
  billingWebhookRoutes,
  paymentLedger,
} from "../../../drizzle/schema";
import { getDatabaseOrThrow } from "../../db";
import { assertCanonicalSignedEurAmount } from "./accounting";
import type { MollieMode } from "./config";

const IMPORT_LEASE_MS = 2 * 60_000;

export type MollieAccountingEvent = Readonly<{
  id: string;
  providerType?: string;
  type: "payment" | "refund" | "chargeback" | "fee" | "settlement" | "unknown";
  amount: { currency: "EUR"; value: string };
  netAmount?: { currency: "EUR"; value: string };
  deductionAmount?: { currency: "EUR"; value: string };
  occurredAt: string;
  paymentId?: string;
  settlementId?: string;
}>;

export type MollieAccountingPage = Readonly<{
  events: readonly MollieAccountingEvent[];
  nextCursor: string | null;
}>;

/** GET-only provider boundary. Implementations must never expose raw payloads. */
export interface MollieAccountingReader {
  listEvents(input: {
    mode: MollieMode;
    cursor: string | null;
  }): Promise<MollieAccountingPage>;
}

export class FakeMollieAccountingReader implements MollieAccountingReader {
  private index = 0;
  constructor(private readonly pages: readonly MollieAccountingPage[]) {}

  listEvents(): Promise<MollieAccountingPage> {
    return Promise.resolve(
      this.pages[this.index++] ?? { events: [], nextCursor: null }
    );
  }
}

/**
 * Imports account-wide provider metadata. Tenant ownership is derived only
 * through the exact payment routing index; callers cannot nominate a tenant.
 */
export async function importMollieAccountingEvents(input: {
  providerAccountId: string;
  mode: MollieMode;
  reader: MollieAccountingReader;
  maxPages?: number;
  now?: Date;
}): Promise<{ runId: string; imported: number; quarantined: number }> {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{7,95}$/.test(input.providerAccountId)) {
    throw new Error("invalid accounting provider account");
  }
  const database = await getDatabaseOrThrow();
  const runId = randomUUID();
  const leaseToken = randomUUID();
  const startedAt = input.now ?? new Date();
  const importState = await database.transaction(async tx => {
    await tx
      .insert(billingAccountingImportCursors)
      .values({ providerAccountId: input.providerAccountId, mode: input.mode })
      .onDuplicateKeyUpdate({
        set: { providerAccountId: sql`provider_account_id` },
      });
    const rows = await tx
      .select({
        cursor: billingAccountingImportCursors.cursor,
        highWaterProviderEventId:
          billingAccountingImportCursors.highWaterProviderEventId,
        pendingHighWaterProviderEventId:
          billingAccountingImportCursors.pendingHighWaterProviderEventId,
        leaseUntil: billingAccountingImportCursors.leaseUntil,
      })
      .from(billingAccountingImportCursors)
      .where(accountCursorPredicate(input))
      .limit(1)
      .for("update");
    const current = rows[0];
    if (!current || (current.leaseUntil && current.leaseUntil > startedAt)) {
      throw new Error("accounting_import_busy");
    }
    await tx
      .update(billingAccountingImportRuns)
      .set({
        status: "manual_review",
        errorCode: "accounting_import_stale_run_recovered",
        completedAt: startedAt,
      })
      .where(
        and(
          eq(
            billingAccountingImportRuns.providerAccountId,
            input.providerAccountId
          ),
          eq(billingAccountingImportRuns.mode, input.mode),
          inArray(billingAccountingImportRuns.status, ["pending", "fetching"]),
          lt(
            billingAccountingImportRuns.updatedAt,
            new Date(startedAt.getTime() - IMPORT_LEASE_MS)
          )
        )
      );
    await tx
      .update(billingAccountingImportCursors)
      .set({
        leaseToken,
        leaseUntil: new Date(startedAt.getTime() + IMPORT_LEASE_MS),
      })
      .where(accountCursorPredicate(input));
    await tx.insert(billingAccountingImportRuns).values({
      runId,
      providerAccountId: input.providerAccountId,
      mode: input.mode,
      status: "pending",
      cursor: current.cursor,
    });
    return {
      cursor: current.cursor,
      previousHighWater: current.highWaterProviderEventId,
      pendingHighWater: current.pendingHighWaterProviderEventId,
    };
  });
  let { cursor, previousHighWater, pendingHighWater } = importState;

  const seenCursors = new Set<string>();
  let imported = 0;
  let quarantined = 0;
  let totalEvents = 0;
  const maxPages = Math.max(1, Math.min(1_000, input.maxPages ?? 100));
  try {
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      await setRunState(runId, input, cursor);
      const page = await input.reader.listEvents({ mode: input.mode, cursor });
      validatePage(page, seenCursors);
      const events = page.events.map(validateAccountingEvent);
      totalEvents += events.length;
      if (totalEvents > 25_000) {
        throw new Error("accounting_import_event_limit");
      }
      const pagePlan = planDescendingAccountingPage({
        events,
        nextCursor: page.nextCursor,
        previousHighWater,
        pendingHighWater,
      });
      const now = new Date();
      const pageResult = await database.transaction(async tx => {
        const lease = await tx
          .select({ leaseToken: billingAccountingImportCursors.leaseToken })
          .from(billingAccountingImportCursors)
          .where(
            and(
              accountCursorPredicate(input),
              eq(billingAccountingImportCursors.leaseToken, leaseToken),
              gt(billingAccountingImportCursors.leaseUntil, now)
            )
          )
          .limit(1)
          .for("update");
        if (!lease[0]) throw new Error("accounting_import_lease_lost");

        let applied = 0;
        let pageQuarantined = 0;
        for (const event of pagePlan.eventsToApply) {
          const result = await stageAndLinkEvent(tx, input, event);
          if (result === "applied") applied += 1;
          else if (result === "quarantined") pageQuarantined += 1;
        }
        const cursorUpdate = await tx
          .update(billingAccountingImportCursors)
          .set({
            cursor: pagePlan.resumeCursor,
            highWaterProviderEventId: pagePlan.completed
              ? pagePlan.nextHighWater
              : previousHighWater,
            pendingHighWaterProviderEventId: pagePlan.completed
              ? null
              : pagePlan.pendingHighWater,
            leaseUntil: new Date(now.getTime() + IMPORT_LEASE_MS),
          })
          .where(
            and(
              accountCursorPredicate(input),
              eq(billingAccountingImportCursors.leaseToken, leaseToken),
              gt(billingAccountingImportCursors.leaseUntil, now)
            )
          );
        if (extractAffectedRows(cursorUpdate) !== 1) {
          throw new Error("accounting_import_lease_lost");
        }
        await tx
          .update(billingAccountingImportRuns)
          .set({
            status: pageQuarantined ? "manual_review" : "staged",
            cursor: pagePlan.resumeCursor,
            errorCode: pageQuarantined ? "accounting_event_quarantined" : null,
          })
          .where(eq(billingAccountingImportRuns.runId, runId));
        return { applied, pageQuarantined };
      });
      imported += pageResult.applied;
      quarantined += pageResult.pageQuarantined;
      cursor = pagePlan.resumeCursor;
      pendingHighWater = pagePlan.completed ? null : pagePlan.pendingHighWater;
      if (pagePlan.completed) {
        previousHighWater = pagePlan.nextHighWater;
        break;
      }
      if (pageIndex === maxPages - 1) {
        throw new Error("accounting_import_page_limit");
      }
    }
    await database.transaction(async tx => {
      await tx
        .update(billingAccountingImportRuns)
        .set({
          status: quarantined ? "manual_review" : "applied",
          completedAt: new Date(),
          errorCode: quarantined ? "accounting_event_quarantined" : null,
        })
        .where(eq(billingAccountingImportRuns.runId, runId));
      const completedAt = new Date();
      const cursorRelease = await tx
        .update(billingAccountingImportCursors)
        .set({
          leaseToken: null,
          leaseUntil: null,
          cursor: null,
          pendingHighWaterProviderEventId: null,
          consecutiveFailures: 0,
          lastSuccessfulAt: completedAt,
        })
        .where(
          and(
            accountCursorPredicate(input),
            eq(billingAccountingImportCursors.leaseToken, leaseToken),
            gt(billingAccountingImportCursors.leaseUntil, completedAt)
          )
        );
      if (extractAffectedRows(cursorRelease) !== 1) {
        throw new Error("accounting_import_lease_lost");
      }
    });
    return { runId, imported, quarantined };
  } catch (error) {
    await database.transaction(async tx => {
      await tx
        .update(billingAccountingImportRuns)
        .set({ status: "manual_review", errorCode: safeErrorCode(error) })
        .where(eq(billingAccountingImportRuns.runId, runId));
      await tx
        .update(billingAccountingImportCursors)
        .set({
          leaseToken: null,
          leaseUntil: null,
          consecutiveFailures: sql`LEAST(consecutive_failures + 1, 20)`,
        })
        .where(
          and(
            accountCursorPredicate(input),
            eq(billingAccountingImportCursors.leaseToken, leaseToken)
          )
        );
    });
    throw error;
  }
}

function extractAffectedRows(result: unknown): number {
  const metadata: unknown = Array.isArray(result)
    ? (result as unknown[])[0]
    : result;
  return Number((metadata as { affectedRows?: number })?.affectedRows ?? 0);
}

type AccountingTransaction = Parameters<
  Parameters<Awaited<ReturnType<typeof getDatabaseOrThrow>>["transaction"]>[0]
>[0];

async function stageAndLinkEvent(
  tx: AccountingTransaction,
  input: { providerAccountId: string; mode: MollieMode },
  event: MollieAccountingEvent
): Promise<"applied" | "quarantined"> {
  const digest = accountingEventDigest(event);
  await tx
    .insert(billingAccountingProviderEvents)
    .values({
      providerAccountId: input.providerAccountId,
      mode: input.mode,
      providerEventId: event.id,
      providerType: event.providerType ?? event.type,
      eventType: event.type,
      eventDigest: digest,
      amount: event.amount.value,
      netAmount: event.netAmount?.value ?? event.amount.value,
      deductionAmount: event.deductionAmount?.value ?? null,
      currency: event.amount.currency,
      occurredAt: new Date(event.occurredAt),
      molliePaymentId: event.paymentId ?? null,
      settlementId: event.settlementId ?? null,
      status: "staged",
    })
    .onDuplicateKeyUpdate({ set: { providerEventId: sql`provider_event_id` } });
  const stored = await tx
    .select({
      id: billingAccountingProviderEvents.id,
      digest: billingAccountingProviderEvents.eventDigest,
    })
    .from(billingAccountingProviderEvents)
    .where(
      and(
        eq(
          billingAccountingProviderEvents.providerAccountId,
          input.providerAccountId
        ),
        eq(billingAccountingProviderEvents.mode, input.mode),
        eq(billingAccountingProviderEvents.providerEventId, event.id)
      )
    )
    .limit(1)
    .for("update");
  if (!stored[0]) throw new Error("accounting_event_stage_failed");
  const existingLinks = await tx
    .select({ status: billingAccountingEventLinks.linkStatus })
    .from(billingAccountingEventLinks)
    .where(eq(billingAccountingEventLinks.providerEventId, stored[0].id))
    .limit(1)
    .for("update");
  if (existingLinks[0]?.status === "conflict") {
    return "quarantined";
  }
  if (stored[0].digest !== digest) {
    await upsertAccountingLink(
      tx,
      stored[0].id,
      input.mode,
      null,
      null,
      "conflict"
    );
    await setAccountingEventStatus(tx, stored[0].id, "quarantined");
    return "quarantined";
  }

  const linked = await linkAccountingEvent(tx, {
    id: stored[0].id,
    eventType: event.type,
    paymentId: event.paymentId ?? null,
    mode: input.mode,
  });
  return linked ? "applied" : "quarantined";
}

async function linkAccountingEvent(
  tx: AccountingTransaction,
  input: {
    id: number;
    eventType: MollieAccountingEvent["type"];
    paymentId: string | null;
    mode: MollieMode;
  }
): Promise<boolean> {
  if (input.eventType === "unknown") {
    await upsertAccountingLink(tx, input.id, input.mode, null, null, "unknown");
    await setAccountingEventStatus(tx, input.id, "quarantined");
    return false;
  }
  if (!input.paymentId) {
    const accountLevel =
      input.eventType === "fee" || input.eventType === "settlement";
    await upsertAccountingLink(
      tx,
      input.id,
      input.mode,
      null,
      null,
      accountLevel ? "account_level" : "unknown"
    );
    await setAccountingEventStatus(
      tx,
      input.id,
      accountLevel ? "applied" : "quarantined"
    );
    return accountLevel;
  }

  const routes = await tx
    .select({ workspaceId: billingWebhookRoutes.workspaceId })
    .from(billingWebhookRoutes)
    .where(
      and(
        eq(billingWebhookRoutes.mode, input.mode),
        eq(billingWebhookRoutes.molliePaymentId, input.paymentId)
      )
    )
    .limit(1);
  const workspaceId = routes[0]?.workspaceId;
  if (!workspaceId) {
    await upsertAccountingLink(tx, input.id, input.mode, null, null, "unknown");
    await setAccountingEventStatus(tx, input.id, "quarantined");
    return false;
  }
  const ledgerRows = await tx
    .select({ id: paymentLedger.id })
    .from(paymentLedger)
    .where(
      and(
        eq(paymentLedger.workspaceId, workspaceId),
        eq(paymentLedger.mode, input.mode),
        eq(paymentLedger.molliePaymentId, input.paymentId)
      )
    )
    .limit(2)
    .for("update");
  const status =
    ledgerRows.length === 1
      ? "linked"
      : ledgerRows.length === 0
        ? "unknown"
        : "conflict";
  await upsertAccountingLink(
    tx,
    input.id,
    input.mode,
    status === "linked" ? workspaceId : null,
    status === "linked" ? ledgerRows[0].id : null,
    status
  );
  await setAccountingEventStatus(
    tx,
    input.id,
    status === "linked" ? "applied" : "quarantined"
  );
  return status === "linked";
}

export async function reconcileMollieAccountingQuarantine(input: {
  providerAccountId: string;
  mode: MollieMode;
  limit?: number;
}): Promise<number> {
  const database = await getDatabaseOrThrow();
  const limit = Math.max(1, Math.min(500, input.limit ?? 100));
  return database.transaction(async tx => {
    const rows = await tx
      .select({
        id: billingAccountingProviderEvents.id,
        eventType: billingAccountingProviderEvents.eventType,
        paymentId: billingAccountingProviderEvents.molliePaymentId,
      })
      .from(billingAccountingProviderEvents)
      .innerJoin(
        billingAccountingEventLinks,
        eq(
          billingAccountingEventLinks.providerEventId,
          billingAccountingProviderEvents.id
        )
      )
      .where(
        and(
          eq(
            billingAccountingProviderEvents.providerAccountId,
            input.providerAccountId
          ),
          eq(billingAccountingProviderEvents.mode, input.mode),
          eq(billingAccountingProviderEvents.status, "quarantined"),
          eq(billingAccountingEventLinks.linkStatus, "unknown")
        )
      )
      .orderBy(billingAccountingProviderEvents.id)
      .limit(limit)
      .for("update", { skipLocked: true });
    let relinked = 0;
    for (const row of rows) {
      if (
        await linkAccountingEvent(tx, {
          id: row.id,
          eventType: row.eventType,
          paymentId: row.paymentId,
          mode: input.mode,
        })
      ) {
        relinked += 1;
      }
    }
    return relinked;
  });
}

async function upsertAccountingLink(
  tx: AccountingTransaction,
  providerEventId: number,
  mode: MollieMode,
  workspaceId: number | null,
  paymentLedgerId: number | null,
  linkStatus: "linked" | "unknown" | "conflict" | "account_level"
): Promise<void> {
  await tx
    .insert(billingAccountingEventLinks)
    .values({ providerEventId, mode, workspaceId, paymentLedgerId, linkStatus })
    .onDuplicateKeyUpdate({
      set: { workspaceId, paymentLedgerId, linkStatus },
    });
}

async function setAccountingEventStatus(
  tx: AccountingTransaction,
  id: number,
  status: "applied" | "quarantined"
): Promise<void> {
  await tx
    .update(billingAccountingProviderEvents)
    .set({ status })
    .where(eq(billingAccountingProviderEvents.id, id));
}

function accountCursorPredicate(input: {
  providerAccountId: string;
  mode: MollieMode;
}) {
  return and(
    eq(
      billingAccountingImportCursors.providerAccountId,
      input.providerAccountId
    ),
    eq(billingAccountingImportCursors.mode, input.mode)
  );
}

async function setRunState(
  runId: string,
  input: { providerAccountId: string; mode: MollieMode },
  cursor: string | null
): Promise<void> {
  const database = await getDatabaseOrThrow();
  await database
    .update(billingAccountingImportRuns)
    .set({ status: "fetching", cursor })
    .where(
      and(
        eq(billingAccountingImportRuns.runId, runId),
        eq(
          billingAccountingImportRuns.providerAccountId,
          input.providerAccountId
        ),
        eq(billingAccountingImportRuns.mode, input.mode)
      )
    );
}

function validatePage(
  page: MollieAccountingPage,
  seenCursors: Set<string>
): void {
  if (!Array.isArray(page.events)) {
    throw new Error("billing_accounting_data_quality");
  }
  if (page.events.length > 250) {
    throw new Error("accounting_import_event_limit");
  }
  if (page.nextCursor !== null) {
    if (
      typeof page.nextCursor !== "string" ||
      page.nextCursor.length < 1 ||
      page.nextCursor.length > 255 ||
      seenCursors.has(page.nextCursor)
    ) {
      throw new Error("accounting_import_invalid_cursor");
    }
    seenCursors.add(page.nextCursor);
  }
}

/**
 * Mollie balance transactions are newest-first. A completed run always starts
 * at the head; a crashed run resumes its saved page chain, then the following
 * run catches anything that arrived while it was recovering.
 */
export function planDescendingAccountingPage(input: {
  events: readonly MollieAccountingEvent[];
  nextCursor: string | null;
  previousHighWater: string | null;
  pendingHighWater: string | null;
}): {
  eventsToApply: readonly MollieAccountingEvent[];
  resumeCursor: string | null;
  pendingHighWater: string | null;
  nextHighWater: string | null;
  completed: boolean;
} {
  const pendingHighWater =
    input.pendingHighWater ?? input.events[0]?.id ?? input.previousHighWater;
  const previousIndex = input.previousHighWater
    ? input.events.findIndex(event => event.id === input.previousHighWater)
    : -1;
  const completed = previousIndex >= 0 || input.nextCursor === null;
  return {
    eventsToApply:
      previousIndex >= 0 ? input.events.slice(0, previousIndex) : input.events,
    resumeCursor: completed ? null : input.nextCursor,
    pendingHighWater,
    nextHighWater: completed ? pendingHighWater : input.previousHighWater,
    completed,
  };
}

export function validateAccountingEvent(
  value: MollieAccountingEvent
): MollieAccountingEvent {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{5,95}$/.test(value.id) ||
    ![
      "payment",
      "refund",
      "chargeback",
      "fee",
      "settlement",
      "unknown",
    ].includes(value.type) ||
    !isCanonicalProviderTimestamp(value.occurredAt)
  ) {
    throw new Error("billing_accounting_data_quality");
  }
  assertCanonicalSignedEurAmount(value.amount?.value, value.amount?.currency);
  if (value.netAmount) {
    assertCanonicalSignedEurAmount(
      value.netAmount.value,
      value.netAmount.currency
    );
  }
  if (value.deductionAmount) {
    assertCanonicalSignedEurAmount(
      value.deductionAmount.value,
      value.deductionAmount.currency
    );
  }
  const amountMinor = signedMinor(value.amount.value);
  const deductionMinor = value.deductionAmount
    ? signedMinor(value.deductionAmount.value)
    : null;
  const netMinor = value.netAmount
    ? signedMinor(value.netAmount.value)
    : amountMinor;
  if (
    (value.type === "payment" && amountMinor < BigInt(0)) ||
    ((value.type === "refund" ||
      value.type === "chargeback" ||
      value.type === "fee") &&
      amountMinor > BigInt(0)) ||
    (deductionMinor !== null && deductionMinor < BigInt(0))
  ) {
    throw new Error("billing_accounting_data_quality");
  }
  if (
    value.netAmount &&
    netMinor !== amountMinor - (deductionMinor ?? BigInt(0))
  ) {
    throw new Error("billing_accounting_data_quality");
  }
  if (
    value.providerType !== undefined &&
    !/^[a-z][a-z0-9-]{1,63}$/.test(value.providerType)
  ) {
    throw new Error("billing_accounting_data_quality");
  }
  if (value.paymentId && !/^tr_[A-Za-z0-9]{6,61}$/.test(value.paymentId)) {
    throw new Error("billing_accounting_data_quality");
  }
  if (
    value.settlementId &&
    !/^[A-Za-z0-9][A-Za-z0-9_-]{5,95}$/.test(value.settlementId)
  ) {
    throw new Error("billing_accounting_data_quality");
  }
  return value;
}

function signedMinor(value: string): bigint {
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const minor = BigInt(digits.replace(".", ""));
  return negative ? -minor : minor;
}

function isCanonicalProviderTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    return false;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function accountingEventDigest(event: MollieAccountingEvent): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "billing-accounting-event-v1",
        event.id,
        event.type,
        event.providerType ?? event.type,
        event.amount.currency,
        event.amount.value,
        event.netAmount?.currency ?? null,
        event.netAmount?.value ?? null,
        event.deductionAmount?.currency ?? null,
        event.deductionAmount?.value ?? null,
        event.occurredAt,
        event.paymentId ?? null,
        event.settlementId ?? null,
      ])
    )
    .digest("hex");
}

function safeErrorCode(error: unknown): string {
  const allowed = new Set([
    "accounting_import_busy",
    "accounting_import_event_limit",
    "accounting_import_invalid_cursor",
    "accounting_import_lease_lost",
    "accounting_import_page_limit",
    "billing_accounting_data_quality",
    "mollie_accounting_permanent_failure",
    "mollie_accounting_transient_failure",
  ]);
  return error instanceof Error && allowed.has(error.message)
    ? error.message
    : "accounting_import_failed";
}
