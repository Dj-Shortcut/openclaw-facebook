import type { Express, NextFunction, Request, Response } from "express";

import { escapeHtml } from "../html";
import { assertMessengerPrivacySubject } from "../messengerPrivacySubject";
import { resolveMessengerGenerationOwnership } from "../workspaceEntitlementRuntime";
import {
  PREMIUM_IMAGE_CREDITS_PER_PURCHASE,
  PREMIUM_IMAGE_CREDITS_PLAN_CODE,
  formatAmountMinor,
  requireActiveBillingPlan,
} from "./catalog";
import { startMollieCheckout } from "./checkoutService";
import { getBillingSupportEmail } from "./config";
import { readPremiumCreditCheckoutToken } from "./premiumCreditCheckoutToken";

export function registerPremiumCreditRoutes(
  app: Express,
  dependencies: {
    startCheckout?: typeof startMollieCheckout;
    readCheckoutToken?: typeof readPremiumCreditCheckoutToken;
    assertPrivacySubject?: typeof assertMessengerPrivacySubject;
    resolveOwnership?: typeof resolveMessengerGenerationOwnership;
  } = {}
): void {
  const startCheckout = dependencies.startCheckout ?? startMollieCheckout;
  const readCheckoutToken =
    dependencies.readCheckoutToken ?? readPremiumCreditCheckoutToken;
  const assertPrivacySubject =
    dependencies.assertPrivacySubject ?? assertMessengerPrivacySubject;
  const resolveOwnership =
    dependencies.resolveOwnership ?? resolveMessengerGenerationOwnership;

  app.get("/credits", (req, res) => {
    const token = readToken(req.query.token);
    if (!token) return notFound(res);
    try {
      readCheckoutToken(token);
      const plan = requireActiveBillingPlan(PREMIUM_IMAGE_CREDITS_PLAN_CODE);
      res
        .status(200)
        .type("html")
        .set("Cache-Control", "private, no-store, max-age=0")
        .set("Referrer-Policy", "no-referrer")
        .send(
          renderOffer({
            token,
            amount: formatAmountMinor(plan.amountMinor),
            supportEmail: getBillingSupportEmail(),
          })
        );
    } catch {
      notFound(res);
    }
  });

  app.post(
    "/api/credits/checkout",
    asyncRoute(async (req, res) => {
      const token = readBodyToken(req.body as unknown);
      if (!token) return notFound(res);
      let capability: ReturnType<typeof readPremiumCreditCheckoutToken>;
      try {
        capability = readCheckoutToken(token);
        await assertPrivacySubject({
          workspaceId: capability.workspaceId,
          channelConnectionId: capability.channelConnectionId,
          userKey: capability.userKey,
          privacyEpoch: capability.privacyEpoch,
        });
        const ownership = await resolveOwnership(capability.pageId);
        if (
          !ownership ||
          ownership.workspaceId !== capability.workspaceId ||
          ownership.channelConnectionId !== capability.channelConnectionId ||
          ownership.bindingEpoch !== capability.bindingEpoch
        ) {
          throw new Error("checkout ownership changed");
        }
      } catch {
        return notFound(res);
      }

      const checkout = await startCheckout({
        workspaceId: capability.workspaceId,
        planCode: PREMIUM_IMAGE_CREDITS_PLAN_CODE,
        kind: "premium_credit_purchase",
        messengerSenderUserKey: capability.userKey,
        messengerPageId: capability.pageId,
        messengerChannelConnectionId: capability.channelConnectionId,
        messengerPrivacyEpoch: capability.privacyEpoch,
        checkoutScopeKey: capability.checkoutScopeKey,
      });
      res
        .status(303)
        .set("Cache-Control", "private, no-store, max-age=0")
        .set("Location", checkout.checkoutUrl)
        .send("Verder naar Mollie");
    })
  );

  app.get("/credits/return", (_req, res) => {
    res
      .status(200)
      .type("html")
      .set("Cache-Control", "private, no-store, max-age=0")
      .send(renderReturn());
  });
}

function renderOffer(input: {
  token: string;
  amount: string;
  supportEmail: string;
}): string {
  return `<!doctype html>
<html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Leaderbot premium credits</title></head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:24px;line-height:1.5">
<main><h1>Maak betere afbeeldingen</h1>
<p><strong>${PREMIUM_IMAGE_CREDITS_PER_PURCHASE} premium credits voor €${escapeHtml(input.amount)}</strong></p>
<ul><li>Hogere afbeeldingskwaliteit</li><li>Credits hebben geen vervaldatum</li><li>Eenmalige betaling via Mollie</li></ul>
<p>Geen abonnement, automatische verlenging, automatische top-up of gebruikskosten achteraf.</p>
<form method="post" action="/api/credits/checkout">
<input type="hidden" name="token" value="${escapeHtml(input.token)}">
<button type="submit" style="font:inherit;padding:12px 18px">Bestelling met betaalverplichting – betaal €${escapeHtml(input.amount)}</button>
</form>
<p>Je kunt dit venster ook sluiten en morgen opnieuw gratis afbeeldingen maken.</p>
<p>Vragen: <a href="mailto:${escapeHtml(input.supportEmail)}">${escapeHtml(input.supportEmail)}</a></p>
</main></body></html>`;
}

function renderReturn(): string {
  return `<!doctype html><html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Betaling ontvangen</title></head>
<body style="font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:24px;line-height:1.5"><main>
<h1>We controleren je betaling</h1><p>Je credits worden uitsluitend toegekend nadat Mollie de betaling via de beveiligde webhook heeft bevestigd. Je mag dit venster sluiten en terugkeren naar Messenger.</p>
</main></body></html>`;
}

function readToken(value: unknown): string | null {
  return typeof value === "string" && value.length <= 4096 ? value : null;
}

function readBodyToken(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return readToken((value as Record<string, unknown>).token);
}

function notFound(res: Response): void {
  res.status(404).type("text/plain").send("Niet gevonden");
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}
