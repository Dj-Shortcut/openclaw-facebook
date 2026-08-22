import type { Express, NextFunction, Request, Response } from "express";
import * as db from "../../db";
import {
  authenticatePortalRequest,
  requirePortalWorkspace,
} from "../portalAuth";
import { escapeHtml } from "../html";
import { getMollieConfig } from "./config";
import {
  getWorkspaceLedgerPayment,
  getWorkspaceAccountingHighWaterId,
  listWorkspaceAccountingEntryBatch,
} from "./subscriptionStore";
import { sumActiveChargebacks, sumCompletedRefunds } from "./accounting";
import { assertCanonicalEurAmount } from "./accounting";
import { safeLog } from "../logger";

const PAYMENT_ID_PATTERN = /^tr_[A-Za-z0-9]{1,60}$/;

export function registerBillingPortalRoutes(app: Express): void {
  app.get(
    "/api/portal/billing/receipts/:paymentId",
    asyncRoute(async (req, res) => {
      const access = await requireBillingManagerAccess(req, res);
      if (!access) return;
      const paymentIdParam = req.params.paymentId;
      const paymentId = Array.isArray(paymentIdParam)
        ? paymentIdParam[0]
        : paymentIdParam;
      if (!paymentId || !PAYMENT_ID_PATTERN.test(paymentId)) {
        res.status(404).send("Not found");
        return;
      }
      const config = getMollieConfig();
      const payment = await getWorkspaceLedgerPayment(
        access.workspaceId,
        config.mode,
        paymentId
      );
      if (!payment) {
        res.status(404).send("Not found");
        return;
      }
      const supportEmail = config.billingSupportEmail;
      res
        .status(200)
        .type("html")
        .set("Cache-Control", "private, no-store, max-age=0")
        .send(renderPaymentReceipt(payment, supportEmail));
    })
  );

  app.get(
    "/api/portal/billing/export.csv",
    asyncRoute(async (req, res) => {
      const access = await requireBillingManagerAccess(req, res);
      if (!access) return;
      const config = getMollieConfig();
      const range = parseAccountingRange(req);
      if (!range) {
        res.status(400).json({ error: "invalid accounting export range" });
        return;
      }
      const streamInput = {
        workspaceId: access.workspaceId,
        mode: config.mode,
        from: range.from,
        until: range.until,
      } as const;
      const highWaterId = await getWorkspaceAccountingHighWaterId(streamInput);
      const firstEntries = await listWorkspaceAccountingEntryBatch({
        ...streamInput,
        highWaterId,
        limit: 500,
      });
      validateAccountingEntries(firstEntries);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="leaderbot-billing-${config.mode}-${access.workspaceId}-${range.fromText}-${range.untilText}.csv"`
      );
      res.status(200);
      try {
        await streamAccountingCsv(
          res,
          { ...streamInput, highWaterId },
          firstEntries
        );
      } catch (error) {
        safeLog("billing_accounting_export_stream_failed", {
          level: "error",
          workspaceId: access.workspaceId,
          mode: config.mode,
          errorCode: error instanceof Error ? error.name : "UnknownError",
        });
        if (!res.destroyed)
          res.destroy(error instanceof Error ? error : undefined);
      }
    })
  );
}

async function requireBillingManagerAccess(req: Request, res: Response) {
  const user = await authenticatePortalRequest(req, res);
  if (!user) return null;
  const workspaceId = Number(req.query.workspaceId);
  if (!Number.isSafeInteger(workspaceId) || workspaceId <= 0) {
    res.status(400).json({ error: "invalid request" });
    return null;
  }
  const workspace = await requirePortalWorkspace(user, res, workspaceId);
  if (!workspace) return null;
  const membership = await db.getWorkspaceMembership(workspaceId, user.id);
  if (
    !membership ||
    (membership.role !== "owner" && membership.role !== "admin")
  ) {
    res.status(403).json({ error: "billing admin required" });
    return null;
  }
  return { workspaceId };
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

function renderPaymentReceipt(
  payment: Awaited<ReturnType<typeof getWorkspaceLedgerPayment>> & {},
  supportEmail: string
): string {
  if (!payment) return "";
  return `<!doctype html>
<html lang="nl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Leaderbot betalingsbewijs</title></head>
<body style="font-family:Arial,sans-serif;max-width:720px;margin:40px auto;padding:24px;line-height:1.5">
  <h1>Leaderbot betalingsbewijs</h1>
  <p><strong>Nummer:</strong> ${escapeHtml(payment.invoiceNumber ?? "")}</p>
  <p><strong>Boekingsdatum:</strong> ${escapeHtml(payment.occurredAt.toISOString())}</p>
  <p><strong>Bedrag:</strong> ${escapeHtml(payment.grossAmount)} ${escapeHtml(payment.currency)}</p>
  <p><strong>Status:</strong> ${escapeHtml(payment.status)}</p>
  <p><strong>Mollie payment-ID:</strong> ${escapeHtml(payment.molliePaymentId)}</p>
  <p><strong>BTW:</strong> Bijzondere vrijstellingsregeling kleine ondernemingen</p>
  <p>Dit B2C-betalingsbewijs is geen Peppol-factuur.</p>
  <p>Vragen: <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a></p>
</body></html>`;
}

const ACCOUNTING_EXPORT_MAX_MS = 366 * 24 * 60 * 60_000;

function parseAccountingRange(req: Request) {
  const fromText = typeof req.query.from === "string" ? req.query.from : "";
  const untilText = typeof req.query.until === "string" ? req.query.until : "";
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(fromText) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(untilText)
  ) {
    return null;
  }
  const from = new Date(`${fromText}T00:00:00.000Z`);
  const until = new Date(`${untilText}T00:00:00.000Z`);
  const duration = until.getTime() - from.getTime();
  if (
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(until.getTime()) ||
    from.toISOString().slice(0, 10) !== fromText ||
    until.toISOString().slice(0, 10) !== untilText ||
    duration <= 0 ||
    duration > ACCOUNTING_EXPORT_MAX_MS
  ) {
    return null;
  }
  return { from, until, fromText, untilText };
}

async function streamAccountingCsv(
  res: Response,
  input: {
    workspaceId: number;
    mode: "test" | "live";
    from: Date;
    until: Date;
    highWaterId: number;
  },
  firstEntries: Awaited<ReturnType<typeof listWorkspaceAccountingEntryBatch>>
): Promise<void> {
  const header = [
    "mode",
    "booking_date",
    "workspace_id",
    "invoice_number",
    "mollie_payment_id",
    "status",
    "currency",
    "gross_sales",
    "mollie_fees",
    "refunds",
    "chargebacks",
    "net_settlement",
    "settlement_id",
    "vat_note",
  ];
  await writeCsvChunk(res, `\uFEFF${header.map(csvCell).join(",")}\r\n`);
  let cursor: { occurredAt: Date; id: number } | undefined;
  let entries = firstEntries;
  while (!res.destroyed && !res.writableEnded) {
    validateAccountingEntries(entries);
    for (const entry of entries) {
      if (res.destroyed || res.writableEnded) return;
      const row = [
        input.mode,
        entry.occurredAt.toISOString(),
        String(input.workspaceId),
        entry.invoiceNumber ?? "",
        entry.molliePaymentId,
        entry.status,
        entry.currency,
        entry.grossAmount,
        // Provider fee/settlement columns remain blank until the separate
        // read-only balance reconciliation has produced verified events.
        "",
        sumCompletedRefunds(entry.refunds),
        sumActiveChargebacks(entry.chargebacks),
        "",
        "",
        "Bijzondere vrijstellingsregeling kleine ondernemingen",
      ];
      await writeCsvChunk(
        res,
        `${row.map(value => csvCell(value ?? "")).join(",")}\r\n`
      );
    }
    if (entries.length < 500) break;
    const last = entries.at(-1)!;
    cursor = { occurredAt: last.occurredAt, id: last.id };
    if (res.destroyed || res.writableEnded) return;
    entries = await listWorkspaceAccountingEntryBatch({
      ...input,
      cursor,
      limit: 500,
    });
  }
  if (!res.destroyed && !res.writableEnded) res.end();
}

function validateAccountingEntries(
  entries: Awaited<ReturnType<typeof listWorkspaceAccountingEntryBatch>>
): void {
  for (const entry of entries) {
    assertCanonicalEurAmount(entry.grossAmount, entry.currency);
    void sumCompletedRefunds(entry.refunds);
    void sumActiveChargebacks(entry.chargebacks);
  }
}

function csvCell(value: string): string {
  const safe = /^[\p{C}\p{Z}]*[=+\-@]/u.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

async function writeCsvChunk(res: Response, chunk: string): Promise<void> {
  if (res.destroyed || res.writableEnded) {
    throw new Error("accounting export client disconnected");
  }
  if (res.write(chunk)) return;
  await new Promise<void>((resolve, reject) => {
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("accounting export client disconnected"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      res.off("drain", onDrain);
      res.off("close", onClose);
      res.off("error", onError);
    };
    res.once("drain", onDrain);
    res.once("close", onClose);
    res.once("error", onError);
  });
}
