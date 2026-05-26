# Invite Image Export Checklist

Gebruik deze checklist voor alle share/invite-afbeeldingen die bedoeld zijn voor Facebook, Messenger en andere Open Graph previews.

## Exports

Maak altijd 2 versies:

- `1200x630` - standaard Open Graph landscape
- `1200x1200` - square fallback

## Bestandsnamen

Gebruik versie in de bestandsnaam. Overschrijf niet telkens hetzelfde bestand.
Bij elke zichtbare update: verander de bestandsnaam.

Voorbeeld:

- `public/og/invite-v2-1200x630.png`
- `public/og/invite-v2-1200x1200.png`

Waarom:

- duidelijk welke versie live staat
- makkelijker rollbacken
- eenvoudiger cache-busting bij Facebook previews

Belangrijk:

- `v1`, `v2`, `v3` in de bestandsnaam zijn alleen versies voor mensen.
- Meta kiest niet op basis van bestandsnaam.
- Welke preview wordt getoond hangt af van de `og:image` tags (volgorde, ratio, context en cache).

## OG Image URLs

Gebruik in Open Graph tags altijd absolute publieke HTTPS-URLs, nooit lokale paden of relatieve aannames.

Goed:

- `https://leaderbot.live/og/invite-v2-1200x630.png`

Niet goed:

- `/og/invite-v2-1200x630.png`
- `public/og/invite-v2-1200x630.png`
- localhost-URLs

## Vereiste Open Graph Metadata Per Afbeelding

Voor elke invite/share-pagina moet minstens dit gezet worden:

- `og:image`
- `og:image:width`
- `og:image:height`
- `og:image:alt`

Als je meerdere image-opties wil aanbieden, zet meerdere `og:image` blokken.
Zet je voorkeursafbeelding altijd als eerste.

Huidige implementatie voor `identity-ai-v1`:

- `https://leaderbot.live/og/identity-ai-v1-invite-v2.png` -> `1536x1024`
- `https://leaderbot.live/og/identity-ai-v1-invite-v1.png` -> `1024x1536`

Voorbeeld:

```html
<meta property="og:image" content="https://leaderbot.live/og/invite-v2-1200x630.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta property="og:image:alt" content="Leaderbot invite preview" />
<meta property="og:image" content="https://leaderbot.live/og/invite-v2-1200x1200.png" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="1200" />
<meta property="og:image:alt" content="Leaderbot invite preview (square)" />
```

## Cache-Busting

Bij elke zichtbare update aan een invite-afbeelding:

- geef het bestand een nieuwe naam
- verhoog de versie in de filename
- deploy daarna opnieuw

Voorbeeld:

- `invite-v2-1200x630.png` -> `invite-v3-1200x630.png`

Gebruik geen stille overwrite van dezelfde filename als je snelle preview-updates op Facebook wilt zien.

## Na Elke Deploy

Voer altijd deze stap uit:

1. Open Facebook Sharing Debugger.
2. Plak de exacte invite-URL.
3. Klik `Scrape Again`.

Gebruik daarvoor altijd de invite/share-URL op het eigen domein, niet een `m.me`-link of andere Facebook-URL.

## Aanbevolen Workflow

1. Ontwerp exporteren in 2 formaten.
2. Bestanden opslaan met versienummer.
3. Assets in `public/og/` zetten.
4. Invite-route laten verwijzen naar absolute HTTPS image-URL.
5. Deployen.
6. Sharing Debugger -> exacte invite-URL -> `Scrape Again`.
