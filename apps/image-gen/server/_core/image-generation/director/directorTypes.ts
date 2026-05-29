export type DirectorMode =
  | "midnight_luxury"
  | "berlin_underground"
  | "vogue_editorial"
  | "hyperpop_idol"
  | "old_money";

export type DirectorModeConfig = {
  mode: DirectorMode;
  payload: string;
  label: string;
  description: string;
  vibe: string;
  lighting: string;
  composition: string;
  colorGrading: string;
  background: string;
  cameraFeel: string;
  socialFraming: string;
};

export type DirectorPromptInput = {
  mode: DirectorMode;
  userInstruction?: string;
  photoAnalysis?: string;
};

export type DirectorPackId =
  | "diva_edition"
  | "nightlife"
  | "festival"
  | "business_profile"
  | "creator_pack"
  | "dating_profile"
  | "promo_flyer"
  | "old_school_nostalgia";

export type DirectorPackConfig = {
  id: DirectorPackId;
  payload: string;
  label: string;
  description: string;
  modes: DirectorMode[];
  positioning: string;
  promptDirective: string;
  suggestedUseCases: string[];
  premium: boolean;
};
