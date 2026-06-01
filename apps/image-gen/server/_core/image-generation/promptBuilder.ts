export function normalizeTextToImageUserPrompt(prompt: string): string {
  let normalized = prompt.trim();
  normalized = normalized.replace(/^```(?:text|prompt)?\s*/i, "").replace(/\s*```$/i, "").trim();

  const wrapperPatterns = [
    /^(?:gebruik|use)\s+(?:deze|this)\s+prompt\s*(?:en\s+maak\s+(?:een\s+)?(?:afbeelding|foto|plaatje)|to\s+(?:make|create|generate)\s+(?:an?\s+)?(?:image|picture|photo))?\s*(?::|\uFF1A|-)\s*/i,
    /^(?:maak|genereer|create|generate)\s+(?:een\s+)?(?:afbeelding|foto|plaatje|image|picture|photo)\s+(?:met|van|from|using)\s+(?:deze|this)\s+prompt\s*(?::|\uFF1A|-)\s*/i,
    /^prompt\s*(?::|\uFF1A|-)\s*/i,
  ];

  for (const pattern of wrapperPatterns) {
    normalized = normalized.replace(pattern, "").trim();
  }

  return normalized || prompt.trim();
}

export function buildTextToImagePrompt(prompt: string): string {
  const trimmedPrompt = normalizeTextToImageUserPrompt(prompt);
  return [
    "Create a new image from the user's request.",
    "Do not reference or require an uploaded/source photo.",
    "Treat the user's words as the creative brief; do not replace them with a preset style catalog.",
    "Follow the requested subject, scene, mood, composition, medium, aspect, and language as closely as possible.",
    "The requested main subject must be visibly present, central enough to recognize immediately, and more important than background scenery or decorative style.",
    "Never substitute the requested subject with a generic scenic fallback, template mood, default landscape, or unrelated aesthetic.",
    "If the request is already detailed or pasted as a prompt, follow it directly instead of rewriting, summarizing, or adding a different concept.",
    "If the request is brief, add only neutral visual specifics that support the explicit subject: simple setting, framing, lighting, materials, atmosphere, and one or two concrete details.",
    "Do not default to cinematic, editorial, fantasy, luxury, anime, landscape, city, poster, or logo aesthetics unless the user asks for them.",
    "Use clean image quality with coherent anatomy and perspective, readable silhouettes, consistent texture, intentional contrast, and no random clutter.",
    "For logos, posters, covers, banners, stickers, avatars, and product-style images, keep the composition readable at small size and avoid accidental text unless the user explicitly asks for readable words.",
    "Avoid generic filler, unwanted text, logos, watermarks, extra signatures, distorted hands/faces, malformed objects, duplicate subjects, or UI elements unless the user explicitly asks for them.",
    `User request: ${trimmedPrompt}`,
  ].join(" ");
}

export function buildSourceImageEditPrompt(prompt: string): string {
  const trimmedPrompt = normalizeTextToImageUserPrompt(prompt);
  return [
    "Edit the uploaded/source image according to the user's request.",
    "Use the source image as the visual reference, not as a preset style catalog.",
    "Preserve important identity, pose, and composition details unless the user explicitly asks to change them.",
    "When transforming a person, preserve recognizable facial structure, expression, body pose, clothing silhouette, and camera framing unless the user asks otherwise.",
    "If the user says a requested subject is missing or not visible, treat that as a visual correction: add or emphasize that subject clearly while keeping the rest of the image coherent.",
    "If the user asks for a follow-up correction, prioritize that correction over any previous aesthetic direction that conflicts with it.",
    "Do not answer with a rewritten prompt; produce the corrected image edit.",
    "Apply the requested change with coherent lighting, believable materials, clean edges, consistent shadows, and clean image quality.",
    "Do not add cinematic, editorial, fantasy, luxury, anime, poster, or logo aesthetics unless the user asks for them.",
    "Keep the edit integrated into the original image instead of looking like a pasted sticker or filter.",
    "Avoid unwanted text, logos, watermarks, extra signatures, distorted hands/faces, malformed objects, duplicate subjects, or UI elements unless the user explicitly asks for them.",
    `User request: ${trimmedPrompt}`,
  ].join(" ");
}
