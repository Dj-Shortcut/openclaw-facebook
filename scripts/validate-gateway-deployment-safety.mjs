import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function requireMatch(text, pattern, message) {
  if (!pattern.test(text)) {
    throw new Error(message);
  }
}

function getTomlTableBodies(text, tableName, arrayTable = false) {
  const bodies = [];
  let currentBody = null;

  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(
      /^\s*(\[\[|\[)\s*([^\]]+?)\s*(\]\]|\])\s*(?:#.*)?$/,
    );
    if (heading) {
      if (currentBody) {
        bodies.push(currentBody.join("\n"));
      }
      const isArrayTable = heading[1] === "[[" && heading[3] === "]]";
      const isStandardTable = heading[1] === "[" && heading[3] === "]";
      currentBody =
        heading[2] === tableName &&
        (arrayTable ? isArrayTable : isStandardTable)
          ? []
          : null;
      continue;
    }

    currentBody?.push(line);
  }

  if (currentBody) {
    bodies.push(currentBody.join("\n"));
  }

  return bodies;
}

function requireTomlTableMatch(
  text,
  tableName,
  pattern,
  message,
  arrayTable = false,
) {
  const tableBodies = getTomlTableBodies(text, tableName, arrayTable);
  const matchesReviewedValue = arrayTable
    ? tableBodies.length > 0 && tableBodies.every((body) => pattern.test(body))
    : tableBodies.some((body) => pattern.test(body));
  if (!matchesReviewedValue) {
    throw new Error(message);
  }
}

