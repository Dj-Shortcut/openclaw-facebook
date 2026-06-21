import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const REQUIRED_SMOKE_CHECKS = [
  {
    id: "gateway_health",
    title: "Gateway health route returns 200",
  },
  {
    id: "image_gen_health_ready_metrics",
    title: "Image-gen health, readiness, and metrics are reachable",
  },
  {
    id: "meta_webhook_verification",
    title: "Meta webhook verification succeeds",
  },
  {
    id: "signed_post_ack",
    title: "Signed Messenger POST receives a fast 200 ACK",
  },
  {
    id: "messenger_text_reply",
    title: "Messenger text reply is delivered through Graph API",
  },
  {
    id: "prompt_first_image",
    title: "Prompt-first text-to-image request reaches image generation",
  },
  {
    id: "source_photo_edit",
    title: "Explicit source-photo edit path works without auto-restyling",
  },
  {
    id: "quota_exhaustion",
    title: "Quota-exhausted path blocks generation before provider call",
  },
  {
    id: "graph_api_failure",
    title: "Graph API send failure is observable and redacted",
  },
  {
    id: "rollback_target",
    title: "Rollback target is recorded before deploy",
  },
];

const VALID_STATUSES = new Set(["pass", "fail", "blocked"]);
const SENSITIVE_KEY_PATTERN =
  /(?:psid|token|secret|raw|payload|message|text|prompt|attachment|body)/i;
const TOKEN_VALUE_PATTERN = /(?:EAAG[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]+)/i;
const LONG_NUMERIC_ID_PATTERN = /\b\d{12,}\b/;

export function createSmokeEvidenceTemplate(now = new Date()) {
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    release: {
      commit: "",
      gatewayRelease: "",
      imageGenRelease: "",
      rollbackTarget: "",
    },
    checks: REQUIRED_SMOKE_CHECKS.map(check => ({
      id: check.id,
      title: check.title,
      status: "blocked",
      observedAt: "",
      metadataOnlyEvidence: "",
    })),
  };
}

function visitEvidence(value, visitor, path = []) {
  visitor(value, path);
  if (Array.isArray(value)) {
    value.forEach((item, index) => visitEvidence(item, visitor, [...path, String(index)]));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      visitEvidence(nested, visitor, [...path, key]);
    }
  }
}

function isAllowedSensitiveKey(path) {
  const key = path[path.length - 1] ?? "";
  return ["id", "title", "status", "observedAt", "metadataOnlyEvidence"].includes(key);
}

export function validateSmokeEvidence(evidence) {
  const errors = [];
  if (!evidence || typeof evidence !== "object") {
    return ["evidence must be a JSON object"];
  }
  if (!Array.isArray(evidence.checks)) {
    errors.push("checks must be an array");
    return errors;
  }

  const checksById = new Map();
  for (const check of evidence.checks) {
    if (!check || typeof check !== "object" || typeof check.id !== "string") {
      errors.push("each check must have a string id");
      continue;
    }
    checksById.set(check.id, check);
    if (!VALID_STATUSES.has(check.status)) {
      errors.push(`${check.id} has invalid status ${String(check.status)}`);
    }
  }

  for (const required of REQUIRED_SMOKE_CHECKS) {
    if (!checksById.has(required.id)) {
      errors.push(`missing required smoke check: ${required.id}`);
    }
  }

  visitEvidence(evidence, (value, path) => {
    const key = path[path.length - 1] ?? "";
    if (!isAllowedSensitiveKey(path) && SENSITIVE_KEY_PATTERN.test(key)) {
      errors.push(`sensitive field is not allowed in smoke evidence: ${path.join(".")}`);
    }
    if (typeof value === "string") {
      if (TOKEN_VALUE_PATTERN.test(value)) {
        errors.push(`token-like value is not allowed in smoke evidence: ${path.join(".")}`);
      }
      if (LONG_NUMERIC_ID_PATTERN.test(value)) {
        errors.push(`raw numeric identifier is not allowed in smoke evidence: ${path.join(".")}`);
      }
    }
  });

  return errors;
}

function printUsage() {
  console.error("Usage: node scripts/messenger-smoke-checklist.mjs --template | --validate <file>");
}

export function runCli(argv = process.argv.slice(2), io = { stdout: process.stdout, stderr: process.stderr }) {
  const [command, file] = argv;
  if (command === "--template") {
    io.stdout.write(`${JSON.stringify(createSmokeEvidenceTemplate(), null, 2)}\n`);
    return 0;
  }
  if (command === "--validate" && file) {
    const evidence = JSON.parse(fs.readFileSync(file, "utf8"));
    const errors = validateSmokeEvidence(evidence);
    if (errors.length) {
      io.stderr.write(`${errors.join("\n")}\n`);
      return 1;
    }
    io.stdout.write("Messenger smoke evidence is complete and metadata-only.\n");
    return 0;
  }

  printUsage();
  return 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(runCli());
}
