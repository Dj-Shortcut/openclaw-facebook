import fs from "node:fs";
import { pathToFileURL } from "node:url";

function requireSnapshotArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be a JSON array`);
  }
  return value;
}

function requireSnapshotId(value, label) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{16,80}$/.test(value)) {
    throw new Error(`${label} has an invalid snapshot id`);
  }
  return value;
}

function parseTimestamp(value, label) {
  if (typeof value !== "string") {
    throw new Error(`${label} has an invalid timestamp`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} has an invalid timestamp`);
  }
  return timestamp;
}

export function selectFreshFlySnapshot(
  beforeSnapshots,
  currentSnapshots,
  startedAt,
) {
  const before = requireSnapshotArray(beforeSnapshots, "snapshot baseline");
  const current = requireSnapshotArray(currentSnapshots, "snapshot list");
  const startedAtMs = parseTimestamp(startedAt, "snapshot start");
  const beforeIds = new Set(
    before.map((snapshot, index) =>
      requireSnapshotId(snapshot?.id, `snapshot baseline row ${index}`),
    ),
  );
  if (beforeIds.size !== before.length) {
    throw new Error("snapshot baseline contains duplicate ids");
  }

  const candidates = current.filter((snapshot, index) => {
    const id = requireSnapshotId(snapshot?.id, `snapshot list row ${index}`);
    const createdAtMs = parseTimestamp(
      snapshot?.created_at,
      `snapshot list row ${index}`,
    );
    return !beforeIds.has(id) && createdAtMs >= startedAtMs;
  });
  if (candidates.length > 1) {
    throw new Error("more than one fresh snapshot appeared after scheduling");
  }
  if (candidates.length === 0) {
    return { state: "waiting" };
  }

  const snapshot = candidates[0];
  if (snapshot.status !== "created") {
    return { state: "waiting" };
  }
  if (typeof snapshot.digest !== "string" || snapshot.digest.length === 0) {
    throw new Error("fresh snapshot is missing its digest");
  }
  return {
    state: "ready",
    snapshot: {
      id: snapshot.id,
      digest: snapshot.digest,
      createdAt: snapshot.created_at,
    },
  };
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function runCli(argv) {
  if (argv.length !== 3) {
    throw new Error(
      "usage: select-fresh-fly-snapshot.mjs <before.json> <current.json> <started-at>",
    );
  }
  const [beforePath, currentPath, startedAt] = argv;
  const selection = selectFreshFlySnapshot(
    readJson(beforePath),
    readJson(currentPath),
    startedAt,
  );
  process.stdout.write(`${JSON.stringify(selection)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "snapshot selection failed"}\n`,
    );
    process.exitCode = 1;
  }
}
