# Webhook refactor implementatieplan

## Doel

Dit document vertaalt de architectuurdiagnose naar een concreet uitvoerplan.

Doel van dit plan:

- webhook- en conversation-logica verder ontkoppelen zonder rewrite
- regressierisico beheersbaar houden
- werk opdelen in kleine, mergebare stappen
- per stap duidelijk maken welke bestanden geraakt worden en welke tests mee moeten bewegen

Dit plan gaat uit van incrementele refactors op de bestaande code.

## Uitgangspunten

We optimaliseren voor:

- kleine veilige changes
- zo weinig mogelijk gedragswijziging per stap
- eerst grenzen verbeteren, pas daarna gedrag centraliseren
- bestaande tests behouden als vangnet

We vermijden in deze fase:

- volledige hertekening van alle bot flows
- gelijktijdige Messenger- en WhatsApp-rewrite
- grote renamegolven zonder functionele winst

## Gewenste eindrichting

Na deze refactorlijn willen we naar een model waarin:

1. Meta ingress alleen transportverantwoordelijkheid draagt.
2. Conversation-beslissingen in een centrale engine of flowlaag leven.
3. Kanaalverschillen vooral in presenters/adapters zitten.
4. Generation flow niet meer dubbel in Messenger en WhatsApp opgelost wordt.

## Samenvatting van de werkpakketten

1. Generation flow centraliseren
2. Inbound image flow normaliseren
3. Conversation decision layer invoeren
4. Channel presenters dunner maken
5. Meta ingress opschonen en documenteren

## Werkpakket 1: Generation flow centraliseren

### Probleem

Vandaag zit generation orchestration twee keer in de code:

- `runStyleGeneration(...)` in `server/_core/webhookHandlers.ts`
- `runWhatsAppStyleGeneration(...)` in `server/_core/messengerWebhook.ts`

Die functies overlappen sterk in:

- quota-beslissing
- state transitions
- generator call
- error mapping
- succes/failure branch

### Doel

Eén gedeelde generation flow service introduceren die kanaal-onafhankelijke uitkomsten teruggeeft.

### Concreet resultaat

Voeg een nieuwe module toe, bijvoorbeeld:

- `server/_core/generationFlow.ts`

Deze module moet verantwoordelijk worden voor:

- generator aanroepen
- source image kiezen
- trust/provenance meenemen
- foutclassificatie naar domeinuitkomst
- generatieresultaat teruggeven in een kanaal-onafhankelijk contract

Voorbeeld van gewenst contract:

```ts
type GenerationFlowResult =
  | { kind: "success"; imageUrl: string; metrics: ... }
  | { kind: "awaiting_photo"; textKey: "missingInputImage" }
  | { kind: "awaiting_style"; textKey: "generationUnavailable" | "generationTimeout" | "generationBudgetReached" }
  | { kind: "failure"; textKey: "generationGenericFailure" };
```

### Te wijzigen bestanden

- nieuw: `server/_core/generationFlow.ts`
- bestaand:
  - `server/_core/webhookHandlers.ts`
  - `server/_core/messengerWebhook.ts`
  - mogelijk `server/_core/imageService.ts` alleen voor kleine contractafspraken

### Verwachte codeverplaatsing

Verplaats naar gedeelde flow:

- generator bootstrap
- success/failure classificatie
- metrics handling
- budget/timeout/config error mapping

Laat voorlopig nog per kanaal in de handlers:

- daadwerkelijke send primitives
- Messenger/WhatsApp specifieke succescopy
- state-specifieke UI-presentatie

### Testimpact

Bestaande tests die waarschijnlijk geraakt worden:

- [botFeatures.test.ts](../../server/botFeatures.test.ts)
- [messengerWebhook.test.ts](../../server/messengerWebhook.test.ts)
- [whatsappWebhook.test.ts](../../server/whatsappWebhook.test.ts)
- [imageService.proof.test.ts](../../server/imageService.proof.test.ts)

Nieuwe tests toevoegen:

- `server/generationFlow.test.ts`

### Risico

Middelgroot.

Dit pakket raakt een hot path, maar heeft hoge opbrengst omdat het duplicatie direct vermindert.

## Werkpakket 2: Inbound image flow normaliseren

### Probleem

Messenger en WhatsApp behandelen inkomende beelden anders:

- Messenger bewaart direct de attachment URL
- WhatsApp downloadt en persist eerst

Dat verschil is deels terecht, maar vandaag is het niet gemodelleerd als één duidelijke inbound media boundary.

### Doel

Een gedeeld intern source-image model invoeren voor beide kanalen.

### Concreet resultaat

Voeg een nieuwe module toe, bijvoorbeeld:

- `server/_core/inboundImage.ts`

Verantwoordelijkheden:

