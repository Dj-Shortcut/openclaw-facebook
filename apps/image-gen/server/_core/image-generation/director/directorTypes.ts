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
