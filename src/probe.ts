import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { MessengerProbeResult } from "./types.js";

const DEFAULT_GRAPH_API_VERSION = "v20.0";

export async function probeMessengerPage(params: {
  pageId: string;
  pageAccessToken: string;
  graphApiVersion?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}): Promise<MessengerProbeResult> {
  const pageId = params.pageId.trim();
  const token = params.pageAccessToken.trim();
  if (!pageId || !token) {
    return { ok: false, error: "Messenger credentials missing" };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 5000);
  try {
    const version = params.graphApiVersion?.trim() || DEFAULT_GRAPH_API_VERSION;
    const response = await (params.fetch ?? fetch)(
      `https://graph.facebook.com/${version}/${encodeURIComponent(pageId)}?fields=id,name`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: controller.signal,
      },
    );
    const body = (await response.json().catch(() => null)) as { id?: string; name?: string } | null;
    if (!response.ok) {
      return {
        ok: false,
        error: `Messenger Page probe failed with HTTP ${response.status}`,
      };
    }
    return {
      ok: true,
      page: {
        id: body?.id,
        name: body?.name,
      },
    };
  } catch (error) {
    return { ok: false, error: formatErrorMessage(error) };
  } finally {
    clearTimeout(timeout);
  }
}
