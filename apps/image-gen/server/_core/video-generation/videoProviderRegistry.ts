import { OpenAiVideoProvider } from "./openAiVideoProvider";
import type { VideoProvider } from "./videoProvider";

let videoProviderOverride: VideoProvider | null = null;

export function setVideoProviderForTests(provider: VideoProvider | null): void {
  videoProviderOverride = provider;
}

export function getVideoProvider(): VideoProvider {
  if (videoProviderOverride) {
    return videoProviderOverride;
  }

  const provider = process.env.MESSENGER_VIDEO_PROVIDER?.trim().toLowerCase();
  if (provider === "openai") {
    return new OpenAiVideoProvider();
  }

  throw new Error("MESSENGER_VIDEO_PROVIDER is not configured");
}
