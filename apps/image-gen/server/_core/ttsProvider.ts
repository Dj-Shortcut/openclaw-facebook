const OPENAI_TTS_URL = "https://api.openai.com/v1/audio/speech";

export async function generateSpeechAudio(
  text: string,
  options: { signal?: AbortSignal } = {}
): Promise<Uint8Array> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is missing");
  const response = await fetch(OPENAI_TTS_URL, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    signal: options.signal,
    body: JSON.stringify({
      model: process.env.OPENAI_TTS_MODEL?.trim() || "gpt-4o-mini-tts",
      voice: process.env.OPENAI_TTS_VOICE?.trim() || "alloy",
      input: text.slice(0, 4000),
      response_format: "mp3",
    }),
  });
  if (!response.ok) throw new Error(`TTS provider returned ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}
