# Architectuurdiagnose: `server/_core/messengerWebhook.ts`

## Scope en observaties
- Bestandsgrootte: ~1077 regels, met 26 imports uit veel verschillende subdomeinen.
- De file combineert transport-inbound/outbound, parsing, state-mutaties, use-case orchestration, kanaalspecifieke rendering, generation-afhandeling en foutclassificatie.
- Churn-signaal: meerdere recente commits direct op deze file (o.a. WhatsApp routing/dedupe/herstel), wat past bij een hotspot.

## 1) Is dit nog een webhook-entrypoint?
**Eerlijke conclusie:** nee, niet meer.

Deze file is momenteel tegelijk:
1. **Webhook entrypoint** (Express route registration + Meta verification).
2. **Transport adapter** (WhatsApp payload detectie/extractie/normalisatie).
3. **Application orchestrator** (flowbeslissingen en routing tussen features/experiences).
4. **Use-case service** (style-generation flow inclusief quota, state en retries).
5. **Presenter / channel renderer** (WhatsApp buttons/lists/text/image formatting en fallback-teksten).
6. **Infra coordinator** (media download, image storage, generator-call, runtime metrics).

Dat is functioneel knap, maar architectonisch te veel rollen op één plek.

## 2) Waar lekken boundaries?
Concrete boundary leaks:

- **Transport -> Domein/use-case leak:**
  - Inbound event parsing zit naast state transitions en generation orchestration.
  - Gevolg: schema/payload-wijzigingen forceren aanpassingen in flow-logica.

- **Application -> Presenter leak:**
  - Use-case beslissingen en kanaalspecifieke antwoordopmaak zitten door elkaar (bijv. quick-reply fallback text voor WhatsApp).
  - Gevolg: moeilijk om kanaal-agnostische use-cases te hergebruiken.

- **Application -> Infra leak:**
  - Orchestratie kent concrete image download/store/generator exceptions en vertaalt die direct naar user messaging.
  - Gevolg: business flow raakt gekoppeld aan fouttypen van onderliggende providers.

- **Routing -> Stateful process leak:**
  - Experience routing en style-flow gebruiken dezelfde state + side effects in dezelfde file.
  - Gevolg: wijzigingen in één flow beïnvloeden regressierisico in andere flows.

## 3) Te veel redenen om te veranderen?
**Ja. Duidelijk ja.**

Een wijziging in elk van deze categorieën raakt dit bestand:
- Meta webhook contract / verification.
- WhatsApp payloadvormen en interactives.
- Style/category parsingregels.
- State model of stage-transities.
- Quota-regels.
- Generation provider/error-taxonomie.
- Response copy/UX per kanaal.
- Experience routing.

Dat is precies het SRP-signaal: **één file met veel onafhankelijke change vectors**.

## 4) Dominante problemen (ranking)
1. **Ontbrekende laaggrenzen** (primair probleem).
2. **Te veel coupling** (met state, API, generation, router, features, privacy, quota).
3. **Te lage cohesion** binnen één module.
4. **Complexity hotspot / hotspot-churn** (symptoom van 1-3).

## 5) Harde principal-diagnose
Dit bestand is een **“orchestrator en orkest tegelijk”**.

- Het is een **god file** geworden: veel kennis, veel afhankelijkheden, veel side effects.
- Het gedraagt zich als **system nucleus**: meerdere paden moeten hier doorheen, dus elke feature drukt op dezelfde plek.
- Tegelijk is het een **pressure valve**: nieuwe uitzonderingen/flow-regels landen hier omdat het “handig” is.

Belangrijk onderscheid: dit is niet per se “slechte codekwaliteit” in de zin van slordig; het is vooral **code die te lang succesvol op één plek is gegroeid** zonder grensherstel.

## 6) Wat is nog goed?
- Er is duidelijke intentie naar normalisatie (`NormalizedInboundMessage`) en gedeelde handlers.
- Er zijn bestaande service-achtige modules (`imageService`, `stateResponseText`, features) die bruikbare extractiepunten vormen.
- Errorafhandeling en observability zijn aanwezig; dat is een goed fundament voor veilige refactor.
- De flow is functioneel coherent voor incident-debugging (alles in één pad zichtbaar).

