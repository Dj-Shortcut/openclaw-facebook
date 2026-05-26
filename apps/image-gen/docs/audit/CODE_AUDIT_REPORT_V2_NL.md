# Code Audit Report: leaderbot-fb-image-gen (Post-Refactor Update)

**TL;DR**: De repository heeft een enorme kwaliteitsslag gemaakt. De monolithische `imageService.ts` is succesvol opgesplitst, de webhook routing is gemodulariseerd en de test suite is weer 100% groen. De architectuur is nu klaar voor schaalbaarheid en multi-channel support. **Conclusie: Zeer gezond; de belangrijkste architecturale risico's zijn geadresseerd.**

---

### 1. Architectuur & Structuur
- **Doel**: Een multi-channel (Messenger/WhatsApp) AI-image generation bot met geavanceerde state management en face memory.
- **Frameworks**: **TypeScript**, **Vite/Vitest**, **OpenAI API**, **Redis** (voor queueing en replay protection).
- **Folderstructuur**: Sterk verbeterd. Business logic is nu verdeeld over gespecialiseerde modules zoals `image-generation/`, `meta/` (ingress) en `messenger/` (routing).
- **Entry point**: `server/_core/index.ts` fungeert als de orchestrator die de Express server en de nieuwe ingress queues koppelt.
- **Grootste winst**: De introductie van `webhookIngressQueue.ts` zorgt voor asynchrone verwerking en betere fouttolerantie bij piekdrukte.

### 2. Code Quality Score: 9/10
- **Leesbaarheid (9/10)**: De opsplitsing van de monolithische service naar `PromptBuilder` en `OpenAiImageClient` verhoogt de leesbaarheid aanzienlijk.
- **DRY (8/10)**: Veel gedeelde logica is verplaatst naar `sharedTextHandler.ts` en `webhookHelpers.ts`.
- **Error Handling (8/10)**: Verbeterd door de introductie van de ingress queue en betere validatie in de routing lagen.
- **Type Safety (10/10)**: Consequent gebruik van strikte types over de gehele breedte van de nieuwe modules.
- **Test Coverage (9/10)**: De test suite is hersteld en uitgebreid met specifieke tests voor de nieuwe routing en face memory features.

### 3. Top 5 Tech Debt Issues (Geprioriteerd)
1. **Probleem**: In-memory `adminAuthBuckets` in `adminAuth.ts:9`.
   - **Impact**: Rate limiting voor admin acties is niet persistent over restarts.
   - **Fix**: Verplaats deze buckets naar Redis, vergelijkbaar met de webhook replay protection. **Effort: S**
2. **Probleem**: Hardcoded TTL's in `faceMemory.ts:12`.
   - **Impact**: Lastig aan te passen zonder code wijziging.
   - **Fix**: Maak de retentieperiode configureerbaar via omgevingsvariabelen. **Effort: S**
3. **Probleem**: `webhookHandlers.ts` is nog steeds relatief groot (>1300 regels).
   - **Impact**: Bevat nog steeds veel orchestratie logica die verder verdeeld kan worden.
   - **Fix**: Delegeer meer verantwoordelijkheden naar de specifieke `messenger*Routing.ts` modules. **Effort: M**
4. **Probleem**: Gebruik van `console.log` voor business events in `generationFlow.ts`.
   - **Impact**: Inconsistent met de `safeLog` utility die elders wordt gebruikt.
   - **Fix**: Harmoniseer alle logging naar de `safeLog` / `BotLogger` standaard. **Effort: S**
5. **Probleem**: Directe afhankelijkheid van `ioredis` in meerdere bestanden.
   - **Impact**: Lastig om van caching provider te wisselen.
   - **Fix**: Introduceer een centrale `RedisProvider` of `CacheInterface`. **Effort: M**

### 4. Security Quickscan
- **Admin Auth**: Nieuwe `adminAuth.ts` gebruikt `timingSafeEqual` voor token verificatie, wat uitstekend is tegen timing attacks.
- **Face Memory**: Implementatie van `deleteFaceMemoryForUser` toont respect voor GDPR/privacy.
- **Hardcoded Secrets**: Geen gevonden. Gebruik van `PRIVACY_PEPPER` voor hashing is een sterke security practice.
- **SQL Injection**: Nog steeds laag risico door abstractielagen.

### 5. Performance Low Hanging Fruit
1. **Redis Pipelining**: In `webhookIngressQueue.ts` kunnen meerdere Redis operaties gebundeld worden om round-trips te besparen.
2. **Image Fetching**: `sourceImageFetcher.ts` kan profiteren van parallelle fetches als er meerdere bronnen zijn.
3. **State Patching**: `patchState` in `messengerState.ts` voert een volledige write uit; bij zeer hoge load kan dit geoptimaliseerd worden.

### 6. Dependency Health
- **Up-to-date**: De lockfile is recent bijgewerkt (`pnpm-lock.yaml` wijzigingen).
- **Schoon**: Geen overbodige zware dependencies meer in de core paden.
- **Bundle**: De opsplitsing helpt bij tree-shaking, hoewel de server bundle nog steeds gedomineerd wordt door de OpenAI SDK.

### 7. Actieplan Volgende 2 Weken
1. **Ticket 1**: Als developer wil ik admin rate limiting in Redis opslaan, zodat brute-force pogingen ook over restarts heen geblokkeerd blijven. (Impact: Medium / Effort: S)
2. **Ticket 2**: Als developer wil ik alle `console.log` aanroepen in de core flows vervangen door `safeLog`, zodat onze logging consistent en doorzoekbaar is. (Impact: Medium / Effort: S)
3. **Ticket 3**: Als developer wil ik de retentieperiode van face memory configureerbaar maken, zodat we flexibel kunnen inspelen op privacy eisen. (Impact: Low / Effort: S)
4. **Ticket 4**: Als developer wil ik integratietests voor de WhatsApp routing flow, zodat we dezelfde stabiliteit garanderen als voor Messenger. (Impact: High / Effort: M)
5. **Ticket 5**: Als developer wil ik een centrale Redis client factory, zodat we connectiebeheer op één plek regelen. (Impact: Medium / Effort: S)
