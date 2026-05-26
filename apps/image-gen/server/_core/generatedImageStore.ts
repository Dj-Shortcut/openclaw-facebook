import { randomUUID } from "node:crypto";

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ITEMS = 200;

type StoredImage = {
  buffer: Buffer;
  contentType: string;
  expiresAt: number;
};

const generatedImages = new Map<string, StoredImage>();

function getTtlMs(): number {
  const raw = Number.parseInt(process.env.GENERATED_IMAGE_TTL_MS ?? "", 10);
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }

  return DEFAULT_TTL_MS;
}

function getMaxItems(): number {
  const raw = Number.parseInt(process.env.GENERATED_IMAGE_MAX_ITEMS ?? "", 10);
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }

  return DEFAULT_MAX_ITEMS;
}

function pruneExpired(now = Date.now()): void {
  for (const [token, value] of generatedImages.entries()) {
    if (value.expiresAt <= now) {
      generatedImages.delete(token);
    }
  }
}

function pruneOverflow(): void {
  const maxItems = getMaxItems();
  if (generatedImages.size <= maxItems) {
    return;
  }

  const overBy = generatedImages.size - maxItems;
  const keys = generatedImages.keys();
  for (let i = 0; i < overBy; i += 1) {
    const next = keys.next();
    if (next.done) {
      break;
    }
    generatedImages.delete(next.value);
  }
}

export function putGeneratedImage(buffer: Buffer, contentType = "image/jpeg"): string {
  const now = Date.now();
  pruneExpired(now);

  const token = randomUUID();
  generatedImages.set(token, {
    buffer,
    contentType,
    expiresAt: now + getTtlMs(),
  });

  pruneOverflow();

  return token;
}

export function getGeneratedImage(token: string): { buffer: Buffer; contentType: string } | null {
  const now = Date.now();
  const stored = generatedImages.get(token);
  if (!stored) {
    return null;
  }

  if (stored.expiresAt <= now) {
    generatedImages.delete(token);
    return null;
  }

  return {
    buffer: stored.buffer,
    contentType: stored.contentType,
  };
}

export function buildGeneratedImageUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/generated/${encodeURIComponent(token)}.jpg`;
}