## 7) Concreet opsplitsingsplan
### A. Wat blijft in `webhook.ts` / entrypoint module
- Route registration (`GET/POST /webhook`, limiter, verify-token checks).
- Payload type-dispatch: Facebook vs WhatsApp.
- Asynchrone handoff naar processor (`setImmediate`/queue boundary).

**Regel:** geen business flow, geen state-mutaties, geen provider-exceptions.

### B. Naar inbound parsing (transport-inbound)
- `isWhatsAppWebhookPayload`.
- `extractWhatsAppEvents` + mapping naar `NormalizedInboundMessage`.
- WhatsApp-specific parsing helpers voor interactieve payloads.

**Doel:** ruwe payload -> intern inbound event model, verder niets.

### C. Naar WhatsApp adapter/presenter (transport-outbound)
- `sendWhatsAppStyleCategoryPrompt`, `sendWhatsAppStyleOptions`.
- `buildWhatsAppReplyListText`, `sendWhatsAppStateText`.
- `createWhatsAppRouteResponseSender`.

**Doel:** channel rendering/UX formatting isoleren van use-cases.

### D. Naar application/use-case services
- `runWhatsAppStyleGeneration` splitsen in:
  - `prepareGeneration` (guardrails: quota, source image aanwezig, state ready),
  - `executeGeneration` (generator call + metrics),
  - `finalizeGeneration` (state + outbound response policy).
- `handleWhatsAppExperienceRouting` naar dedicated routing use-case.

**Doel:** expliciete use-case API’s met input/output contracts.

### E. Naar state/flow services
- `handleWhatsAppPayloadSelection`.
- Style/category selectie-transities vanuit tekst.
- Recovery/transitiebeleid (`AWAITING_*`, `PROCESSING`, `FAILURE`).

**Doel:** centrale flow machine, los van Express en WhatsApp API-calls.

## 8) Aanbevolen volgorde van snedes (incrementeel, risicogestuurd)
1. **Eerst: presenter extractie (laag risico, hoge winst)**
   - Verplaats alleen outbound formatting/sending wrappers.
   - Geen gedragswijziging, wel directe krimp van file en lagere cognitieve load.

2. **Tweede: inbound parser extractie**
   - Pure functies met golden tests op payload->normalized events.
   - Vermindert transport-noise in hoofdflow.

3. **Derde: style-generation use-case extractie**
   - Grootste winst op coupling/churn.
   - Houd signature tijdelijk compatibel om callsites stabiel te houden.

4. **Later: flow/state policy extractie**
   - Maak een kleine flow service (transities + intent handling).
   - Pas daarna experience routing verder loskoppelen.

5. **Als laatste: entrypoint versmallen**
   - `registerMetaWebhookRoutes` alleen nog dispatch + acknowledgements.

## 9) Pattern-labels expliciet
- **God file:** ja.
- **Complexity hotspot:** ja.
- **System nucleus:** ja.
- **Pressure valve:** ja.
- **Orchestrator en orkest tegelijk:** ja.

## Mini-doelarchitectuur (voorstel)
```text
server/_core/webhook/
  registerMetaWebhookRoutes.ts        # alleen HTTP entry + verify + dispatch
  webhookDispatcher.ts                # kiest facebook vs whatsapp processors

server/_core/whatsapp/inbound/
  detectWhatsAppPayload.ts            # payload type guards
  parseWhatsAppWebhookPayload.ts      # payload -> NormalizedInboundMessage[]
  parseWhatsAppSelections.ts          # style/category/payload selectie parse

server/_core/whatsapp/presenter/
  whatsappPresenter.ts                # sendText/sendImage/sendButtons/sendList wrappers
  whatsappStateReplies.ts             # state text + quick-reply fallback rendering

server/_core/whatsapp/application/
  processWhatsAppEvent.ts             # per event type dispatch text/image/unknown
  runStyleGenerationUseCase.ts        # quota+state+generation+error policy
  handleExperienceRoutingUseCase.ts   # entryIntent/activeExperience route handling

server/_core/whatsapp/flow/
  whatsappFlowService.ts              # stage transitions + selection handling
  whatsappFlowPolicies.ts             # recovery + retry + transition rules
```
