# Technisch Auditrapport: leaderbot-fb-image-gen

Dit rapport biedt een gedetailleerde technische analyse van de `leaderbot-fb-image-gen` repository. De focus ligt op architectuur, beveiliging, schaalbaarheid en onderhoudbaarheid van de Facebook Messenger bot en de bijbehorende services.

## 1. Architectuuroverzicht

De applicatie is gebouwd als een **Node.js/TypeScript** server die gebruikmaakt van het **Express** framework. De kernfunctionaliteit is het genereren van AI-gebaseerde afbeeldingen via Meta-kanalen zoals Facebook Messenger en WhatsApp.

### Kerncomponenten:
| Component | Beschrijving |
| :--- | :--- |
| **Bot Runtime** | Beheert de dialoogstroom, rate limiting en bot-functies. |
| **Experience Router** | Bevat experimentele routering voor extra interactieflows; dit is niet de actieve productrichting. |
| **Image Service** | Integreert met OpenAI voor beeldgeneratie en beheert opslag via S3 (Forge API). |
| **State Store** | Een abstractielaag voor statusbeheer met ondersteuning voor Redis of in-memory opslag. |
| **Storage Proxy** | Een aparte service voor duurzame objectopslag (R2) met bearer-token beveiliging. |

---

## 2. Beveiligingsanalyse

De applicatie vertoont een volwassen benadering van beveiliging, maar er zijn enkele kritieke aandachtspunten.

### Sterke punten:
- **Webhook Validatie**: Implementatie van HMAC-SHA256 handtekeningverificatie voor inkomende Facebook-webhooks.
- **Privacy**: Gebruik van een `PRIVACY_PEPPER` voor het anonimiseren van User IDs (PSIDs) via HMAC-SHA256.
- **Admin Beveiliging**: GitHub OAuth-integratie voor admin-toegang met JWT-gebaseerde sessies.

### Risico's en Kwetsbaarheden:
- **State Persistence Gap**: In de `memory`-modus (zonder Redis) worden normale status-items (zoals Messenger-status en chatgeschiedenis) **nooit verwijderd**, ondanks de aanwezigheid van TTL-parameters in de API. Dit kan leiden tot onbeperkt geheugenverbruik en schending van dataretentiebeleid.
- **Onbeveiligde Metrics**: Het `/metrics` endpoint is publiek toegankelijk zonder authenticatie. Hoewel dit standaard Prometheus-formaat is, kan het gevoelige operationele informatie lekken.
- **Lokale Fallback**: In niet-productieomgevingen vallen gegenereerde afbeeldingen terug op een vluchtige in-memory store met een korte TTL, wat debugging van generatieproblemen lastig maakt.

---

## 3. Schaalbaarheid en Prestaties

De architectuur is ontworpen met schaalbaarheid in gedachten, maar de huidige implementatie heeft beperkingen in multi-instance scenario's.

### Analyse:
- **Redis Afhankelijkheid**: Voor een betrouwbare werking in een cluster (meerdere server-instanties) is Redis **verplicht**. Zonder Redis is de status lokaal per proces, wat leidt tot inconsistente bot-interacties en falende rate limiting.
- **Rate Limiting**: De huidige implementatie van `rateLimitFeature` is proces-lokaal in memory-modus. Een gebruiker kan de limiet omzeilen door verschillende instanties van de bot te raken.
- **Beeldgeneratie**: Gebruik van OpenAI's DALL-E (via `imageService.ts`) is een synchroon proces in de `afterSend` callback van de router, wat de node-event loop niet blokkeert maar wel afhankelijk is van externe API-latencies (gemiddeld 10-45 seconden).

---

## 4. Onderhoudbaarheid en Codekwaliteit

De code is goed gestructureerd en maakt gebruik van moderne TypeScript-patronen.

### Observaties:
- **Type Safety**: Uitgebreid gebruik van TypeScript-interfaces en types (bijv. `BotContext`, `IdentityGameSession`).
- **Observability**: Goede implementatie van request tracing en gestructureerde JSON-logging.
- **Testdekking**: Aanwezigheid van unit- en integratietests (bijv. `messengerApi.retry.test.ts`), wat duidt op een test-driven benadering.

---

## 5. Belangrijkste Aanbevelingen

| Prioriteit | Aanbeveling | Impact |
| :--- | :--- | :--- |
| **Kritiek** | Implementeer TTL-evictie voor de in-memory `stateStore` om geheugenlekken te voorkomen. | Betrouwbaarheid & Privacy |
| **Hoog** | Forceer Redis in productieomgevingen om statusconsistentie te garanderen. | Schaalbaarheid |
| **Medium** | Beveilig het `/metrics` endpoint met een API-key of IP-whitelist. | Beveiliging |
| **Medium** | Verplaats beeldgeneratie naar een asynchrone worker-queue voor betere fouttolerantie. | Gebruikerservaring |

## Conclusie

De `leaderbot-fb-image-gen` repository is een technisch solide basis voor een AI-gestuurde Messenger bot. De overgang van een eenvoudige beeldgenerator naar een complexe "Experience" engine (Identity Game) is goed doordacht in de code. De belangrijkste verbeterpunten liggen in de consistentie van de statusopslag en de robuustheid van de in-memory fallback-mechanismen.
