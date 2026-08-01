import type { SupportedUiLang } from "./i18n";
import type { GenerationKind } from "./image-generation/generationTypes";

export type MessengerGenerationJob = {
  psid: string;
  userId: string;
  /** Facebook Page receiving the message; used only for workspace resolution. */
  pageId?: string;
  generationKind?: GenerationKind;
  reqId: string;
  lang: SupportedUiLang;
  sourceImageUrl?: string;
  promptHint?: string;
  attempts?: number;
};
