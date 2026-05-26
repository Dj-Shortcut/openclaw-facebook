import { DIRECTOR_MODES } from "./directorModes";
import type {
  DirectorMode,
  DirectorPackConfig,
  DirectorPackId,
} from "./directorTypes";

export const DIRECTOR_PACKS = {
  diva_edition: {
    id: "diva_edition",
    payload: "DIRECTOR_PACK_DIVA_EDITION",
    label: "Diva Edition",
    description: "Event-ready nightlife looks for Diva-style promo and party content",
    modes: ["midnight_luxury", "berlin_underground", "hyperpop_idol"],
    positioning: "premium event identity, club confidence, and main-character nightlife energy",
    promptDirective:
      "Make the result feel suitable for event promotion, nightlife sharing, or a Diva-style social teaser while keeping the subject authentic.",
    suggestedUseCases: ["event promo", "club portrait", "line-up teaser", "VIP social post"],
    premium: true,
  },
  nightlife: {
    id: "nightlife",
    payload: "DIRECTOR_PACK_NIGHTLIFE",
    label: "Nightlife",
    description: "Club, rave, and after-dark social visuals",
    modes: ["midnight_luxury", "berlin_underground", "hyperpop_idol"],
    positioning: "after-dark atmosphere, social confidence, and shareable club aesthetics",
    promptDirective:
      "Prioritize nightlife lighting, confident social framing, and a polished image that feels made for an evening post.",
    suggestedUseCases: ["party photo", "DJ promo", "club flyer", "afterparty post"],
    premium: true,
  },
  festival: {
    id: "festival",
    payload: "DIRECTOR_PACK_FESTIVAL",
    label: "Festival",
    description: "Outdoor event energy with color, movement, and crowd-ready polish",
    modes: ["hyperpop_idol", "berlin_underground", "midnight_luxury"],
    positioning: "high-energy event presence, color, movement, and big-weekend memory",
    promptDirective:
      "Shape the image like a festival-ready social memory with energy, readable subject focus, and strong mobile impact.",
    suggestedUseCases: ["festival portrait", "after movie still", "weekend recap", "artist promo"],
    premium: true,
  },
  business_profile: {
    id: "business_profile",
    payload: "DIRECTOR_PACK_BUSINESS_PROFILE",
    label: "Business Profile",
    description: "Professional profile upgrades with trust and editorial polish",
    modes: ["vogue_editorial", "old_money"],
    positioning: "credible, polished, approachable, and premium professional presence",
    promptDirective:
      "Keep the result professional, trustworthy, and profile-ready with subtle polish rather than flashy styling.",
    suggestedUseCases: ["LinkedIn photo", "founder portrait", "local business profile", "speaker bio"],
    premium: true,
  },
  creator_pack: {
    id: "creator_pack",
    payload: "DIRECTOR_PACK_CREATOR",
    label: "Creator Pack",
    description: "Creator-first social visuals for thumbnails, reels, and brand posts",
    modes: ["hyperpop_idol", "vogue_editorial", "midnight_luxury"],
    positioning: "attention-grabbing creator identity with platform-native polish",
    promptDirective:
      "Optimize for creator content: strong face readability, scroll-stopping color or polish, and thumbnail-friendly composition.",
    suggestedUseCases: ["profile picture", "reel thumbnail", "brand collab", "content teaser"],
    premium: true,
  },
  dating_profile: {
    id: "dating_profile",
    payload: "DIRECTOR_PACK_DATING_PROFILE",
    label: "Dating Profile",
    description: "Warm, attractive, realistic profile upgrades without looking fake",
    modes: ["old_money", "vogue_editorial", "midnight_luxury"],
    positioning: "natural confidence, approachable polish, and believable profile appeal",
    promptDirective:
      "Keep the image realistic and approachable, with flattering light and natural confidence instead of artificial glamour.",
    suggestedUseCases: ["dating profile", "soft portrait", "lifestyle profile", "natural glow-up"],
    premium: true,
  },
  promo_flyer: {
    id: "promo_flyer",
    payload: "DIRECTOR_PACK_PROMO_FLYER",
    label: "Promo Flyer",
    description: "Poster-like transformations for events, campaigns, and launches",
    modes: ["berlin_underground", "hyperpop_idol", "midnight_luxury"],
    positioning: "bold promotional framing, instant readability, and event-poster energy",
    promptDirective:
      "Make the image feel like it could anchor a promo flyer or campaign visual, without adding unreadable text.",
    suggestedUseCases: ["event flyer", "campaign hero", "launch teaser", "artist poster"],
    premium: true,
  },
  old_school_nostalgia: {
    id: "old_school_nostalgia",
    payload: "DIRECTOR_PACK_NOSTALGIA",
    label: "Old-School Nostalgia",
    description: "Throwback social aesthetics with playful memory-lane energy",
    modes: ["berlin_underground", "hyperpop_idol", "old_money"],
    positioning: "nostalgic personality, era-inspired styling, and shareable throwback mood",
    promptDirective:
      "Use nostalgia as mood and styling inspiration while keeping the subject recognizable and avoiding fake text artifacts.",
    suggestedUseCases: ["throwback post", "retro flyer", "profile remix", "party memory"],
    premium: true,
  },
} as const satisfies Record<DirectorPackId, DirectorPackConfig>;

export const DIRECTOR_PACK_CONFIGS: DirectorPackConfig[] =
  Object.values(DIRECTOR_PACKS);

export function getDirectorPackConfig(packId: DirectorPackId): DirectorPackConfig {
  return DIRECTOR_PACKS[packId];
}

export function directorPackPayloadToPackId(
  payload: string
): DirectorPackId | undefined {
  const normalizedPayload = payload.trim().toUpperCase();
  return DIRECTOR_PACK_CONFIGS.find(pack => pack.payload === normalizedPayload)?.id;
}

export function getDirectorPackModes(packId: DirectorPackId): DirectorMode[] {
  return getDirectorPackConfig(packId).modes.filter(mode => DIRECTOR_MODES[mode]);
}
