import type {
  BotErrorContext,
  BotImageContext,
  BotPayloadContext,
  BotTextContext,
  FeatureResult,
} from "../botContext";

export type BotFeature = {
  name: string;
  onText?(ctx: BotTextContext): Promise<FeatureResult | void> | FeatureResult | void;
  onPayload?(
    ctx: BotPayloadContext
  ): Promise<FeatureResult | void> | FeatureResult | void;
  onImage?(ctx: BotImageContext): Promise<FeatureResult | void> | FeatureResult | void;
  onError?(ctx: BotErrorContext): Promise<void> | void;
};

const botFeatures: BotFeature[] = [];

export function getBotFeatures(): readonly BotFeature[] {
  return botFeatures;
}

export function registerBotFeature(feature: BotFeature): void {
  if (botFeatures.some(existing => existing.name === feature.name)) {
    throw new Error(`Bot feature "${feature.name}" is already registered`);
  }

  botFeatures.push(feature);
}

export function hasBotFeature(name: string): boolean {
  return botFeatures.some(feature => feature.name === name);
}
