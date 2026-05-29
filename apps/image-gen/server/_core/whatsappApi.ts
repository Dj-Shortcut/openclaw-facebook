import { getEnv } from "./env";
import { createLogger } from "./logger";

const GRAPH_API_VERSION = "v19.0";
const logger = createLogger({});
const DEFAULT_WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS = 10_000;
const DEFAULT_WHATSAPP_MEDIA_MAX_BYTES = 20 * 1024 * 1024;

export type WhatsAppReplyButton = {
  id: string;
  title: string;
};

export type WhatsAppListRow = {
  id: string;
  title: string;
  description?: string;
};

function getWhatsAppAccessToken(): string {
  return getEnv("WHATSAPP_ACCESS_TOKEN");
}

function getWhatsAppPhoneNumberId(): string {
  return getEnv("WHATSAPP_PHONE_NUMBER_ID");
}

function getWhatsAppSendUrl(): string {
  return `https://graph.facebook.com/${GRAPH_API_VERSION}/${encodeURIComponent(getWhatsAppPhoneNumberId())}/messages`;
}

function getGraphApiUrl(path: string): string {
  return `https://graph.facebook.com/${GRAPH_API_VERSION}/${path.replace(/^\/+/, "")}`;
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return response.statusText;
  }
}

async function fetchWhatsAppGraph(
  pathOrUrl: string,
  init: RequestInit = {}
): Promise<Response> {
  const url = /^https?:\/\//i.test(pathOrUrl)
    ? pathOrUrl
    : getGraphApiUrl(pathOrUrl);

  return fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${getWhatsAppAccessToken()}`,
      ...(init.headers ?? {}),
    },
  });
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : fallback;
}

function getWhatsAppMediaDownloadTimeoutMs(): number {
  return readPositiveIntEnv(
    "WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS",
    DEFAULT_WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS
  );
}

function getWhatsAppMediaMaxBytes(): number {
  return readPositiveIntEnv(
    "WHATSAPP_MEDIA_MAX_BYTES",
    DEFAULT_WHATSAPP_MEDIA_MAX_BYTES
  );
}

function assertWhatsAppMediaWithinLimit(byteLength: number): void {
  const maxBytes = getWhatsAppMediaMaxBytes();
  if (byteLength > maxBytes) {
    throw new Error(`WhatsApp media too large (${byteLength} bytes)`);
  }
}

async function readWhatsAppMediaBuffer(response: Response): Promise<Buffer> {
  const contentLength = Number.parseInt(
    response.headers.get("content-length") ?? "",
    10
  );
  if (Number.isFinite(contentLength) && contentLength > 0) {
    assertWhatsAppMediaWithinLimit(contentLength);
  }

  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    assertWhatsAppMediaWithinLimit(buffer.length);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }

    totalBytes += value.byteLength;
    try {
      assertWhatsAppMediaWithinLimit(totalBytes);
    } catch (error) {
      await reader.cancel();
      throw error;
    }
    chunks.push(value);
  }

  return Buffer.concat(
    chunks.map(chunk =>
      Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    )
  );
}

async function assertWhatsAppResponseOk(
  response: Response,
  event: string
): Promise<void> {
  if (response.ok) {
    return;
  }

  const responseBody = await readErrorBody(response);
  logger.error({
    event,
    status: response.status,
    statusText: response.statusText,
    body: responseBody,
  });

  throw new Error(`WhatsApp API error ${response.status}: ${responseBody}`);
}

export async function sendWhatsAppText(
  to: string,
  message: string
): Promise<void> {
  const response = await fetchWhatsAppGraph(getWhatsAppSendUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message },
    }),
  });

  await assertWhatsAppResponseOk(response, "whatsapp_send_failed");
}

export async function sendWhatsAppImage(
  to: string,
  imageUrl: string
): Promise<void> {
  const response = await fetchWhatsAppGraph(getWhatsAppSendUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: { link: imageUrl },
    }),
  });

  await assertWhatsAppResponseOk(response, "whatsapp_image_send_failed");
}

export async function sendWhatsAppButtons(
  to: string,
  bodyText: string,
  buttons: WhatsAppReplyButton[]
): Promise<void> {
  const response = await fetchWhatsAppGraph(getWhatsAppSendUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text: bodyText },
        action: {
          buttons: buttons.slice(0, 3).map(button => ({
            type: "reply",
            reply: {
              id: button.id,
              title: button.title.slice(0, 20),
            },
          })),
        },
      },
    }),
  });

  await assertWhatsAppResponseOk(response, "whatsapp_buttons_send_failed");
}

export async function sendWhatsAppList(
  to: string,
  bodyText: string,
  buttonText: string,
  rows: WhatsAppListRow[],
  sectionTitle = "Styles"
): Promise<void> {
  const response = await fetchWhatsAppGraph(getWhatsAppSendUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "list",
        body: { text: bodyText },
        action: {
          button: buttonText.slice(0, 20),
          sections: [
            {
              title: sectionTitle.slice(0, 24),
              rows: rows.slice(0, 10).map(row => ({
                id: row.id,
                title: row.title.slice(0, 24),
                ...(row.description
                  ? { description: row.description.slice(0, 72) }
                  : {}),
              })),
            },
          ],
        },
      },
    }),
  });

  await assertWhatsAppResponseOk(response, "whatsapp_list_send_failed");
}

export async function downloadWhatsAppMedia(
  mediaId: string
): Promise<{ buffer: Buffer; contentType: string }> {
  const metadataResponse = await fetchWhatsAppGraph(
    `${encodeURIComponent(mediaId)}`
  );
  await assertWhatsAppResponseOk(
    metadataResponse,
    "whatsapp_media_metadata_failed"
  );

  const metadata = (await metadataResponse.json()) as {
    url?: string;
    mime_type?: string;
  };
  const mediaUrl = metadata.url?.trim();
  if (!mediaUrl) {
    throw new Error("WhatsApp media metadata response missing url");
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, getWhatsAppMediaDownloadTimeoutMs());
  try {
    const mediaResponse = await fetchWhatsAppGraph(mediaUrl, {
      signal: controller.signal,
    });
    await assertWhatsAppResponseOk(mediaResponse, "whatsapp_media_download_failed");

    const contentType =
      mediaResponse.headers.get("content-type") ??
      metadata.mime_type?.trim() ??
      "application/octet-stream";

    return {
      buffer: await readWhatsAppMediaBuffer(mediaResponse),
      contentType,
    };
  } finally {
    clearTimeout(timeout);
  }
}
