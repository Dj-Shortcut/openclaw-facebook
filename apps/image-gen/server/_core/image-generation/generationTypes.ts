export type GenerationKind =
  | "text_to_image"
  | "source_image_edit";

/** Keep multi-image edits bounded for provider cost, payload size, and abuse protection. */
export const MAX_SOURCE_IMAGES = 4;
