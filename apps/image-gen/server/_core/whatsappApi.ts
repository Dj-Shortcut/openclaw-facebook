import { getEnv } from "./env";
import { createLogger } from "./logger";

const GRAPH_API_VERSION = "v19.0";
const logger = createLogger({});

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

  const mediaResponse = await fetchWhatsAppGraph(mediaUrl);
  await assertWhatsAppResponseOk(mediaResponse, "whatsapp_media_download_failed");

  const contentType =
    mediaResponse.headers.get("content-type") ??
    metadata.mime_type?.trim() ??
    "application/octet-stream";

  return {
    buffer: Buffer.from(await mediaResponse.arrayBuffer()),
    contentType,
  };
}
