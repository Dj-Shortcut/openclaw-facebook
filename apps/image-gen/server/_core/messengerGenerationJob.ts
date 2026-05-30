import type { Lang } from "./i18n";
import type { DirectorMode } from "./image-generation/director/directorTypes";
import type { Style } from "./messengerStyles";

export type MessengerGenerationJob = {
  psid: string;
  userId: string;
  style: Style;
  generationKind?: "style_restyle" | "text_to_image";
  reqId: string;
  lang: Lang;
  sourceImageUrl?: string;
  promptHint?: string;
  directorMode?: DirectorMode;
  attempts?: number;
};
