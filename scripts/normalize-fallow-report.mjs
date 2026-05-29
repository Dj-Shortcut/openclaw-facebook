import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const reportPaths = [];
let root = process.cwd();

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--root") {
    const rootValue = args[index + 1];
    if (!rootValue) {
      console.error("Missing value for --root");
      process.exit(1);
    }
    root = rootValue;
    index += 1;
    continue;
  }

  reportPaths.push(arg);
}

if (reportPaths.length === 0) {
  console.error(
    "Usage: node scripts/normalize-fallow-report.mjs [--root <root>] <report.json> [...report.json]",
  );
  process.exit(1);
}

const rootPath = path.resolve(root);
const rootPathPosix = rootPath.replaceAll(path.sep, "/");
const rootName = path.basename(rootPath);
const portablePrefixes = [
  "api.ts",
  "channel-plugin-api.ts",
  "configured-state.ts",
  "index.ts",
  "runtime-api.ts",
  "setup-entry.ts",
  "client/",
  "docs/",
  "examples/",
  "public/",
  "scripts/",
  "server/",
  "shared/",
  "src/",
  "storage-proxy/",
  "test/",
  "tests/",
];

function decodeJson(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString("utf16le").replace(/^\uFEFF/, "");
  }

  if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    const swapped = Buffer.alloc(buffer.length - 2);
    for (let index = 2; index + 1 < buffer.length; index += 2) {
      swapped[index - 2] = buffer[index + 1];
      swapped[index - 1] = buffer[index];
    }
    return swapped.toString("utf16le").replace(/^\uFEFF/, "");
  }

  return buffer.toString("utf8").replace(/^\uFEFF/, "");
}

function stripRootSegment(value) {
  const normalizedLower = value.toLowerCase();
  const rootSegment = `/${rootName.toLowerCase()}/`;
  const rootSegmentIndex = normalizedLower.lastIndexOf(rootSegment);
  if (rootSegmentIndex >= 0) {
    return value.slice(rootSegmentIndex + rootSegment.length);
  }

  return value;
}

function stripPortablePrefix(value) {
  for (const prefix of portablePrefixes) {
    const exactPrefix = value === prefix.replace(/\/$/, "");
    const prefixIndex = value.indexOf(`/${prefix}`);
    if (exactPrefix) {
      return value;
    }
    if (prefixIndex >= 0) {
      return value.slice(prefixIndex + 1);
    }
  }

  return value;
}

function normalizePathValue(value) {
  let normalized = value.replaceAll("\\", "/");
  normalized = normalized.replace(/^\/\/?\?\//, "");

  if (normalized.toLowerCase().startsWith(`${rootPathPosix.toLowerCase()}/`)) {
    normalized = normalized.slice(rootPathPosix.length + 1);
  }

  normalized = stripRootSegment(normalized);
  normalized = stripPortablePrefix(normalized);

  return normalized;
}

function normalizeReport(value, key = "") {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeReport(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        normalizeReport(entryValue, entryKey),
      ]),
    );
  }

  if (typeof value === "string" && ["file", "path"].includes(key)) {
    return normalizePathValue(value);
  }

  return value;
}

for (const reportPath of reportPaths) {
  const absoluteReportPath = path.resolve(reportPath);
  const report = JSON.parse(decodeJson(fs.readFileSync(absoluteReportPath)));
  fs.writeFileSync(
    absoluteReportPath,
    `${JSON.stringify(normalizeReport(report), null, 2)}\n`,
    "utf8",
  );
  console.log(`Normalized ${reportPath}`);
}
