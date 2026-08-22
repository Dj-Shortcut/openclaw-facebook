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
  const graphVersion = options.graphVersion ?? process.env.META_GRAPH_VERSION ?? "v21.0";
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!appId || !appSecret) {
    throw new Error(
      "META_APP_ID and META_APP_SECRET are required for Meta callback drift checks",
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

  const subscriptions = new Map(payload.data.map((item) => [item.object, item]));
  const errors = [];
  const warnings = [];
  const callbacks = [];
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
    for (const field of expected.requiredFields) {
      if (!actualFields.has(field)) {
        errors.push(`${object} is missing required field ${field}`);
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
