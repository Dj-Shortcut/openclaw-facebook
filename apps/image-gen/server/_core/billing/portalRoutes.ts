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
  listWorkspaceAccountingEntries,
} from "./subscriptionStore";
import { sumActiveChargebacks, sumCompletedRefunds } from "./accounting";

const PAYMENT_ID_PATTERN = /^tr_[A-Za-z0-9]{1,60}$/;

export function registerBillingPortalRoutes(app: Express): void {
  app.get(
    "/api/portal/billing/receipts/:paymentId",
    asyncRoute(async (req, res) => {
      const access = await requireBillingAccess(req, res);
      if (!access) return;
      const paymentId = req.params.paymentId;
      if (!PAYMENT_ID_PATTERN.test(paymentId)) {
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
      const access = await requireBillingAccess(req, res, true);
      if (!access) return;
      const config = getMollieConfig();
      const entries = await listWorkspaceAccountingEntries(
        access.workspaceId,
        config.mode
      );
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Cache-Control", "private, no-store, max-age=0");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="leaderbot-billing-${access.workspaceId}.csv"`
      );
      res.status(200).send(renderAccountingCsv(access.workspaceId, entries));
    })
  );
}

async function requireBillingAccess(
  req: Request,
  res: Response,
  requireAdmin = false
) {
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
    requireAdmin &&
    (!membership ||
      (membership.role !== "owner" && membership.role !== "admin"))
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

function renderAccountingCsv(
  workspaceId: number,
  entries: Awaited<ReturnType<typeof listWorkspaceAccountingEntries>>
): string {
  const header = [
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
  const rows = entries.map(entry => [
    entry.occurredAt.toISOString(),
    String(workspaceId),
    entry.invoiceNumber ?? "",
    entry.molliePaymentId,
    entry.status,
    entry.currency,
    entry.grossAmount,
    entry.mollieFees ?? "",
    sumCompletedRefunds(entry.refunds),
    sumActiveChargebacks(entry.chargebacks),
    entry.settlementAmount ?? "",
    entry.settlementId ?? "",
    "Bijzondere vrijstellingsregeling kleine ondernemingen",
  ]);
  return `\uFEFF${[header, ...rows]
    .map(row => row.map(value => csvCell(value ?? "")).join(","))
    .join("\r\n")}\r\n`;
}

function csvCell(value: string): string {
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}
