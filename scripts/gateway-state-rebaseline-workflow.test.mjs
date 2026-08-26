import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflowPath = path.join(
  process.cwd(),
  ".github",
  "workflows",
  "gateway-state-rebaseline.yml",
);
const workflow = fs.readFileSync(workflowPath, "utf8");

function position(marker) {
  const index = workflow.indexOf(marker);
  expect(index, `missing workflow marker: ${marker}`).toBeGreaterThanOrEqual(0);
  return index;
}

describe("protected gateway state rehearsal workflow", () => {
  it("fails closed on the reviewed manifest before every Fly mutation", () => {
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("environment: production");
    expect(workflow).toContain('test "$GITHUB_REF" = "refs/heads/main"');
    expect(position("--require-approved")).toBeLessThan(
      position('flyctl volumes snapshots create "$SOURCE_VOLUME_ID"'),
    );
    expect(workflow).toContain(
      "gateway.stateRebaseline.enforcementEnabled",
    );
    expect(workflow).not.toContain("schedule:");
    expect(workflow).not.toContain("push:");
  });

  it("uploads redacted baseline and snapshot evidence before risky actions", () => {
    expect(position("Upload verified baseline evidence")).toBeLessThan(
      position('flyctl volumes snapshots create "$SOURCE_VOLUME_ID"'),
    );
    expect(position("Upload exact snapshot evidence")).toBeLessThan(
      position('flyctl volumes create "$name"'),
    );
    expect(workflow).toContain("scripts/select-fresh-fly-snapshot.mjs");
    expect(workflow).toContain("metadataOnly:true");
    expect(workflow).not.toContain("flyctl logs");
    expect(
      workflow.match(
        /flyctl config show --app "\$GATEWAY_APP" > "\$evidence_dir\/(?:post-)?generated-config\.json"/g,
      ),
    ).toHaveLength(2);
    expect(workflow).not.toContain("flyctl config show --app \"$GATEWAY_APP\" --json");
  });

  it("runs the reviewed image twice with a scrubbed production-shaped configuration", () => {
    expect(workflow).toContain(
      'io.leaderbot.gateway.state-rehearsal" }}\' "$REVIEWED_IMAGE")" = "real-openclaw-v1"',
    );
    expect(workflow).toContain("--skip-dns-registration");
    expect(workflow).toContain('--vm-cpu-kind "$REHEARSAL_VM_CPU_KIND"');
    expect(workflow).toContain('--vm-cpus "$REHEARSAL_VM_CPUS"');
    expect(workflow).toContain('--vm-memory "$REHEARSAL_VM_MEMORY_MB"');
    expect(workflow).toContain(".config.guest.cpu_kind==$cpuKind");
    expect(workflow).toContain(".config.guest.cpus==$cpus");
    expect(workflow).toContain(".config.guest.memory_mb==$memory");
    expect(workflow).toContain(
      '--env "LEADERBOT_GATEWAY_STATE_REHEARSAL=1"',
    );
    expect(workflow).toContain(
      "scrubbed production-shaped Facebook configuration",
    );
    expect(workflow.match(/--verify-running --expected-starts [12]/g)).toHaveLength(
      2,
    );
    expect(workflow.match(/--verify-running[^\n]+>\/dev\/null/g)).toHaveLength(
      2,
    );
    expect(workflow).not.toContain("fly deploy");
    expect(workflow).not.toContain("machine update");
  });

  it("binds the reviewed manifest hash to the immutable build artifact bundle", () => {
    expect(workflow).toContain(
      '--workflow "$BUILDER_WORKFLOW"',
    );
    expect(workflow).toContain(
      '--commit "$REVIEWED_SOURCE"',
    );
    expect(workflow).toContain(
      'artifact_name="production-artifact-gateway-runtime-${REVIEWED_SOURCE}-${run_id}"',
    );
    expect(workflow).toContain(
      'bundle="$candidate/gateway-runtime.json"',
    );
    expect(workflow).toContain(
      'sha256sum "$bundle"',
    );
    expect(workflow).toContain(
      '--bundle "$gateway_runtime_bundle"',
    );
    expect(workflow).toContain(
      'test "$(wc -l < "$matches" | tr -d \' \')" = "1"',
    );
    expect(workflow).not.toContain(
      'sha256sum "$attestation"',
    );
    expect(position('sha256sum "$bundle"')).toBeLessThan(
      position("flyctl auth docker"),
    );
  });

  it("records only bounded observations and removes the exact clone resources", () => {
    expect(
      position("Stop the clone and verify the live baseline remained unchanged"),
    ).toBeLessThan(
      position("Upload bounded metadata-only rehearsal observations"),
    );
    expect(workflow).toContain("startupPassed:false");
    expect(workflow).toContain("tenantIsolationPassed:false");
    expect(workflow).toContain("rollbackPassed:false");
    expect(workflow).toContain("metadataOnlyEvidence:true");
    expect(workflow).toContain("cloneVolumeMounted:true");
    expect(workflow).toContain("noPublicServiceConfigured:true");
    expect(workflow).toContain("reviewedImageRestarted:true");
    expect(workflow).toContain("liveBaselinePreserved:true");
    expect(workflow).toContain("providerCallAbsenceProven:false");
    expect(workflow).toContain("productionShapedPluginReadinessProven:false");
    expect(workflow).not.toContain("startupPassed:true");
    expect(workflow).not.toContain("tenantIsolationPassed:true");
    expect(workflow).not.toContain("rollbackPassed:true");
    expect(workflow).not.toContain("providerCalls:false");
    expect(workflow).toContain("if: always()");
    expect(workflow).toContain(
      'test -f "$evidence_dir/restore-volume-name.txt"',
    );
    expect(position('flyctl machine destroy "$machine_id"')).toBeLessThan(
      position('flyctl volumes destroy "$volume_id"'),
    );
    expect(workflow).toContain(
      ".config.metadata.leaderbot_gateway_rehearsal",
    );
    expect(workflow).toContain(
      ".config.metadata.leaderbot_gateway_rehearsal_attempt",
    );
  });
});
