#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const exts = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const ignoredDirs = new Set([".git", "node_modules", "dist", "build", "coverage", ".fallow"]);

const warnings = [];
const failures = [];

function rel(file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoredDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (entry.isFile() && exts.has(path.extname(entry.name))) files.push(full);
  }
  return files;
}

function lineOf(source, index) {
  return source.slice(0, index).split(/\r?\n/).length;
}

function report(kind, message, file, line) {
  const location = line ? `${file}:${line}` : file;
  (kind === "warning" ? warnings : failures).push(`${location} - ${message}`);
}

function findImports(source) {
  const matches = [];
  const patterns = [
    /(?:^|[\n;])\s*import\s+(?:type\s+)?(?:[^'";]+?\s+from\s+)?["']([^"']+)["']/g,
    /(?:^|[\n;])\s*export\s+(?:type\s+)?[^'";]+?\s+from\s+["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    /require\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(source))) matches.push({ specifier: match[1], index: match.index });
  }
  return matches;
}

function resolveImport(fromRel, specifier) {
  if (!specifier.startsWith(".")) return specifier;
  return path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier));
}

function isTestFile(file) {
  return /(^|[/.])(test|spec)\.[cm]?[jt]sx?$/.test(file) || file.includes("/__tests__/");
}

const rootSrcAllowLeaderbot = new Set([
  "src/leaderbot-bridge.ts",
  "src/leaderbot-bridge-config.ts",
  "src/leaderbot-bridge-http.ts",
  "src/config-schema.ts",
  "src/types.ts",
  "src/monitor.ts",
]);

const coreChannelImportAllowlist = new Set([
  "apps/image-gen/server/_core/adminAuth.ts",
  "apps/image-gen/server/_core/dataDeletionService.ts",
  "apps/image-gen/server/_core/faceMemory.ts",
  "apps/image-gen/server/_core/messengerActionRenderer.ts",
  "apps/image-gen/server/_core/messengerGenerationQueue.ts",
  "apps/image-gen/server/_core/messengerImageIngress.ts",
  "apps/image-gen/server/_core/internalImageRequestRoutes.ts",
  "apps/image-gen/server/_core/messengerWebhook.ts",
  "apps/image-gen/server/_core/meta/webhookIngressQueue.ts",
  "apps/image-gen/server/_core/sharedTextHandler.ts",
  "apps/image-gen/server/_core/videoGenerationFlow.ts",
  "apps/image-gen/server/_core/webhookAudioMessageRouter.ts",
  "apps/image-gen/server/_core/webhookEventContext.ts",
  "apps/image-gen/server/_core/webhookFallback.ts",
  "apps/image-gen/server/_core/webhookGenerationJobs.ts",
  "apps/image-gen/server/_core/webhookHandlerContext.ts",
  "apps/image-gen/server/_core/webhookHandlerTypes.ts",
  "apps/image-gen/server/_core/webhookImageMessageRouter.ts",
  "apps/image-gen/server/_core/webhookInternalImageRequest.ts",
  "apps/image-gen/server/_core/webhookMessageRouter.ts",
  "apps/image-gen/server/_core/webhookPayloadBranch.ts",
  "apps/image-gen/server/_core/webhookTextMessageRouter.ts",
  "apps/image-gen/server/_core/webhookTrackedContext.ts",
  "apps/image-gen/server/_core/whatsappHandlers/imageHandler.ts",
  "apps/image-gen/server/_core/whatsappResponseService.ts",
]);

const whatsappMessengerQuotaAllowlist = new Set([
  // Legacy debt before PR 6 migration is complete. New WhatsApp quota usage should go through a subject/wrapper boundary.
]);

const rawPsidKeyAllowlist = new Set([
  "apps/image-gen/server/_core/stateStore.ts",
]);

const files = [
  ...walk(path.join(root, "src")),
  ...walk(path.join(root, "apps/image-gen/server/_core")),
];

for (const abs of files) {
  const file = rel(abs);
  const source = fs.readFileSync(abs, "utf8");
  const imports = findImports(source);

  if (file.startsWith("src/")) {
    for (const item of imports) {
      const resolved = resolveImport(file, item.specifier);
      if (resolved.startsWith("apps/image-gen") || item.specifier.includes("apps/image-gen")) {
        report("failure", "root src/ must not import from apps/image-gen", file, lineOf(source, item.index));
      }
    }

    if (!rootSrcAllowLeaderbot.has(file) && !isTestFile(file)) {
      const match = /leaderbot|LEADERBOT_/i.exec(source);
      if (match) report("failure", "root src/ may mention leaderbot/LEADERBOT_ only in src/leaderbot-bridge.ts or tests", file, lineOf(source, match.index));
    } else if (file !== "src/leaderbot-bridge.ts" && !isTestFile(file) && /leaderbot|LEADERBOT_/i.test(source)) {
      report("warning", "legacy allowlist: leaderbot string outside src/leaderbot-bridge.ts; migrate toward the bridge boundary", file);
    }
  }

  if (file.startsWith("apps/image-gen/server/_core/")) {
    for (const item of imports) {
      const resolved = resolveImport(file, item.specifier);
      const importsBlockedChannelModule = /(^|\/)(messengerApi|whatsappApi|messengerActionRenderer)(\.[cm]?[jt]sx?)?$/.test(resolved);
      if (importsBlockedChannelModule) {
        if (coreChannelImportAllowlist.has(file)) {
          report("warning", "legacy allowlist: _core shared/conversation code imports channel-specific module", file, lineOf(source, item.index));
        } else {
          report("failure", "_core conversation/shared modules must not import messengerApi, whatsappApi, or messengerActionRenderer", file, lineOf(source, item.index));
        }
      }

      const importsMessengerQuota = /(^|\/)messengerQuota(\.[cm]?[jt]sx?)?$/.test(resolved);
      const isWhatsappModule = file.includes("/whatsapp") || path.posix.basename(file).startsWith("whatsapp");
      if (isWhatsappModule && importsMessengerQuota) {
        if (whatsappMessengerQuotaAllowlist.has(file)) report("warning", "legacy allowlist: WhatsApp module imports messengerQuota directly", file, lineOf(source, item.index));
        else report("failure", "WhatsApp modules must not import messengerQuota directly; use a subject/wrapper quota boundary", file, lineOf(source, item.index));
      }
    }

    const rawPsidPattern = /["'`]psid:/g;
    let match;
    while ((match = rawPsidPattern.exec(source))) {
      if (rawPsidKeyAllowlist.has(file)) report("warning", "legacy allowlist: raw psid: storage key helper; new state/quota modules should use subject/wrapper helpers", file, lineOf(source, match.index));
      else report("failure", "new state/quota modules must not add raw psid: key helpers; use subject/wrapper helpers", file, lineOf(source, match.index));
    }
  }
}

for (const warning of warnings) console.warn(`warning: ${warning}`);
for (const failure of failures) console.error(`error: ${failure}`);

if (failures.length > 0) {
  console.error(`\nProduct boundary check failed with ${failures.length} error(s) and ${warnings.length} warning(s).`);
  process.exit(1);
}

console.log(`Product boundary check passed with ${warnings.length} warning(s).`);
