function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

export function trimmedText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function extractContentText(item: unknown): string | null {
  const content = objectValue(item)?.content;
  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    const text = trimmedText(objectValue(part)?.text);
    if (text) {
      return text;
    }
  }

  return null;
}

function extractOutputText(raw: unknown): string | null {
  const output = objectValue(raw)?.output;
  if (!Array.isArray(output)) {
    return null;
  }

  for (const item of output) {
    const text = trimmedText(objectValue(item)?.text) ?? extractContentText(item);
    if (text) {
      return text;
    }
  }

  return null;
}

export function extractResponseText(raw: unknown): string | null {
  return trimmedText(objectValue(raw)?.output_text) ?? extractOutputText(raw);
}
