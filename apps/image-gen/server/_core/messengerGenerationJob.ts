import type { Lang } from "./i18n";
import type { GenerationKind } from "./image-generation/generationTypes";

export type MessengerGenerationJob = {
  psid: string;
  userId: string;
  generationKind?: GenerationKind;
  reqId: string;
  lang: Lang;
  sourceImageUrl?: string;
  promptHint?: string;
  attempts?: number;
};
