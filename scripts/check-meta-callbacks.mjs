import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_PATH = "deploy/production/apps.json";

function normalizeUrl(value) {
  const url = new URL(value);
  url.hash = "";
  url.search = "";
  return url.toString().replace(/\/$/, "");
}

function callbackSummary(value) {
  const url = new URL(value);
  return `${url.hostname}${url.pathname}`;
}

export async function checkMetaCallbacks(options = {}) {
  const rootDir = options.rootDir ?? process.cwd();
  const appId = options.appId ?? process.env.META_APP_ID;
  const appSecret = options.appSecret ?? process.env.META_APP_SECRET;
  const pageId = options.pageId ?? process.env.MESSENGER_PAGE_ID;
  const pageAccessToken =
    options.pageAccessToken ?? process.env.MESSENGER_PAGE_ACCESS_TOKEN;
  const graphVersion = options.graphVersion ?? process.env.META_GRAPH_VERSION ?? "v21.0";
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!appId || !appSecret || !pageId || !pageAccessToken) {
    throw new Error(
      "META_APP_ID, META_APP_SECRET, MESSENGER_PAGE_ID, and MESSENGER_PAGE_ACCESS_TOKEN are required for Meta callback drift checks",
    );
  }
  if (!/^v\d+\.\d+$/.test(graphVersion)) {
    throw new Error("META_GRAPH_VERSION must use the vNN.N format");
  }

  const manifest = JSON.parse(
    fs.readFileSync(path.join(rootDir, MANIFEST_PATH), "utf8"),
  );
  const response = await fetchImpl(
    `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(appId)}/subscriptions`,
    {
      headers: { Authorization: `Bearer ${appId}|${appSecret}` },
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 15_000),
    },
  );
  if (!response.ok) {
    const errorPayload = await response.json().catch(() => undefined);
    const code = errorPayload?.error?.code;
    throw new Error(
      `Meta callback query failed (${response.status}${code ? `, code ${code}` : ""})`,
    );
  }
  const payload = await response.json().catch(() => undefined);
  if (!Array.isArray(payload?.data)) {
    const code = payload?.error?.code;
    throw new Error(
      `Meta callback query failed (${response.status}${code ? `, code ${code}` : ""})`,
    );
  }

  const pageBindingResponse = await fetchImpl(
    `https://graph.facebook.com/${graphVersion}/${encodeURIComponent(pageId)}/subscribed_apps?fields=id%2Csubscribed_fields&limit=100`,
    {
      headers: { Authorization: `Bearer ${pageAccessToken}` },
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 15_000),
    },
  );
  if (!pageBindingResponse.ok) {
    const errorPayload = await pageBindingResponse.json().catch(() => undefined);
    const code = errorPayload?.error?.code;
    throw new Error(
      `Meta Page binding query failed (${pageBindingResponse.status}${code ? `, code ${code}` : ""})`,
    );
  }
  const pageBindingPayload = await pageBindingResponse
    .json()
    .catch(() => undefined);
  if (!Array.isArray(pageBindingPayload?.data)) {
    const code = pageBindingPayload?.error?.code;
    throw new Error(
      `Meta Page binding query failed (${pageBindingResponse.status}${code ? `, code ${code}` : ""})`,
    );
  }

  const subscriptions = new Map(payload.data.map((item) => [item.object, item]));
  const errors = [];
  const warnings = [];
  const callbacks = [];
  const pageBinding = pageBindingPayload.data.find(
    (subscription) => String(subscription?.id ?? "") === String(appId),
  );
  if (!pageBinding) {
    errors.push("Page is not subscribed to the reviewed Meta app");
  } else {
    const expectedPageFields = new Set(manifest.meta.page?.allowedFields ?? []);
    const actualPageFields = new Set(
      (pageBinding.subscribed_fields ?? []).map((field) =>
        typeof field === "string" ? field : field?.name,
      ),
    );
    for (const field of expectedPageFields) {
      if (!actualPageFields.has(field)) {
        errors.push(`Page subscription is missing required field ${field}`);
      }
    }
    for (const field of actualPageFields) {
      if (!expectedPageFields.has(field)) {
        errors.push(`Page subscription uses unreviewed field ${field}`);
      }
    }
  }
  for (const object of subscriptions.keys()) {
    if (!(object in manifest.meta)) {
      errors.push(`Unreviewed Meta subscription object ${object}`);
    }
  }
  for (const [object, expected] of Object.entries(manifest.meta)) {
    const actual = subscriptions.get(object);
    if (!actual?.callback_url) {
      errors.push(`Missing Meta subscription for ${object}`);
      continue;
    }
    const actualUrl = normalizeUrl(actual.callback_url);
    const canonicalUrl = normalizeUrl(expected.expectedCallback);
    const temporaryUrls = expected.temporarilyAllowedCallbacks.map(normalizeUrl);
    callbacks.push({ object, callback: callbackSummary(actualUrl) });
    if (actualUrl !== canonicalUrl) {
      if (temporaryUrls.includes(actualUrl)) {
        warnings.push(
          `${object} still uses reviewed temporary callback drift (${expected.migrationState})`,
        );
      } else {
        errors.push(`${object} uses an unreviewed callback`);
      }
    }
    if (actual.active === false) {
      errors.push(`${object} Meta subscription is inactive`);
    }
    const actualFields = new Set(
      (actual.fields ?? []).map((field) =>
        typeof field === "string" ? field : field?.name,
      ),
    );
    const allowedFields = new Set(expected.allowedFields);
    for (const field of allowedFields) {
      if (!actualFields.has(field)) {
        errors.push(`${object} is missing required field ${field}`);
      }
    }
    for (const field of actualFields) {
      if (!allowedFields.has(field)) {
        errors.push(`${object} uses unreviewed field ${field}`);
      }
    }
  }

  return { callbacks, errors, warnings };
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const result = await checkMetaCallbacks();
  for (const callback of result.callbacks) {
    process.stdout.write(`${callback.object}: ${callback.callback}\n`);
  }
  for (const warning of result.warnings) {
    process.stdout.write(`warning: ${warning}\n`);
  }
  if (result.errors.length) {
    process.stderr.write(`Meta callback drift detected:\n- ${result.errors.join("\n- ")}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write("Meta callback contract validated.\n");
  }
}