- input van kanaalrand vertalen naar één intern source-image object
- provenance expliciet maken
- trusted/untrusted semantics standaardiseren

Voorbeeld:

```ts
type InboundSourceImage =
  | { kind: "external_url"; url: string; provenance: "messenger_attachment" }
  | { kind: "stored_url"; url: string; provenance: "storeInbound" };
```

### Te wijzigen bestanden

- nieuw: `server/_core/inboundImage.ts`
- bestaand:
  - `server/_core/webhookHandlers.ts`
  - `server/_core/messengerWebhook.ts`
  - `server/_core/sourceImageStore.ts`
  - `server/_core/imageService.ts`
  - mogelijk `server/_core/messengerState.ts`

### Gewenste uitkomst

Kanaalhandlers zouden niet langer zelf moeten bepalen hoe `trustedSourceImageUrl` geconstrueerd wordt.
Dat moet uit het gedeelde model volgen.

### Testimpact

Belangrijkste bestaande tests:

- [messengerWebhook.test.ts](../../server/messengerWebhook.test.ts)
- [whatsappWebhook.test.ts](../../server/whatsappWebhook.test.ts)
- [imageService.proof.test.ts](../../server/imageService.proof.test.ts)

Nieuwe tests toevoegen:

- `server/inboundImage.test.ts`

### Risico

Middelgroot.

Belangrijk security- en correctness-punt, dus best na of samen met werkpakket 1, maar niet in dezelfde PR als de volledige generation centralisatie tenzij de diff klein blijft.

## Werkpakket 3: Conversation decision layer invoeren

### Probleem

De state machine is nu impliciet verspreid over:

- `webhookHandlers.ts`
- `messengerWebhook.ts`
- `sharedTextHandler.ts`
- bot features

### Doel

Een expliciete decision layer invoeren die conversation-beslissingen centraler maakt.

### Concreet resultaat

Voeg een nieuwe module toe, bijvoorbeeld:

- `server/_core/conversationEngine.ts`

Eerste scope:

- alleen text- en style-flow beslissingen
- nog niet alle experience-routing of every edge case

Voorbeeld input:

```ts
decideConversationStep({
  channel,
  state,
  inboundMessage,
  hasPhoto,
  capabilities,
})
```

Voorbeeld output:

```ts
{
  nextState?: ConversationState,
  response: BotResponse | null,
  effects: Array<...>
}
```

### Belangrijke keuze

Deze laag moet geen Messenger quick replies of WhatsApp lists kennen.
Ze mag wel abstracte intents teruggeven zoals:

- `options_prompt`
- `handoff_state`
- `image`
- `text`

### Te wijzigen bestanden

- nieuw: `server/_core/conversationEngine.ts`
- bestaand:
  - `server/_core/sharedTextHandler.ts`
  - `server/_core/botResponse.ts`
  - `server/_core/botResponseAdapters.ts`
  - `server/_core/webhookHandlers.ts`
  - `server/_core/messengerWebhook.ts`

### Aanpak

Begin klein:

1. haal greeting/help/new-style/default-text uit `sharedTextHandler.ts` naar de engine
2. laat `sharedTextHandler.ts` eerst als dunne wrapper bestaan
3. migreer daarna foto/style-beslissingen

### Testimpact

Bestaande tests:

- [sharedTextHandler.test.ts](../../server/sharedTextHandler.test.ts)
- [messengerWebhook.test.ts](../../server/messengerWebhook.test.ts)
- [whatsappWebhook.test.ts](../../server/whatsappWebhook.test.ts)
- [botFeatures.test.ts](../../server/botFeatures.test.ts)

Nieuwe tests:

- `server/conversationEngine.test.ts`

### Risico

Hoogst inhoudelijk, maar goed beheersbaar als de scope in de eerste iteratie klein blijft.

## Werkpakket 4: Channel presenters dunner maken

### Probleem

`sendMessengerBotResponse(...)` en `sendWhatsAppBotResponse(...)` zijn een goed begin, maar de handlers beslissen nog vaak zelf welke presentatielaag ze direct aanspreken.

### Doel

Meer responses via de bestaande `BotResponse`-laag sturen, en minder rechtstreekse send-calls uit de flowcode doen.

### Concreet resultaat

Verbeter `BotResponse` waar nodig met domeinintenties die presentabel blijven zonder providerkennis.

Mogelijke uitbreidingen:

- een expliciete `style_picker` intent
- een expliciete `style_options` intent
- een expliciete `generation_result` intent

Belangrijk:

- alleen toevoegen als het echt helpt
- niet nodeloos abstraheren als `options_prompt` al volstaat

### Te wijzigen bestanden

