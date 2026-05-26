import { hasBotFeature, registerBotFeature } from "./features";
import { rateLimitFeature } from "./features/rateLimitFeature";
import { styleCommandsFeature } from "./features/styleCommandsFeature";
import { conversationalEditingFeature } from "./features/conversationalEditingFeature";
import { assistantCommandsFeature } from "./features/assistantCommandsFeature";
import { statsFeature } from "./features/statsFeature";

export function ensureDefaultBotFeaturesRegistered(): void {
  const defaults = [
    rateLimitFeature,
    styleCommandsFeature,
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
