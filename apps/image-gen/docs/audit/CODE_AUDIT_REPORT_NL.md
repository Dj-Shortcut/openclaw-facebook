# Code Audit Report: leaderbot-fb-image-gen

**TL;DR**: De repository is technisch solide en goed gestructureerd voor een MVP, maar vertoont tekenen van "feature creep" in de core logica. De code is leesbaar en type-safe, maar de afhankelijkheid van in-memory state en gebrek aan robuuste error handling in edge cases zijn risico's. **Conclusie: Gezond, maar behoeft refactoring voor schaalbaarheid.**

---

### 1. Architectuur & Structuur
- **Doel**: Een Facebook Messenger bot die AI-gegenereerde afbeeldingen maakt op basis van gebruikersfoto's en geselecteerde stijlen.
- **Frameworks**: **TypeScript** (type safety), **Vite/Vitest** (fast development/testing), **OpenAI API** (DALL-E 3/Edits).
- **Folderstructuur**: Logisch verdeeld in `server/_core` voor business logic en `server/db.ts` voor data, maar `_core` begint een "dumping ground" te worden.
- **Entry point**: `server/_core/index.ts` start de Express server en initialiseert de webhook handlers.
- **Rode vlag**: De `imageService.ts` is een monolithisch bestand (>1100 regels) dat zowel API-interacties, prompt-engineering als image processing bevat.

### 2. Code Quality Score: 7/10
- **Leesbaarheid (8/10)**: Goede naamgeving en kleine functies. *Voorbeeld*: `buildStylePrompt` in `imageService.ts:276`.
- **DRY (6/10)**: Veel duplicatie in i18n en prompt templates. *Voorbeeld*: Hardcoded NL/EN checks in `styleCommandsFeature.ts:26`.
- **Error Handling (6/10)**: Veel `try-catch` blokken loggen alleen maar herstellen niet. *Voorbeeld*: `publishGeneratedImage` in `imageService.ts:156`.
- **Type Safety (9/10)**: Uitstekend gebruik van TypeScript types en interfaces. *Voorbeeld*: `StyleConfig` in `messengerStyles.ts:34`.
- **Test Coverage (5/10)**: Vitest is aanwezig, maar tests focussen op helpers, niet op core flows.

### 3. Top 5 Tech Debt Issues
1. **Probleem**: Monolithische `imageService.ts`.
   - **Impact**: Moeilijk te testen en te onderhouden; hoge cognitieve belasting.
   - **Fix**: Splits in `PromptBuilder`, `OpenAiClient` en `ImageProcessor`. **Effort: M**
2. **Probleem**: In-memory stats (`botRuntimeStats.ts`).
   - **Impact**: Stats gaan verloren bij server herstart; niet schaalbaar over meerdere instances.
   - **Fix**: Verplaats stats naar een persistente database (Redis/Postgres). **Effort: S**
3. **Probleem**: Hardcoded i18n logica in features.
   - **Impact**: Toevoegen van een derde taal vereist wijzigingen in alle feature bestanden.
   - **Fix**: Gebruik de `t()` helper consequent en verwijder inline string checks. **Effort: S**
4. **Probleem**: Gebrek aan formele State Machine.
   - **Impact**: Gebruikers kunnen in "dead ends" terechtkomen in de conversatie.
   - **Fix**: Implementeer een XState of simpele reducer-gebaseerde state machine. **Effort: L**
5. **Probleem**: Onduidelijke scheiding tussen "Bot" en "Messenger".
   - **Impact**: Lastig om naar WhatsApp of Telegram te porten.
   - **Fix**: Introduceer een abstracte `BotProvider` interface. **Effort: M**

### 4. Security Quickscan
- **Hardcoded Secrets**: Geen gevonden in code (gebruikt `process.env`), maar `MESSENGER_ADMIN_IDS` in `statsFeature.ts:3` is gevoelig.
- **SQL Injection**: Laag risico door gebruik van ORM/Query builders in `db.ts`.
- **XSS**: Niet direct van toepassing (Messenger UI), maar URL-reflectie in `i18n.ts:12` moet gesaneerd worden.
- **CVE's**: `pnpm audit` toont 0 vulnerabilities.

### 5. Performance Low Hanging Fruit
1. **N+1 Queries**: Niet direct gevonden, maar `recordActiveUserToday` in `botRuntimeStats.ts:37` kan een bottleneck worden bij veel verkeer.
2. **Onnodige Loops**: `STYLE_CONFIGS.find` in `getStyleById` (`messengerStyles.ts:106`) wordt bij elk bericht aangeroepen; gebruik een Map.
3. **Grote Bundles**: `openai` en `form-data` zijn zware dependencies voor een simpele proxy; overweeg native `fetch`.

### 6. Dependency Health
- **Verouderd**: `vite` en `vitest` kunnen naar v5.
- **Overbodig**: `form-data` kan vervangen worden door native `FormData` in Node 18+.
- **Zwaargewichten**: `openai` SDK is de grootste factor in de server bundle.

### 7. Actieplan Volgende 2 Weken
1. **Ticket 1**: Als developer wil ik `imageService.ts` opgesplitst hebben, zodat de code onderhoudbaar blijft. (Impact: High / Effort: M)
2. **Ticket 2**: Als developer wil ik stats in de database opslaan, zodat data niet verloren gaat bij deploys. (Impact: Medium / Effort: S)
3. **Ticket 3**: Als developer wil ik alle inline NL/EN checks vervangen door `i18n.t()`, zodat we makkelijk talen kunnen toevoegen. (Impact: Medium / Effort: S)
4. **Ticket 4**: Als developer wil ik een Map gebruiken voor style lookups, zodat de bot sneller reageert. (Impact: Low / Effort: S)
5. **Ticket 5**: Als developer wil ik integratietests voor de `generationFlow`, zodat we regressies voorkomen. (Impact: High / Effort: M)
