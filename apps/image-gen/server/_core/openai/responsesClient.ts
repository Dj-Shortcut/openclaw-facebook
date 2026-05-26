const RESPONSES_API_URL = "https://api.openai.com/v1/responses";

export async function postResponsesPayload(input: {
  payload: unknown;
  timeoutMs: number;
}): Promise<Response | undefined> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    return undefined;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), input.timeoutMs);

  try {
    return await fetch(RESPONSES_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(input.payload),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}
