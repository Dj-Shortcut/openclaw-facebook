import { type Style } from "../messengerStyles";

const STYLE_PROMPTS = {
  caricature:
    "Transform this photo into a high-end caricature portrait with playfully exaggerated facial proportions, crisp inked contours, dimensional cel-shaded rendering, punchy studio key lighting, a saturated carnival palette of cherry red, cobalt, tangerine, and teal, and an energetic mischievous mood with polished illustration detail.",
  "storybook-anime":
    "Transform this photo into a whimsical hand-drawn fantasy illustration with a warm storybook atmosphere. Preserve the subject identity while rendering the image as a soft, painterly animated scene with delicate linework, hand-painted background sensibility, lush natural greens and sun-washed earth tones, gentle expressive eyes, subtly simplified anatomy, cozy fantasy details, soft daylight or golden-hour lighting, and a nostalgic magical mood. The result should feel like a lovingly crafted illustrated animation frame with a warm human touch, clearly non-photorealistic and never like a generic photo filter.",
  "afroman-americana":
    "Transform this photo into a premium stylized portrait in an Afroman-inspired Americana look. Preserve the subject identity and facial features while dressing them in a tailored American flag suit with bold retro Americana energy, a relaxed victorious expression, crisp silhouette, polished illustrative rendering, rich red white and blue color balance, iconic stage charisma, and a clean composition.",
  gold:
    "Reimagine this portrait as a luxe gilded editorial artwork with molten gold highlights, champagne and amber color grading, sculpted rim lighting, glossy reflective surfaces, regal opulent mood, and ultra-detailed rendered textures that feel like a premium fashion campaign dipped in liquid metal.",
  petals:
    "Turn this image into a romantic floral fantasy portrait surrounded by drifting blossom petals, luminous backlighting, a soft pastel palette of rose, blush, ivory, and fresh green, dreamy springtime mood, velvety skin rendering, and richly detailed painterly depth with graceful motion in every petal.",
  clouds:
    "Render this portrait as an ethereal skyborne scene wrapped in layered clouds, diffused sunrise lighting, airy gradients of pearl white, pale blue, silver, and warm peach, serene uplifting mood, soft atmospheric depth, and finely rendered cinematic detail that blends realism with dreamlike softness.",
  cinematic:
    "Reframe this photo as a prestige-film still with dramatic directional lighting, deep shadows, subtle lens bloom, a refined teal-and-amber palette, moody emotionally charged atmosphere, shallow depth of field, and richly detailed photoreal rendering with premium color-graded cinema texture.",
  disco:
    "Convert this portrait into a glamorous disco-era hero shot with mirror-ball reflections, magenta and electric blue spotlights, glittering highlights, a bold nightlife palette of fuchsia, violet, cyan, and chrome, euphoric dance-floor mood, and glossy high-detail rendering full of sparkle and motion.",
  cyberpunk:
    "Transform this photo into a cyberpunk portrait with neon signage glow, rain-slick reflections, intense high-contrast lighting, a vivid palette of electric pink, cyan, ultraviolet, and toxic blue, rebellious futuristic mood, and dense digital-art rendering packed with atmospheric sci-fi detail.",
  "oil-paint":
    "Render this portrait as a classical oil painting with visible brush strokes, textured canvas grain, sculpted painterly lighting, a rich museum-grade palette of umber, ochre, crimson, and deep blue, dignified fine-art mood, and layered artisanal detail throughout the composition.",
  "norman-blackwell":
    "Reimagine this photo as a nostalgic mid-century American editorial illustration with warm storybook lighting, an all-American palette of cream, brick red, muted teal, and honey gold, heartfelt small-town mood, painterly realism, expressive character detail, and the polished finish of a vintage family magazine cover from the 1940s or 1950s.",
} satisfies Record<Style, string>;

export function buildStylePrompt(style: Style, promptHint?: string): string {
  const basePrompt = STYLE_PROMPTS[style];

  const trimmedPromptHint = promptHint?.trim();
  if (!trimmedPromptHint) {
    return basePrompt;
  }

  // TODO: move prompt-level validation here once promptBuilder owns its own tests.
  return `${basePrompt} Additional direction: ${trimmedPromptHint}.`;
}
