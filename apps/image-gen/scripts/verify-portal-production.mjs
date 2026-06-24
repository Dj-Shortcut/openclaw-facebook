#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const appName = process.env.LEADERBOT_IMAGE_GEN_FLY_APP || "leaderbot-fb-image-gen";
const appBaseUrl =
  process.env.LEADERBOT_IMAGE_GEN_URL || "https://leaderbot-fb-image-gen.fly.dev";
const publicBaseUrl = process.env.LEADERBOT_PUBLIC_URL || "https://leaderbot.live";

function normalizeBaseUrl(value, name) {
  try {
    const url = new URL(value);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error(`${name} must be a valid absolute URL`);
  }
}

function endpoint(baseUrl, path) {
  return `${baseUrl}${path}`;
}

async function runFly(args) {
  try {
    const { stdout } = await execFileAsync("fly", args, {
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`fly ${args.join(" ")} failed: ${message}`);
  }
}

async function fetchText(url, init) {
  const response = await fetch(url, init);
  const body = await response.text();
  return { response, body };
}

function parseReadiness(body) {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("/readyz did not return JSON");
  }
}

function summarizeReadiness(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.checks)) {
    throw new Error("/readyz payload is missing checks[]");
  }

  return payload.checks.map(check => ({
    name: String(check.name),
    ok: Boolean(check.ok),
    error: typeof check.error === "string" ? check.error : undefined,
  }));
}

async function verifyFlyDatabaseSecret() {
  const output = await runFly(["secrets", "list", "-a", appName]);
  const hasDatabaseUrl = /^ DATABASE_URL\s/m.test(output);

  return {
    name: "fly_secret_DATABASE_URL",
    ok: hasDatabaseUrl,
    detail: hasDatabaseUrl
      ? "DATABASE_URL secret is configured"
      : "DATABASE_URL secret is missing",
  };
}

async function verifyReadiness(appUrl) {
  const { response, body } = await fetchText(endpoint(appUrl, "/readyz"));
  const payload = parseReadiness(body);
  const checks = summarizeReadiness(payload);
  const portalDatabase = checks.find(check => check.name === "portal_database_config");

  return {
    name: "image_gen_readyz",
    ok: response.ok && payload.ok === true && portalDatabase?.ok === true,
    status: response.status,
    detail:
      portalDatabase?.ok === true
        ? "portal_database_config is ready"
        : `portal_database_config is not ready${
            portalDatabase?.error ? ` (${portalDatabase.error})` : ""
          }`,
    checks,
  };
}

async function verifyPublicPortal(publicUrl) {
  const { response, body } = await fetchText(endpoint(publicUrl, "/"), {
    method: "GET",
  });
  const contentType = response.headers.get("content-type") ?? "";
  const hasPortalRoot = body.includes("root") || body.includes("Leaderbot");

  return {
    name: "public_portal_root",
    ok: response.ok && contentType.includes("text/html") && hasPortalRoot,
    status: response.status,
    detail: contentType,
  };
}

async function verifyPublicHealth(publicUrl) {
  const { response, body } = await fetchText(endpoint(publicUrl, "/healthz"));
  return {
    name: "public_healthz",
    ok: response.ok && body.includes("live"),
    status: response.status,
    detail: body.trim().slice(0, 120),
  };
}

function printResult(result) {
  const status = result.ok ? "ok" : "failed";
  console.log(`${status}: ${result.name}${result.status ? ` (${result.status})` : ""}`);
  if (result.detail) {
    console.log(`  ${result.detail}`);
  }
}

async function main() {
  const appUrl = normalizeBaseUrl(appBaseUrl, "LEADERBOT_IMAGE_GEN_URL");
  const publicUrl = normalizeBaseUrl(publicBaseUrl, "LEADERBOT_PUBLIC_URL");

  const results = [];
  results.push(await verifyFlyDatabaseSecret());
  results.push(await verifyReadiness(appUrl));
  results.push(await verifyPublicPortal(publicUrl));
  results.push(await verifyPublicHealth(publicUrl));

  for (const result of results) {
    printResult(result);
  }

  const failed = results.filter(result => !result.ok);
  if (failed.length > 0) {
    console.error(
      `Portal production verification failed: ${failed
        .map(result => result.name)
        .join(", ")}`
    );
    process.exit(1);
  }

  console.log("Portal production verification passed.");
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
