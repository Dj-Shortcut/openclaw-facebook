# Code Audit Update Pass: 3 mei 2026

**Status**: Superseded Audit Findings & New Observations  
**Context**: Her-evaluatie van de top tech-debt issues uit het rapport van maart 2026 tegen de huidige codebase (commit `9380024`+).

---

## 1. Status van eerdere Tech Debt Issues

In de vorige audit pass werden 5 kritieke tech-debt issues geïdentificeerd. Hieronder de huidige status:

| # | Probleem (Maart 2026) | Status Mei 2026 | Bevinding |
|:---|:---|:---|:---|
| 1 | In-memory `adminAuthBuckets` | **Open** | Nog steeds een in-memory `Map` in `adminAuth.ts`. Niet persistent over restarts. |
| 2 | Hardcoded TTL's in `faceMemory.ts` | **Open** | `THIRTY_DAYS_MS` is nog steeds hardcoded (regel 17). Niet configureerbaar via env. |
| 3 | `webhookHandlers.ts` te groot | **Deels Verbeterd** | Webhook is gesplitst (`messengerWebhook.ts`, `webhookHandlers.ts`, `webhookHelpers.ts`), maar `webhookHandlers.ts` is nog steeds een zeer grote orchestrator. |
| 4 | `console.log` in `generationFlow.ts` | **Opgelost** | `generationFlow.ts` gebruikt nu gestructureerde error returns en `console.warn` voor incidentele infra-fouten. Geen business logging via `console.log` meer. |
| 5 | Directe afhankelijkheid van `ioredis` | **Open** | Nog steeds gedecentraliseerde `ioredis` imports en client factories in o.a. `stateStore.ts`, `webhookIngressQueue.ts` en `httpRateLimit.ts`. |

---

## 2. Nieuwe Bevindingen & Observaties

### 2.1 Logging Maturiteit
Hoewel `generationFlow.ts` is opgeschoond, blijft de rest van de "operational perimeter" (`webhookRoutes.ts`, `webhookHandlers.ts`) sterk leunen op `console.log`, `console.warn` en `console.error`. 
- **Risico**: In productie is dit lastig te filteren of aggregeren zonder een echte logger (zoals `pino` of `winston`) die gekoppeld is aan de `safeLog` utility.

### 2.2 Face Memory & Privacy
De implementatie van Face Memory is volwassener geworden met een admin kill-switch (`/admin/disable-face-memory`) en expliciete cleanup paden voor mislukte storage deletes.
- **Observatie**: De retentie van 30 dagen in code vs 32 dagen in de state-store TTL is een bewuste "buffer" keuze, maar verhoogt de complexiteit bij het auditen van data-retentie policies.

### 2.3 Architecturale Seams
De introductie van `webhookIngressQueue.ts` is een sterke verbetering voor de robuustheid. De codebase vertoont nu een duidelijk patroon van "Durable Ingress" -> "Async Processing", wat de bot beschermt tegen Meta's webhook timeouts.

---

## 3. Aanbevolen Acties (Geactualiseerd)

1. **[PRIO 1] Centraliseer Redis**: Introduceer een `server/_core/redis.ts` provider. Dit lost de versnipperde `ioredis` afhankelijkheid op en maakt connection pooling/management mogelijk.
2. **[PRIO 2] Env-driven Retentie**: Verplaats `THIRTY_DAYS_MS` uit `faceMemory.ts` naar een omgevingsvariabele (bijv. `FACE_MEMORY_RETENTION_DAYS`).
3. **[PRIO 3] Admin Rate Limit naar Redis**: Nu Redis toch al vereist is voor de ingress queue, is het verplaatsen van de `adminAuthBuckets` naar Redis een "low hanging fruit" voor security.
4. **[PRIO 4] Logger Consolidatie**: Trek de `safeLog` logica door naar de webhook ingress en routing lagen, zodat `console.log` enkel nog voor bootstrap/startup informatie wordt gebruikt.

---

*Gedocumenteerd door Manus op 3 mei 2026.*
