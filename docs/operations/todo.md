# Leaderbot - Production outcomes

> Enige bron van waarheid voor open werk. Een checkbox staat voor een
> gebruikers- of productie-uitkomst, nooit voor een foundation, reviewronde,
> artifactpromotie of deelpatch.

Laatst herijkt: **2026-08-27**.

## Vast productbesluit

```text
Klantpagina -> Meta webhook -> apps/image-gen -> tenantconversatie -> Messenger
Eigen pagina -> Meta webhook -> OpenClaw Facebook-plugin -> persoonlijke OpenClaw
```

- Klanten gaan nooit via OpenClaw of de legacy Leaderbot-bridge.
- Klant- en persoonlijke Pages gebruiken aparte Meta apps, callbacks en secrets.
- `apps/image-gen` bezit klantingress, workspace-identiteit, conversaties,
  afbeeldingen, opslag, quota, billing, consent, export en deletion.
- De OpenClaw-gateway is persoonlijk, pairing-only, lage prioriteit en geen
  blocker voor Leaderbot.
- Portal en klantwebhooks worden niet via de OpenClaw-gateway geproxied.

## Actieve volgorde

- [ ] **P1 - Directe tenantflow live bewijzen.** Laat de productie-Meta callback
      rechtstreeks eindigen in `apps/image-gen`; resolve vóór iedere klantread
      exact één actieve Page/channel/workspace; persisteer uitsluitend in de
      geauthenticeerde tenantqueue; laat disconnect, deletion en bindingwijziging
      oud werk definitief stoppen. Verwijder iedere runtimefallback naar de
      OpenClaw-bridge of een globale/legacy klantqueue na een gecontroleerde
      drain en migratie.

- [ ] **P2 - Portal als enige klantingang live zetten.** Laat
      `leaderbot.live` naar de tenantportal wijzen en bewijs login, eigen
      workspace, AI-instructies, Messenger connect/disconnect, usage, privacy,
      export/deletion en publieke route-isolatie. Interne/debug/admin- en
      persoonlijke OpenClaw-surfaces blijven onbereikbaar.

- [ ] **P3 - Eén volledige Messenger-klantreis slagen.** Bewijs met een
      goedgekeurde testworkspace op Android, iOS en Web: portalconnectie,
      gewone tekst, consentknop, getypte consent, weigering, text-to-image,
      foto-edit, multi-photo, dag-/periodeteller, provider/delivery failure en
      `delete-my-data` inclusief queued-work cancellation. Bewaar alleen
      metadata-only bewijs.

- [ ] **P4 - Startpilot in Test Mode afsluiten.** Sluit de zes gates in
      `docs/LAUNCH_READINESS.md`: directe tenantroute, Mollie/MySQL-integriteit,
      juridische/accountinggoedkeuring, quota/providerbescherming,
      notifications/exports/reconciliation en releasebewijs. Zet geen live key
      of live flag vóór alle zes gedateerd groen zijn.

- [ ] **P5 - Release en rollback afronden.** Deploy uitsluitend goedgekeurde,
      ondertekende `apps/image-gen`- en storage-proxyimages; bewijs schema,
      back-up/restore, monitoring, queue/dead-letterhealth en rollback. Herhaal
      daarna P3 zonder privacy-, quota-, tenant- of deliveryregressie. De
      storage-proxydeploy van `sha256:d2a2...` is op 2026-08-27 mislukt; de
      rollback is gezond, maar dat is geen geslaagde runtimepromotie. Buildrun
      `33069256896` heeft daarna uit groene `main`-commit `16b1819...` het
      nieuwe geattesteerde kandidaatimage `sha256:3f2861c2...` opgeleverd en
      het manifest bindt exact die bron en digest. Resterend is een nieuwe
      beschermde deploy met health- en readinessbewijs. Run `33080233054`
      stopte vóór productiemutatie: na de secretrotaties van 2026-08-27 bleven
      de exacte legacy-image en configuratie intact, maar de actuele
      Fly-toolmetadata was `2026.8.27-dev.1787839287`. Die exacte tijdelijke
      predecessor wordt gereviewd vastgelegd en na promotie vervangen door de
      gepinde deploytool. Tot dan blijft de gezonde legacyrollback de live
      baseline.

## Definition of done

Leaderbot is productie-klaar wanneer P1 tot en met P5 groen zijn en een echte
testklant de volledige reis kan doorlopen zonder OpenClaw, operatoringreep,
cross-tenant read, quota-omweg of ongedocumenteerde handmatige productiestap.

## Werkstopregels

- Er is maximaal één actieve productie-uitkomst tegelijk: **P1 -> P2 -> P3 ->
  P4 -> P5**.
- Maak geen nieuwe “foundation”, “hardening”, “readiness”, “review artifact” of
  “follow-up” backlogtaak. Een noodzakelijke reparatie hoort bij de huidige P.
- Een PR telt alleen als voortgang wanneer hij een acceptatiepunt uitvoerbaar
  maakt of met bewijs sluit. CI-groen zonder productuitkomst is onderhoud.
- Voeg ontdekte subproblemen toe aan de huidige uitkomst; dupliceer ze niet in
  meerdere documenten of PR-series.
- Start geen nieuwe feature, dependency-upgrade of gatewaywerk terwijl een
  huidige P op een uitvoerbare smoke, configuratie of operatorbeslissing wacht.
- Productiebewijs en rollbackmetadata worden in dezelfde uitkomst vastgelegd;
  lokale tests zijn geen live bewijs.

## Niet-blockerend onderhoud

- Persoonlijke OpenClaw gateway-upgrade, Memory Core-rebaseline en eigen
  Messenger-smoke, behalve bij een acute security- of data-lossregressie.
- Verwijderen van de default-off legacy bridge nadat productie geen klanten meer
  via die route ontvangt.
- ESLint/fallowcleanup, dependency-upgrades en moduleopsplitsingen.
- Galerij, geschiedenis, video, style-compatibilitycleanup en bredere
  knowledge/retrieval-UX.

Onderhoud krijgt geen productiecheckbox en mag P1-P5 niet onderbreken.

## Reeds bewezen

- Directe Messenger webhook-, conversation-, image-, consent-, quota-,
  deletion- en portalcode bestaat in `apps/image-gen` met gerichte tests.
- Prompt-first text-to-image, foto-edit en channel-neutrale multi-photo-acties
  bestaan.
- De image-gen releaseweg gebruikt immutable artifacts en scheidt appdeploy van
  databasemigratie; de beschermde `0016_expand`-overgang en restorecontrole zijn
  uitgevoerd op 2026-08-25.
- Een metadata-only Cloudflare UI-controle op 2026-08-27 bevestigde **Admin Read
  only** voor de aparte lifecyclecredential en exact één bucket in het actuele
  account, uniek genaamd `leaderbot-images`; er zijn geen access-key- of
  secretwaarden vastgelegd. Dit bewijst niet welke credential in Fly staat.
- Mollie en entitlementfoundation bestaan fail-closed; live commerciële flags
  blijven uit.
- De persoonlijke OpenClaw-gateway blijft afgeschermd en wordt niet meer als
  klantingang geconfigureerd.

## Onderliggende bewijsdocumenten

- Productiesmoke: `docs/production-readiness.md`
- Mollie launchbesluit: `docs/LAUNCH_READINESS.md`
- Mollie cases: `docs/MOLLIE_TEST_RESULTS.md`
- Meta review: `docs/operations/meta-app-review.md`
- Deploymentcontract: `docs/operations/production-deployments.md`
- Runtime-routing: `docs/operator-prompt-routing.md`
