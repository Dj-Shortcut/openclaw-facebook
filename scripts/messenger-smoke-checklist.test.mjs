import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  REQUIRED_SMOKE_CHECKS,
  createSmokeEvidenceTemplate,
  runCli,
  validateSmokeEvidence,
} from "./messenger-smoke-checklist.mjs";

const tempDirs = [];

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "messenger-smoke-"));
  tempDirs.push(dir);
  return dir;
}

function completeTemplate() {
  const evidence = createSmokeEvidenceTemplate(new Date("2026-06-21T00:00:00.000Z"));
  evidence.release = {
    commit: "abc1234",
    gatewayRelease: "fly-release-1",
    imageGenRelease: "fly-release-2",
    rollbackTarget: "fly-release-0",
  };
  evidence.checks = evidence.checks.map(check => ({
    ...check,
    status: "pass",
    observedAt: "2026-06-21T00:01:00.000Z",
    metadataOnlyEvidence: `${check.id} passed with redacted operational metadata`,
  }));
  return evidence;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("Messenger smoke checklist", () => {
  it("templates every immediate stabilization smoke check", () => {
    const template = createSmokeEvidenceTemplate(new Date("2026-06-21T00:00:00.000Z"));
    const ids = template.checks.map(check => check.id);

    expect(ids).toEqual(REQUIRED_SMOKE_CHECKS.map(check => check.id));
    expect(ids).toEqual(
      expect.arrayContaining([
        "meta_webhook_verification",
        "signed_post_ack",
        "messenger_text_reply",
        "prompt_first_image",
        "source_photo_edit",
        "quota_exhaustion",
        "graph_api_failure",
        "gdpr_consent_gate",
        "delete_my_data_generated_assets",
        "delete_my_data_retained_sources",
        "delete_my_data_face_memory",
        "delete_my_data_runtime_records",
        "delete_my_data_portal_scope",
        "rollback_target",
      ])
    );
  });

  it("accepts complete metadata-only evidence", () => {
    expect(validateSmokeEvidence(completeTemplate())).toEqual([]);
  });

  it("rejects missing required checks", () => {
    const evidence = completeTemplate();
    evidence.checks = evidence.checks.filter(check => check.id !== "quota_exhaustion");

    expect(validateSmokeEvidence(evidence)).toContain(
      "missing required smoke check: quota_exhaustion"
    );
  });

  it("rejects missing delete-my-data production-equivalent proof", () => {
    const evidence = completeTemplate();
    evidence.checks = evidence.checks.filter(
      check => check.id !== "delete_my_data_runtime_records"
    );

    expect(validateSmokeEvidence(evidence)).toContain(
      "missing required smoke check: delete_my_data_runtime_records"
    );
  });

  it("rejects raw identifiers, tokens, and content-like fields", () => {
    const evidence = completeTemplate();
    evidence.checks[0].rawPayload = { sender: { psid: "123456789012345" } };
    evidence.checks[1].accessToken = "EAAGdangerousTokenValue";
    evidence.checks[2].customerMessageText = "hello bot";

    const errors = validateSmokeEvidence(evidence);

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("sensitive field is not allowed"),
        expect.stringContaining("token-like value is not allowed"),
        expect.stringContaining("raw numeric identifier is not allowed"),
      ])
    );
  });

  it("validates evidence files from the CLI", () => {
    const dir = makeTempDir();
    const evidencePath = path.join(dir, "smoke.json");
    fs.writeFileSync(evidencePath, `${JSON.stringify(completeTemplate(), null, 2)}\n`);
    let stdout = "";
    let stderr = "";

    const status = runCli(["--validate", evidencePath], {
      stdout: { write: value => { stdout += value; } },
      stderr: { write: value => { stderr += value; } },
    });

    expect(status).toBe(0);
    expect(stdout).toContain("metadata-only");
    expect(stderr).toBe("");
  });
});
