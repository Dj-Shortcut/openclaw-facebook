import type { DirectorMode, DirectorModeConfig } from "./directorTypes";
import type { Style } from "../../messengerStyles";

export const DIRECTOR_GENERATION_STYLE: Style = "cinematic";

export const DIRECTOR_MODES = {
  midnight_luxury: {
    mode: "midnight_luxury",
    payload: "DIRECTOR_MIDNIGHT_LUXURY",
    label: "Midnight Luxury",
    description: "Premium nightlife glow-up",
    vibe: "premium nightlife confidence with elegant tension, rich blacks, controlled glamour, and polished after-dark atmosphere",
    lighting: "cinematic flash accents, sculpted rim light, glossy highlights, and deep shadow separation",
    composition: "confident portrait-forward composition with the subject clearly framed as the hero",
    colorGrading: "rich blacks, champagne warmth, muted jewel tones, refined contrast, and subtle editorial polish",
    background: "upscale night venue atmosphere with tasteful depth, glow, and visual context that supports the subject",
    cameraFeel: "premium social editorial photography with a crisp lens, realistic texture, and controlled drama",
    socialFraming: "profile-ready or post-ready crop with strong visual impact on mobile feeds",
  },
  berlin_underground: {
    mode: "berlin_underground",
    payload: "DIRECTOR_BERLIN_UNDERGROUND",
    label: "Berlin Underground",
    description: "Raw techno poster energy",
    vibe: "raw techno-club energy with hard flash, concrete texture, grain, and underground confidence",
    lighting: "direct flash, stark contrast, club spill light, and gritty shadows without losing facial clarity",
    composition: "poster-like framing with bold negative space and a strong central subject presence",
    colorGrading: "desaturated blacks, cool concrete greys, occasional red or green club-light accents, and film grain",
    background: "brutalist nightlife environment, concrete walls, stickers, smoke, or industrial club atmosphere",
    cameraFeel: "analog party photography with editorial control, authentic grit, and intentional imperfection",
    socialFraming: "shareable nightlife-poster crop that reads instantly in a fast-scrolling feed",
  },
  vogue_editorial: {
    mode: "vogue_editorial",
    payload: "DIRECTOR_VOGUE_EDITORIAL",
    label: "Vogue Editorial",
    description: "High-fashion magazine polish",
    vibe: "high-fashion magazine presence with refined styling, poise, elegance, and premium visual restraint",
    lighting: "sculpted studio lighting, clean highlights, soft shadow shaping, and polished skin texture",
    composition: "fashion editorial framing with elongated lines, balanced posture, and confident subject hierarchy",
    colorGrading: "refined neutral tones, controlled saturation, luxurious contrast, and magazine-grade finish",
    background: "minimal editorial set or tasteful architectural backdrop that keeps focus on the subject",
    cameraFeel: "high-end fashion photography with realistic detail, premium lens depth, and precise styling",
    socialFraming: "cover-worthy vertical or square crop with strong profile and campaign appeal",
  },
  hyperpop_idol: {
    mode: "hyperpop_idol",
    payload: "DIRECTOR_HYPERPOP_IDOL",
    label: "Hyperpop Idol",
    description: "Glossy creator thumbnail color",
    vibe: "electric pop-star energy with glossy color, playful surreal detail, and confident creator charisma",
    lighting: "bright neon accents, glossy specular highlights, colorful rim light, and clean facial readability",
    composition: "dynamic idol framing with playful depth, energetic shapes, and a clear hero subject",
    colorGrading: "electric pinks, cyans, acid greens, violet highlights, and polished digital vibrance",
    background: "stylized pop-stage or creator-world atmosphere with graphic details that do not overpower the face",
    cameraFeel: "glossy music-video still with crisp rendering, playful surreal polish, and modern social energy",
    socialFraming: "attention-grabbing creator thumbnail crop with bold color and instant personality",
  },
  old_money: {
    mode: "old_money",
    payload: "DIRECTOR_OLD_MONEY",
    label: "Old Money",
    description: "Quiet luxury profile energy",
    vibe: "quiet luxury, understated confidence, heritage elegance, and relaxed premium taste",
    lighting: "warm natural light, soft window glow, gentle highlights, and elegant shadow falloff",
    composition: "restrained portrait composition with calm posture, balanced spacing, and subtle status cues",
    colorGrading: "warm neutrals, cream, navy, forest green, soft gold, and low-key cinematic contrast",
    background: "tasteful heritage interior, garden, terrace, classic architecture, or refined lifestyle setting",
    cameraFeel: "timeless lifestyle editorial with realistic textures, natural lens depth, and quiet polish",
    socialFraming: "elegant profile-ready crop that feels premium without looking flashy",
  },
} as const satisfies Record<DirectorMode, DirectorModeConfig>;

export function getDirectorModeConfig(mode: DirectorMode): DirectorModeConfig {
  return DIRECTOR_MODES[mode];
}

export const DIRECTOR_MODE_CONFIGS: DirectorModeConfig[] = Object.values(
  DIRECTOR_MODES
);

export function directorPayloadToMode(payload: string): DirectorMode | undefined {
  const normalizedPayload = payload.trim().toUpperCase();
  return DIRECTOR_MODE_CONFIGS.find(
    mode => mode.payload === normalizedPayload
  )?.mode;
}