- `server/_core/botResponse.ts`
- `server/_core/botResponseAdapters.ts`
- `server/_core/webhookHandlers.ts`
- `server/_core/messengerWebhook.ts`

### Testimpact

- [botResponseAdapters.test.ts](../../server/botResponseAdapters.test.ts) als die nog ontbreekt, toevoegen
- bestaande webhooktests voor presentatiegedrag updaten waar nodig

### Risico

Laag tot middel.

Dit pakket is het veiligst nadat werkpakket 3 een deel van de decisions al heeft gecentraliseerd.

## Werkpakket 5: Meta ingress opschonen

### Probleem

`messengerWebhook.ts` draagt vandaag een misleidende naam en combineert:

- route registratie
- webhook verification
- WhatsApp parsing
- WhatsApp orchestration

### Doel

Ingress en kanaaladapter duidelijker scheiden.

### Concreet resultaat

Splits bijvoorbeeld naar:

- `server/_core/meta/webhookRoutes.ts`
- `server/_core/inbound/whatsappInbound.ts`
- eventueel later `server/_core/messengerInbound.ts`

### Te wijzigen bestanden

- nieuw:
  - `server/_core/meta/webhookRoutes.ts`
  - `server/_core/inbound/whatsappInbound.ts`
- bestaand:
  - `server/_core/messengerWebhook.ts`
  - `server/_core/index.ts`

### Testimpact

- [messengerWebhook.validation.test.ts](../../server/messengerWebhook.validation.test.ts)
- [messengerWebhook.verification.test.ts](../../server/messengerWebhook.verification.test.ts)
- [whatsappWebhook.test.ts](../../server/whatsappWebhook.test.ts)

### Risico

Laag, zolang dit pas gebeurt nadat de flowlogica al iets beter uit het bestand getrokken is.

## Aanbevolen uitvoervolgorde

Beste volgorde voor kleine veilige PR’s:

1. Werkpakket 1: generation flow centraliseren
2. Werkpakket 2: inbound image flow normaliseren
3. Werkpakket 3a: eerste conversation engine voor gedeelde text-beslissingen
4. Werkpakket 4: presenters/adapters dunner maken
5. Werkpakket 5: ingress opschonen
6. Werkpakket 3b: meer flowregels migreren naar de engine

Reden:

- eerst de duidelijkste duplicatie aanpakken
- daarna input uniformeren
- daarna pas de echte engine-boundary verbreden

## Concreet voorstel voor de eerstvolgende 3 PR’s

## PR 1

Titel:

`extract shared generation flow for messenger and whatsapp`

Scope:

- nieuwe `generationFlow.ts`
- Messenger en WhatsApp generation orchestration daarop laten steunen
- geen wijziging aan HTTP ingress

Verwachte files:

- `server/_core/generationFlow.ts`
- `server/_core/webhookHandlers.ts`
- `server/_core/messengerWebhook.ts`
- tests

## PR 2

Titel:

`normalize inbound source image handling across channels`

Scope:

- nieuw intern source-image model
- Messenger en WhatsApp invoer daarop laten eindigen
- trusted/provenance centraliseren

## PR 3

Titel:

`introduce conversation engine for shared text decisions`

Scope:

- nieuwe `conversationEngine.ts`
- `sharedTextHandler.ts` reduceren tot wrapper/integratiepunt
- default text/greeting/new-style flow centraliseren

## Definition of done per werkpakket

Een werkpakket is pas echt klaar als:

1. de codegrens duidelijker is dan voordien
2. minstens één bestaande duplicatie echt verwijderd is
3. nieuwe tests de nieuwe boundary afdekken
4. bestaande webhooktests nog steeds logisch leesbaar blijven
5. de diff niet voelt als een halve rewrite

## Niet-doen lijst

Tijdens deze refactorlijn vermijden we best:

- tegelijk productcopy herschrijven
- tegelijk premium/quota-business aanpassen
- experience routing mee hertekenen
- storage-architectuur tegelijk wijzigen
- Messenger en WhatsApp UI tegelijk inhoudelijk herontwerpen

Dat zijn aparte assen van verandering en zouden de refactor onnodig vertroebelen.

## Praktisch advies

Als we morgen met implementatie starten, is het beste eerste target:

- `runStyleGeneration(...)`
- `runWhatsAppStyleGeneration(...)`

Dat is de plek met de hoogste payoff:

- zichtbaar dubbele domeinlogica
- duidelijk af te grenzen
- goed testbaar
- direct relevant voor webhook decoupling

## Slot

Dit plan maakt de refactor concreet zonder de codebase te destabiliseren.

De kernstrategie is:

- eerst gedeelde flow extracten
- daarna state en input centraler modelleren
- pas daarna de transportlaag verder opschonen

Zo houden we snelheid, testbaarheid en mergebaarheid in balans.