function isInactiveShellMatch(text, matchIndex) {
  const lineStart = Math.max(text.lastIndexOf("\n", matchIndex - 1) + 1, 0);
  const prefix = text.slice(lineStart, matchIndex);
  const withoutQuotedText = prefix.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, "");
  if (/(?:^|\s)#/.test(withoutQuotedText)) {
    return true;
  }

  const hasOpenSingleQuote = (prefix.match(/'/g) ?? []).length % 2 === 1;
  const hasOpenDoubleQuote = (prefix.match(/(?<!\\)"/g) ?? []).length % 2 === 1;
  return hasOpenSingleQuote || (hasOpenDoubleQuote && !prefix.includes("$("));
}

function getPullRequestCreateCommands(text) {
  const pattern =
    /\bgh\s+pr\s+create\b(?:(?!\bgh\s+pr\s+create\b)(?:\\\r?\n|[^\r\n]))*/g;
  return [...text.matchAll(pattern)]
    .filter((match) => !isInactiveShellMatch(text, match.index ?? 0))
    .map((match) => match[0]);
}

function hasDraftFlag(command) {
  const withoutQuotedText = command.replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, "");
  const [executableCommand] = withoutQuotedText.split(/(?:\s#|[;|&()<>])/);
  return /(?:^|\s)--draft(?=\s|\\|$)/.test(executableCommand);
}

function normalizeYamlScalar(value) {
  const withoutComment = value.replace(/\s+#.*$/, "").trim();
  const quote = withoutComment[0];
  if ((quote === '"' || quote === "'") && withoutComment.at(-1) === quote) {
    return withoutComment.slice(1, -1).trim();
  }
  return withoutComment;
}

function hasUnsafeIdTokenPermission(text) {
  return text.split(/\r?\n/).some((line) => {
    const code = line
      .replace(/\s+#.*$/, "")
      .replace(/\\(?:x2d|u002d|U0000002d)/gi, "-");
    if (!code.includes("id-token")) {
      return false;
    }

    const assignments = [
      ...code.matchAll(
        /(?:^|[,{])\s*(?:id-token|"id-token"|'id-token')\s*:\s*([^,}]*)/g,
      ),
    ];
    if (assignments.length === 0) {
      return true;
    }
    return assignments.some(
      (assignment) => normalizeYamlScalar(assignment[1]) !== "none",
    );
  });
}

export function validateFlyGatewayConfig(text) {
  if (/(?:'''|""")/.test(text)) {
    throw new Error(
      "fly.toml deployment safety validation does not allow multiline strings",
    );
  }
  requireTomlTableMatch(
    text,
    "env",
    /^OPENCLAW_AGENT_MODEL\s*=\s*"openai\/gpt-5\.4-mini"$/m,
    "fly.toml must keep the reviewed provider-qualified gpt-5.4-mini model",
  );
  requireTomlTableMatch(
    text,
    "env",
    /^NODE_OPTIONS\s*=\s*"--max-old-space-size=1536"$/m,
    "fly.toml must keep the reviewed 1536 MiB V8 heap limit",
  );
  requireTomlTableMatch(
    text,
    "env",
    /^OPENCLAW_PUBLIC_GATEWAY_GUARD\s*=\s*"1"$/m,
    "fly.toml must keep the public route guard enabled",
  );
  requireTomlTableMatch(
    text,
    "env",
    /^OPENCLAW_FACEBOOK_UNKNOWN_SENDER_MODE\s*=\s*"pairing"$/m,
    "fly.toml must keep unknown Facebook senders in pairing mode",
  );
  requireTomlTableMatch(
    text,
    "env",
    /^OPENCLAW_FACEBOOK_LEADERBOT_BRIDGE_ENABLED\s*=\s*"0"$/m,
    "fly.toml must keep the Leaderbot bridge disabled",
  );
  requireTomlTableMatch(
    text,
    "env",
    /^OPENCLAW_PUBLIC_GATEWAY_PATHS\s*=\s*"\/healthz"$/m,
    "fly.toml must expose only the public health route",
  );
  if (/^\s*LEADERBOT_IMAGE_GEN_URL\s*=/m.test(text)) {
    throw new Error(
      "fly.toml must not configure the retired Leaderbot bridge URL",
    );
  }
  requireTomlTableMatch(
    text,
    "vm",
    /^memory\s*=\s*"4096"$/m,
    "fly.toml must keep the reviewed 4096 MiB VM allocation",
    true,
  );

  return {
    agentModel: "openai/gpt-5.4-mini",
    heapLimitMiB: 1536,
    vmMemoryMiB: 4096,
  };
}

export function validateManagedUpdateWorkflow(text) {
  requireMatch(
    text,
    /managed-redeploy-handoff\.md/,
    "OpenClaw update PRs must link the managed redeploy handoff",
  );
  requireMatch(
    text,
    /approval_status:\s*pending/,
    "OpenClaw update PRs must start with pending production approval",
  );
  const createCommands = getPullRequestCreateCommands(text);
  if (
    createCommands.length === 0 ||
    createCommands.some((command) => !hasDraftFlag(command))
  ) {
    throw new Error("Automated OpenClaw update PRs must be created as drafts");
  }
  const redraftIndex = text.indexOf('gh pr ready "$branch" --undo');
  const forcePushIndex = text.indexOf(
    'git push --force-with-lease origin "$branch"',
  );
  if (redraftIndex < 0) {
    throw new Error(
      "Existing automated OpenClaw update PRs must be returned to draft",
    );
  }
  if (forcePushIndex < 0 || redraftIndex > forcePushIndex) {
    throw new Error(
      "Existing update PRs must be returned to draft before force-pushing",
    );
  }
  if (/\bfly\s+deploy\b/.test(text)) {
    throw new Error("The dependency update workflow must never deploy to Fly");
  }
  if (hasUnsafeIdTokenPermission(text)) {
    throw new Error(
      "The dependency update workflow must not request deploy identity tokens",
    );
  }
}

export function validatePluginWorkflow(text) {
  const lines = text.split(/\r?\n/);
  const triggerIndex = lines.findIndex((line) =>
    /^  pull_request:\s*(?:\{\})?\s*$/.test(line),
  );
  if (triggerIndex >= 0) {
    let isPathFiltered = false;
    for (const line of lines.slice(triggerIndex + 1)) {
      if (/^\S/.test(line) || /^  \S/.test(line)) break;
      if (/^    paths(?:-ignore)?:\s*$/.test(line)) {
        isPathFiltered = true;
        break;
      }
    }
    if (!isPathFiltered) return;
  }
  requireMatch(
    text,
    /^\s*-\s*["']?fly\.toml["']?\s*$/m,
    "The plugin validation workflow must run for fly.toml pull-request changes",
  );
}

export function validateGatewayDeploymentSafety(rootDir = process.cwd()) {
  const flyConfig = fs.readFileSync(path.join(rootDir, "fly.toml"), "utf8");
  const updateWorkflow = fs.readFileSync(
    path.join(rootDir, ".github/workflows/update-openclaw.yml"),
    "utf8",
  );
  const pluginWorkflow = fs.readFileSync(
    path.join(rootDir, ".github/workflows/main.yml"),
    "utf8",
  );
  const result = validateFlyGatewayConfig(flyConfig);
  validateManagedUpdateWorkflow(updateWorkflow);
  validatePluginWorkflow(pluginWorkflow);
  return result;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  const result = validateGatewayDeploymentSafety();
  process.stdout.write(
    `Gateway deployment safety validated (${result.agentModel}, ${result.heapLimitMiB}/${result.vmMemoryMiB} MiB heap/VM).\n`,
  );
}
