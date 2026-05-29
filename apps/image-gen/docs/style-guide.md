# Style Guide

This document is the authoritative reference for creating, updating, and reviewing image styles in Leaderbot.

The goal is not just consistency, but **predictable, reproducible visual output at scale**.

As the style catalog grows, we optimize for:

* clarity over creativity
* consistency over experimentation
* systems over intuition

---

## When to use this

Use this guide whenever you:

* add a new style
* update an existing style prompt
* regenerate a style preview
* review a PR affecting styles, previews, or metadata

---

## Definition of Done (DoD)

A style is only production-ready when **all** conditions are met:

* The style has a **clear and distinct visual identity**
* The output is **consistent across multiple inputs** (not one lucky sample)
* The preview is **readable at small mobile sizes**
* The prompt is **structured, specific, and reproducible**
* Naming is **consistent across code, assets, and metadata**
* The preview asset is committed in the correct location
* The style has been **compared against existing styles for overlap**

If any of these fail → the style is not ready.

---

## Quality Bar (Preview & Output)

Every style must pass:

* **Strong silhouette**
  Subject is immediately recognizable

* **Clear focal point**
  No muddy or unfocused compositions

* **Small-screen readability**
  Works as a compact mobile thumbnail

* **Controlled background**
  Supports subject, never competes with it

* **Distinct identity**
  Palette, lighting, or mood clearly differentiates the style

* **Stable composition**
  Works across multiple images, not dependent on crop luck

* **Production polish**
  Feels finished, not experimental

---

## Prompt Structure (Required)

All prompts must follow a consistent structure.

This is **mandatory**, not optional.

---

### 1. Subject (required)

Define framing and subject explicitly.

```
close-up portrait of a person, centered, looking at camera
```

Rules:

* Always specify “portrait”
* Face must be central and visible
* Avoid vague subject definitions

---

### 2. Style Identity (required)

Define the visual category clearly.

```
cinematic portrait
cyberpunk aesthetic
anime illustration
```

Rules:

* No vague adjectives (“cool”, “nice”)
* Max 1–2 style influences
* Must be visually recognizable

---

### 3. Scene / Context (recommended)

Ground the subject in a clear environment.

```
set in a neon-lit city at night
studio background with soft gradient
```

Rules:

* Avoid empty or undefined backgrounds
* Context should support, not dominate

---

### 4. Lighting (required)

Lighting is critical for consistency.

```
soft studio lighting
harsh flash lighting
neon rim light
golden hour sunlight
```

Rules:

* Always specify lighting
* Prefer one dominant light source

---

### 5. Color Palette (recommended)

Control the visual tone.

```
muted warm tones
neon blue and magenta
pastel colors
```

Rules:

* Limit to 2–3 dominant colors
* Avoid vague terms like “colorful”

---

### 6. Texture / Medium (optional but powerful)

Adds realism or stylization.

```
film grain
oil paint texture
matte finish
glossy skin
```

---

### 7. Camera / Composition (required)

Ensure consistent framing.

```
35mm lens
shallow depth of field
sharp focus on face
```

Rules:

* Face must always be sharp
* Avoid extreme perspectives

---

### 8. Constraints / Negatives (required)

Prevent common failures.

```
blurry, distorted face, extra limbs, bad anatomy, low detail, oversaturated
```

Rules:

* Minimum 4–6 constraints
* Always protect face quality

---

## Full Prompt Example

```
close-up portrait of a person, centered, looking at camera,
cinematic portrait,
set in a dark environment with subtle background blur,
soft directional lighting with strong shadows,
muted cool tones,
film grain texture,
35mm lens, shallow depth of field, sharp focus on face,
no blur, no distortion, no extra limbs, high detail
```

---

## Prompt Quality Rules

A good prompt is:

* specific
* visual
* structured
* reproducible

A bad prompt is:

* vague
* overloaded
* inconsistent
* dependent on luck

---

## Critical Rule

If output is inconsistent, the issue is almost always missing structure
(lighting, camera, or constraints), not the model itself.

---

## Preview Rules

Preview images must:

* represent the style honestly
* be centered and readable as a thumbnail
* keep the face clearly visible
* avoid edge crops or awkward framing
* avoid detail-heavy compositions that break on mobile
* feel consistent with the existing style set

If a preview only works at full resolution → reject it.

---

## Naming & Asset Conventions

Consistency is required:

* Use kebab-case for style IDs
* Use the same ID across:

  * filenames
  * metadata
  * prompt references

Assets:

* Previews → `public/style-previews/`
* Metadata → `public/style-previews/manifest.json`

Before merging:

* filename matches style id
* manifest path is correct
* metadata uses consistent naming

---

## Style Catalog Rules

* Each style must be visually distinct
* Avoid overlapping styles with minor differences
* Prefer fewer strong styles over many weak ones
* New styles must be compared to adjacent ones before approval

---

## Review Checklist

Before approving:

* Is the style visually distinct?
* Does it work at thumbnail size?
* Is the subject readable within 1 second?
* Is the prompt structured and reproducible?
* Is composition stable across samples?
* Does it feel production-ready?
* Are naming and assets correct?

---

## PR Expectations

Include:

* style id
* what changed (prompt / preview / both)
* reason for change
* any tradeoffs

---

## Practical Workflow

1. Define the style in one sentence
2. Write a structured prompt (using required blocks)
3. Generate multiple samples
4. Select based on thumbnail readability, not just quality
5. Add preview + metadata
6. Compare against existing styles
7. Final mobile-size sanity check

---

## Tie-breaker Rule

If forced to choose between:

* artistic but unclear
* clear and consistent

Choose clear and consistent.

---

## Maintenance Note

This document is a living system.

If recurring issues appear:

* update this guide
* enforce the rule in the same PR
