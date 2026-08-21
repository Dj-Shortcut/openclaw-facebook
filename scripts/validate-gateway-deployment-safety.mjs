import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function requireMatch(text, pattern, message) {
  if (!pattern.test(text)) {
    throw new Error(message);
  }
}

export function validateFlyGatewayConfig(text) {
  requireMatch(
    text,
    /^OPENCLAW_AGENT_MODEL\s*=\s*"openai\/gpt-5\.4-mini"$/m,
    "fly.toml must keep the reviewed provider-qualified gpt-5.4-mini model"
  );
  requireMatch(
    text,
    /^NODE_OPTIONS\s*=\s*"--max-old-space-size=1536"$/m,
    "fly.toml must keep the reviewed 1536 MiB V8 heap limit"
  );
  requireMatch(
    text,
    /^memory\s*=\s*"4096"$/m,
    "fly.toml must keep the reviewed 4096 MiB VM allocation"
  );
  requireMatch(
    text,
    /^OPENCLAW_PUBLIC_GATEWAY_GUARD\s*=\s*"1"$/m,
    "fly.toml must keep the public route guard enabled"
  );
  requireMatch(
    text,
    /^OPENCLAW_PUBLIC_GATEWAY_PATHS\s*=\s*"\/facebook\/webhook,\/healthz"$/m,
    "fly.toml must keep the public gateway path allowlist"
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
    "OpenClaw update PRs must link the managed redeploy handoff"
  );
  requireMatch(
    text,
    /approval_status:\s*pending/,
    "OpenClaw update PRs must start with pending production approval"
  );
  requireMatch(
    text,
    /gh pr create[\s\S]*?--draft/,
    "Automated OpenClaw update PRs must be created as drafts"
  );
  const redraftIndex = text.indexOf('gh pr ready "$branch" --undo');
  const forcePushIndex = text.indexOf(
    'git push --force-with-lease origin "$branch"'
  );
  if (redraftIndex < 0) {
    throw new Error(
      "Existing automated OpenClaw update PRs must be returned to draft"
    );
  }
  if (forcePushIndex < 0 || redraftIndex > forcePushIndex) {
    throw new Error(
      "Existing update PRs must be returned to draft before force-pushing"
    );
  }
  if (/\bfly\s+deploy\b/.test(text)) {
    throw new Error("The dependency update workflow must never deploy to Fly");
  }
  if (/^\s*id-token:\s*write\s*$/m.test(text)) {
    throw new Error("The dependency update workflow must not request deploy identity tokens");
  }
}

export function validatePluginWorkflow(text) {
  requireMatch(
    text,
    /^\s*-\s*["']?fly\.toml["']?\s*$/m,
    "The plugin validation workflow must run for fly.toml pull-request changes"
  );
}

export function validateGatewayDeploymentSafety(rootDir = process.cwd()) {
  const flyConfig = fs.readFileSync(path.join(rootDir, "fly.toml"), "utf8");
  const updateWorkflow = fs.readFileSync(
    path.join(rootDir, ".github/workflows/update-openclaw.yml"),
    "utf8"
  );
  const pluginWorkflow = fs.readFileSync(
    path.join(rootDir, ".github/workflows/main.yml"),
    "utf8"
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
    `Gateway deployment safety validated (${result.agentModel}, ${result.heapLimitMiB}/${result.vmMemoryMiB} MiB heap/VM).\n`
  );
}
