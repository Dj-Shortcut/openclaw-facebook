# Repository Health Snapshot

## 1) Repo Health Snapshot (Very Light)

### CI Status Overview
- **Status:** ✅ Goed op orde.
- **Workflow:** Eén workflow (`.github/workflows/ci.yml`) die draait op PR's en pushes naar `main`.
- **Huidige Gates:** Installatie van dependencies, lint (`pnpm run lint`), test (`pnpm run test`), build (`pnpm run build`) en security-audit (`pnpm audit --prod --audit-level=high`).
- **Ontbrekend:** `pnpm run check` (typecheck) en `pnpm run lint:server` draaien nog niet in CI.

### Lint/Typecheck Setup Summary
- **TypeScript:** Staat in `strict` mode (`"strict": true`). Handmatige check mogelijk via `pnpm run check`.
- **ESLint:** Gebruikt `typescript-eslint` type-aware configuratie (`recommendedTypeChecked`).
- **Structuur:** Linting is gefragmenteerd; de standaard `lint` taak slaat de `server/` map over, die apart moet worden gedraaid via `lint:server`.

### Branch Structure Overview
- **Hoofdtak:** `main` fungeert als de primaire integratiebranch.
- **Workflow:** Gebruik van kortstondige feature-branches (zoals Codex-branches) die via PR's worden samengevoegd.

### 5 Low-effort, Non-breaking Improvements
1. **Integreer Server Lint:** Voeg `pnpm run lint:server` toe aan de CI om server-fouten te blokkeren.
2. **Typecheck in CI:** Voeg `pnpm run check` toe aan de CI-stap om strikte type-gating af te dwingen.
3. **Husky Pre-commit:** Gebruik `husky` om linting lokaal af te dwingen vóór een push.
4. **Environment Validatie:** Gebruik een library zoals `t3-env` om bij startup te crashen als essentiële tokens (zoals `FB_PAGE_ACCESS_TOKEN`) ontbreken.
5. **Shared Types:** Verplaats meer interfaces van `server/_core/types` naar `shared/` voor betere front-end synchronisatie.

---

## 2) CI Harden Mini-Audit (`.github/workflows/ci.yml`)

1. **Concurrency Control:** Voeg `concurrency` toe om oude runs automatisch te annuleren bij nieuwe pushes. Dit bespaart resources en voorkomt race-conditions in de build-status.
2. **Frozen Lockfile:** Gebruik `pnpm install --frozen-lockfile` (reeds aanwezig, maar essentieel om te behouden) om inconsistente dependency-versies te voorkomen.
3. **Job Timeouts:** Voeg `timeout-minutes: 15` toe aan jobs om te voorkomen dat vastgelopen runners onnodig lang blijven draaien.

---

## 3) Strict Mode Risk Scan (Runtime Risico's)

1. **Webhook Payloads:** In `messengerWebhook.ts` wordt veel met `any` of `unknown` gewerkt. Zelfs met linting kunnen onverwachte JSON-structuren van Meta runtime crashes veroorzaken.
2. **Database Nullables:** Velden in `schema.ts` (zoals `text` of `varchar`) hebben vaak geen expliciete defaults. TypeScript gaat ervan uit dat ze er zijn, maar een lege database-rij kan `undefined` teruggeven.
3. **External API Fetch:** De `sendMessage` functie controleert op `!response.ok`, maar valideert niet of de teruggekomen `body` voldoet aan de verwachte structuur voordat deze wordt verwerkt.

---

## 4) DX Micro-Improvements (Developer Experience)

1. **Gecombineerde Scripts:** Voeg een `lint:all` script toe (`lint` + `lint:server`) voor een compleet overzicht in één commando.
2. **Gestructureerde Logging:** Vervang `console.log` door een logger zoals `pino` voor betere traceerbaarheid en filtering in productie.
3. **VSCode Settings:** Voeg `.vscode/settings.json` toe met "format on save" om consistentie in het team te waarborgen.
4. **Log Prefixes:** Gebruik standaard prefixes (`[webhook]`, `[image]`, `[oauth]`) om debugging via `grep` in logs te vergemakkelijken.
5. **Architecture Doc:** Voeg `docs/architecture.md` toe met een module-map van `server/_core` voor snellere onboarding.

---

## 6) “What would break first?” (Productie Belasting)

1. **In-memory State:** Het gebruik van `Map` voor conversatiestatus in `messengerState.ts` schaalt niet horizontaal. Bij meerdere server-instances raakt de status van de gebruiker verspreid.
2. **Rate Limiting:** Zonder een queue-systeem (zoals BullMQ) zal de bot bij een piek in Meta-webhooks direct tegen de limieten van de Graph API aanlopen (429 errors).
3. **Fragiele Dependency Chain:** Externe calls naar image generation en storage hebben geen retry- of circuit-breaker strategie. Eén trage provider-respons vertraagt de hele webhook-afhandeling.
