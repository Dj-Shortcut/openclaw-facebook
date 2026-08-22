import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const NEEDLE = [
  "      for (const key of keys) {",
  "        if (!key.startsWith(`${prefix}:{mgc:`)) unsafe.push(key);",
  "        if (unsafe.length >= limit) return unsafe;",
  "      }",
].join("\n");

const REPLACEMENT = [
  "      for (const key of keys) {",
  "        if (",
  "          prefix === GENERATION_COMPLETION_SCOPE &&",
  "          key.startsWith(`${GENERATION_COMPLETION_USER_INDEX_SCOPE}:`)",
  "        ) {",
  "          continue;",
  "        }",
  "        if (!key.startsWith(`${prefix}:{mgc:`)) unsafe.push(key);",
  "        if (unsafe.length >= limit) return unsafe;",
  "      }",
].join("\n");

export function patchCompletionReadinessBundle(source) {
  const occurrences = source.split(NEEDLE).length - 1;
  if (occurrences !== 1) {
    throw new Error(
      `Expected exactly one vulnerable completion readiness scan, found ${occurrences}`,
    );
  }
  return source.replace(NEEDLE, REPLACEMENT);
}

function patchFile(filePath) {
  const source = fs.readFileSync(filePath, "utf8");
  const patched = patchCompletionReadinessBundle(source);
  fs.writeFileSync(filePath, patched);
  process.stdout.write("Patched canonical completion user-index readiness scan.\n");
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const filePath = process.argv[2];
  if (!filePath) {
    throw new Error("Usage: patch-production-completion-readiness.mjs <bundle>");
  }
  patchFile(filePath);
}
