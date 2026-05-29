const DEFAULT_GRAPH_API_VERSION = "v21.0";
const DEFAULT_PROFILE_SYNC_TIMEOUT_MS = 5_000;

export type MessengerProfileSyncResult =
  | { status: "cleared" }
  | { status: "skipped"; reason: "disabled" | "missing_token" };

type FetchLike = typeof fetch;

type LoggerLike = Pick<typeof console, "info" | "warn">;

function parseBooleanFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function shouldClearMessengerIceBreakers(): boolean {
  const configured = parseBooleanFlag(
    process.env.MESSENGER_CLEAR_ICE_BREAKERS_ON_STARTUP ??
      process.env.MESSENGER_REMOVE_START_SCREEN_PILLS
  );
  if (configured !== undefined) {
    return configured;
  }

  return process.env.NODE_ENV === "production";
}

function getGraphApiVersion(): string {
  const configured = process.env.FB_GRAPH_API_VERSION?.trim();
  return configured || DEFAULT_GRAPH_API_VERSION;
}

function getPageAccessToken(): string {
  return process.env.FB_PAGE_ACCESS_TOKEN?.trim() ?? "";
}

function getProfileSyncTimeoutMs(): number {
  const configured = Number(process.env.MESSENGER_PROFILE_SYNC_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }

  return DEFAULT_PROFILE_SYNC_TIMEOUT_MS;
}

function getMessengerProfileUrl(): string {
  const url = new URL(
    `https://graph.facebook.com/${getGraphApiVersion()}/me/messenger_profile`
  );
  url.searchParams.set("fields", JSON.stringify(["ice_breakers"]));
  return url.toString();
}

async function getSafeErrorBody(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  return text.trim().slice(0, 500);
}

export async function clearMessengerStartScreenPills(
  options: {
    fetchImpl?: FetchLike;
    logger?: LoggerLike;
  } = {}
): Promise<MessengerProfileSyncResult> {
  const logger = options.logger ?? console;

  if (!shouldClearMessengerIceBreakers()) {
    logger.info("[messenger profile] start-screen ice breakers sync disabled");
    return { status: "skipped", reason: "disabled" };
  }

  const pageAccessToken = getPageAccessToken();
  if (!pageAccessToken) {
    logger.warn(
      "[messenger profile] FB_PAGE_ACCESS_TOKEN missing; cannot clear start-screen ice breakers"
    );
    return { status: "skipped", reason: "missing_token" };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    getProfileSyncTimeoutMs()
  );
  let response: Response;
  try {
    response = await fetchImpl(getMessengerProfileUrl(), {
      method: "DELETE",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${pageAccessToken}`,
      },
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const body = await getSafeErrorBody(response);
    throw new Error(
      `Messenger profile ice breaker cleanup failed (${response.status})${
        body ? `: ${body}` : ""
      }`
    );
  }

  logger.info(
    "[messenger profile] cleared start-screen ice breakers so new chats do not show stale pills"
  );
  return { status: "cleared" };
}

export async function reconcileMessengerProfileOnStartup(
  options: {
    fetchImpl?: FetchLike;
    logger?: LoggerLike;
  } = {}
): Promise<
  MessengerProfileSyncResult | { status: "skipped"; reason: "cleanup_failed" }
> {
  try {
    return await clearMessengerStartScreenPills(options);
  } catch (error) {
    const logger = options.logger ?? console;
    logger.warn("[messenger profile] start-screen ice breaker cleanup failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { status: "skipped", reason: "cleanup_failed" };
  }
}
