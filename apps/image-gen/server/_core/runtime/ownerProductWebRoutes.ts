import type { Express, NextFunction, Request, Response } from "express";

export function isLegacyCustomerPortalEnabled(): boolean {
  return process.env.LEGACY_CUSTOMER_PORTAL_ENABLED === "true";
}

export function registerOwnerProductWebRoutes(app: Express): void {
  app.get("/", (_req, res) => {
    res
      .status(200)
      .type("html")
      .set("Cache-Control", "public, max-age=300")
      .send(renderOwnerLanding());
  });

  if (isLegacyCustomerPortalEnabled()) return;

  app.all(["/portal", "/handoff", "/handoff/:token"], (_req, res) => {
    res.status(404).type("text/plain").send("Not found");
  });

  app.use("/api/trpc", (req: Request, res: Response, next: NextFunction) => {
    const procedure = req.path.replace(/^\//, "");
    if (procedure.startsWith("portal.") || procedure.startsWith("auth.")) {
      res.status(404).json({ error: "not found" });
      return;
    }
    next();
  });
}

function renderOwnerLanding(): string {
  return `<!doctype html>
<html lang="nl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="Leaderbot is een owner-operated afbeeldingsbot voor Facebook Messenger.">
<title>Leaderbot Messenger Image Bot</title></head>
<body style="font-family:system-ui,sans-serif;max-width:720px;margin:48px auto;padding:24px;line-height:1.55;background:#10211d;color:#f5f5f4">
<main><p style="color:#bef264;font-weight:700">LEADERBOT</p><h1>Afbeeldingen maken in Messenger</h1>
<p>Leaderbot is een door de eigenaar beheerde Facebook Messenger-bot. Gebruikers krijgen een begrensd gratis dagtegoed om afbeeldingen te maken en te bewerken.</p>
<p>Wanneer het gratis dagtegoed op is, kan Messenger optioneel vijf premium afbeeldingscredits voor €3 aanbieden. Dat is één betaling via Mollie, zonder abonnement, automatische verlenging, automatische top-up of kosten achteraf.</p>
<p>De aankoopknop verschijnt alleen in de actieve Messenger-conversatie en pas wanneer de betaalflow veilig is geactiveerd. Je kunt ook niets kopen en de volgende dag opnieuw het gratis tegoed gebruiken.</p>
<nav><a style="color:#bef264" href="/privacy">Privacy</a> · <a style="color:#bef264" href="/terms">Voorwaarden</a> · <a style="color:#bef264" href="/billing-policy">Prijzen en betaling</a> · <a style="color:#bef264" href="/data-deletion">Data verwijderen</a></nav>
</main></body></html>`;
}
