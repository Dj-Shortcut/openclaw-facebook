import { hasBotFeature, registerBotFeature } from "./features";
import { rateLimitFeature } from "./features/rateLimitFeature";
import { conversationalEditingFeature } from "./features/conversationalEditingFeature";
import { freeformTransformFeature } from "./features/freeformTransformFeature";
import { imageRequestFeature } from "./features/imageRequestFeature";
import { assistantCommandsFeature } from "./features/assistantCommandsFeature";
import { statsFeature } from "./features/statsFeature";

export function ensureDefaultBotFeaturesRegistered(): void {
  const defaults = [
    rateLimitFeature,
    freeformTransformFeature,
    imageRequestFeature,
    conversationalEditingFeature,
    assistantCommandsFeature,
    statsFeature,
  ] as const;

  for (const feature of defaults) {
    if (!hasBotFeature(feature.name)) {
      registerBotFeature(feature);
    }
  }
}
