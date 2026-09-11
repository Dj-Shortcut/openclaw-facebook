import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  buildTestPaymentActivationAuditQuery,
  inspectCommittedTestPaymentActivation,
  validateCommittedTestPaymentActivation,
} from "./image-gen-test-payment-activation-audit.mjs";

function fixture() {
  const operator = {
    source: "protected_workflow",
    githubActorId: "11",
    githubRunId: "120",
    githubRunAttempt: 1,
    sourceSha: "a".repeat(40),
    deploymentIdentity: "deploy-100-1",
    runtimePrincipalSha256: "b".repeat(64),
    operatorImage: `registry.fly.io/leaderbot-fb-image-gen@sha256:${"c".repeat(64)}`,
    artifactSourceSha: "d".repeat(40),
    bundleSha256: "e".repeat(64),
    runtimeImage: `registry.fly.io/leaderbot-fb-image-gen@sha256:${"f".repeat(64)}`,
  };
  const reason = "protected workflow test payment preparation";
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        "billing-scheduler-enable-v1",
        1,
        "test",
        7,
        1,
        reason,
        operator,
      ]),
    )
    .digest("hex");
  const requestId = "12345678-1234-4234-8234-123456789012";
  const snapshot = {
    controls: [{ workspaceId: 1, mode: "test", enabled: 1, epoch: 2 }],
    lanes: [
      "outbox",
      "reconciliation",
      "profile_expiry",
      "ai_finalization",
    ].map((kind) => ({
      workspaceId: 1,
      mode: "test",
      kind,
      enabled: 1,
      epoch: 2,
      requestId,
      fingerprint,
      ownerUserId: 7,
    })),
    audits: [
      {
        id: 9,
        workspaceId: 1,
        ownerUserId: 7,
        event: "billing_scheduler_enabled",
        metadataFieldCount: 7,
        operatorFieldCount: 11,
        mode: "test",
        requestId,
        previousEpoch: 1,
        epoch: 2,
        reason,
        onBehalfOfOwnerUserId: 7,
        operator,
      },
    ],
  };
  const remoteRun = {
    id: 120,
    run_attempt: 1,
    head_sha: operator.sourceSha,
    head_branch: "main",
    head_repository: { full_name: "Dj-Shortcut/openclaw-facebook" },
    event: "workflow_dispatch",
    path: ".github/workflows/enable-image-gen-test-payments.yml",
    status: "completed",
    conclusion: "success",
    actor: { id: 11 },
    triggering_actor: { id: 11 },
  };
  const session = { execute: vi.fn(async () => [JSON.stringify(snapshot)]) };
  const input = {
    workspaceId: 1,
    app: {
      reviewedImage: operator.operatorImage,
      reviewedSourceCommit: operator.artifactSourceSha,
      creditTestActivation: {
        operator: {
          requestId,
          previousEpoch: 1,
          epoch: 2,
          operatorImage: operator.operatorImage,
          artifactSourceSha: operator.artifactSourceSha,
          runtimeImage: operator.runtimeImage,
          deploymentIdentity: operator.deploymentIdentity,
        },
      },
      databaseSchemaTransition: {
        runtimePrincipalSha256: operator.runtimePrincipalSha256,
      },
    },
    baseline: {
      identity: operator.deploymentIdentity,
      expectedImage: operator.runtimeImage,
    },
    githubToken: "test-only",
    fetchImpl: vi.fn(async () => ({ ok: true, json: async () => remoteRun })),
  };
  return { snapshot, operator, remoteRun, session, input };
}

describe("read-only committed Test payment activation proof", () => {
  it("reads a bounded metadata-only snapshot with existing SELECT privileges", () => {
    const query = buildTestPaymentActivationAuditQuery(42);
    expect(query).toMatch(/^SELECT CAST\(JSON_OBJECT\(/);
    expect(query).toContain("AS CHAR) AS activation_audit");
    expect(query).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|CALL|GRANT|FOR UPDATE|PSID|payload)\b/i,
    );
    expect(query.match(/workspace_id=42 AND mode='test'/g)).toHaveLength(3);
    expect(query).toContain(
      "WHERE workspaceId=42 AND event='billing_scheduler_enabled'",
    );
    expect(query).toContain("LIMIT 5");
    expect(query.match(/LIMIT 2/g)).toHaveLength(2);
  });
  it.each([undefined, 0, -1, 1.2, "1", "1 OR 1=1", 2147483648])(
    "rejects unvalidated query scope %s",
    (value) => {
      expect(() => buildTestPaymentActivationAuditQuery(value)).toThrow();
    },
  );
  it("proves enabled control, four lanes and the exact original mutation fingerprint", async () => {
    const f = fixture();
    const proof = await inspectCommittedTestPaymentActivation(
      f.session,
      f.input,
    );
    expect(proof).toEqual({
      verified: true,
      committed: true,
      readOnly: true,
      workspaceId: 1,
      mode: "test",
      executionEpoch: 2,
      previousExecutionEpoch: 1,
      requestId: f.snapshot.audits[0].requestId,
      fingerprint: f.snapshot.lanes[0].fingerprint,
      ownerUserId: 7,
      auditId: 9,
      operator: f.operator,
    });
    expect(f.session.execute).toHaveBeenCalledTimes(2);
    expect(f.input.fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/repos/Dj-Shortcut/openclaw-facebook/actions/runs/120/attempts/1",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(JSON.stringify(proof)).not.toContain("test-only");
  });
  it("retains the original activation after desired and running frontend builds advance", async () => {
    const f = fixture();
    const original = await inspectCommittedTestPaymentActivation(
      f.session,
      f.input,
    );
    f.input.app.reviewedImage = `registry.fly.io/leaderbot-fb-image-gen@sha256:${"1".repeat(64)}`;
    f.input.app.reviewedSourceCommit = "2".repeat(40);
    f.input.baseline = {
      identity: "deploy-200-1",
      expectedImage: `registry.fly.io/leaderbot-fb-image-gen@sha256:${"3".repeat(64)}`,
    };
    await expect(
      inspectCommittedTestPaymentActivation(f.session, f.input),
    ).resolves.toEqual(original);
    expect(original.operator).toEqual(f.operator);
    expect(
      f.session.execute.mock.calls.every(([sql]) => sql.startsWith("SELECT ")),
    ).toBe(true);
  });
  it.each([
    ["requestId", "8a62f93d-e092-4dd8-82ca-9e77bdd89d54"],
    ["previousEpoch", 3],
    ["epoch", 4],
    [
      "operatorImage",
      `registry.fly.io/leaderbot-fb-image-gen@sha256:${"1".repeat(64)}`,
    ],
    ["artifactSourceSha", "2".repeat(40)],
    [
      "runtimeImage",
      `registry.fly.io/leaderbot-fb-image-gen@sha256:${"3".repeat(64)}`,
    ],
    ["deploymentIdentity", "deploy-200-1"],
  ])("rejects changing the original reviewed %s anchor", (field, value) => {
    const f = fixture();
    f.input.app.creditTestActivation.operator[field] = value;
    expect(() =>
      validateCommittedTestPaymentActivation(f.snapshot, f.input),
    ).toThrow();
  });
  it.each([
    ["another initial request", 1, "22222222-2222-4222-8222-222222222222"],
    ["same request after disable", 3, "12345678-1234-4234-8234-123456789012"],
    [
      "another request after disable",
      3,
      "22222222-2222-4222-8222-222222222222",
    ],
  ])(
    "rejects a fully consistent replacement: %s",
    (_label, previousEpoch, requestId) => {
      const f = fixture();
      const audit = f.snapshot.audits[0];
      audit.requestId = requestId;
      audit.previousEpoch = previousEpoch;
      audit.epoch = previousEpoch + 1;
      f.operator.githubRunId = "121";
      f.remoteRun.id = 121;
      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify([
            "billing-scheduler-enable-v1",
            1,
            "test",
            audit.ownerUserId,
            previousEpoch,
            audit.reason,
            f.operator,
          ]),
        )
        .digest("hex");
      f.snapshot.controls[0].epoch = audit.epoch;
      for (const lane of f.snapshot.lanes)
        Object.assign(lane, {
          requestId,
          epoch: audit.epoch,
          fingerprint,
        });
      expect(() =>
        validateCommittedTestPaymentActivation(f.snapshot, f.input),
      ).toThrow("credit_test_activation_audit_rejected");
    },
  );
  it.each([undefined, null, [], {}])(
    "rejects missing or incomplete original anchor %j",
    (anchor) => {
      const f = fixture();
      f.input.app.creditTestActivation.operator = anchor;
      expect(() =>
        validateCommittedTestPaymentActivation(f.snapshot, f.input),
      ).toThrow();
    },
  );
  it.each([
    [
      "no controls",
      (f) => {
        f.snapshot.controls = null;
      },
    ],
    [
      "duplicate controls",
      (f) => {
        f.snapshot.controls.push(f.snapshot.controls[0]);
      },
    ],
    [
      "disabled control",
      (f) => {
        f.snapshot.controls[0].enabled = 0;
      },
    ],
    [
      "string flag",
      (f) => {
        f.snapshot.controls[0].enabled = "1";
      },
    ],
    [
      "wrong control scope",
      (f) => {
        f.snapshot.controls[0].workspaceId = 2;
      },
    ],
    [
      "live control",
      (f) => {
        f.snapshot.controls[0].mode = "live";
      },
    ],
    [
      "control epoch",
      (f) => {
        f.snapshot.controls[0].epoch = 3;
      },
    ],
    [
      "missing lane",
      (f) => {
        f.snapshot.lanes.pop();
      },
    ],
    [
      "duplicate kind",
      (f) => {
        f.snapshot.lanes[0].kind = "reconciliation";
      },
    ],
    [
      "disabled lane",
      (f) => {
        f.snapshot.lanes[0].enabled = 0;
      },
    ],
    [
      "lane epoch",
      (f) => {
        f.snapshot.lanes[0].epoch = 3;
      },
    ],
    [
      "lane request",
      (f) => {
        f.snapshot.lanes[0].requestId = "another";
      },
    ],
    [
      "lane fingerprint",
      (f) => {
        f.snapshot.lanes[0].fingerprint = "a".repeat(64);
      },
    ],
    [
      "lane owner",
      (f) => {
        f.snapshot.lanes[0].ownerUserId = 8;
      },
    ],
    [
      "lane scope",
      (f) => {
        f.snapshot.lanes[0].workspaceId = 2;
      },
    ],
    [
      "lane mode",
      (f) => {
        f.snapshot.lanes[0].mode = "live";
      },
    ],
    [
      "missing audit",
      (f) => {
        f.snapshot.audits = null;
      },
    ],
    [
      "duplicate audit",
      (f) => {
        f.snapshot.audits.push(f.snapshot.audits[0]);
      },
    ],
    [
      "browser audit",
      (f) => {
        f.snapshot.audits[0].operator = null;
      },
    ],
    [
      "unknown metadata",
      (f) => {
        f.snapshot.audits[0].metadataFieldCount = 8;
      },
    ],
    [
      "unknown provenance",
      (f) => {
        f.snapshot.audits[0].operatorFieldCount = 12;
      },
    ],
    [
      "audit scope",
      (f) => {
        f.snapshot.audits[0].workspaceId = 2;
      },
    ],
    [
      "audit mode",
      (f) => {
        f.snapshot.audits[0].mode = "live";
      },
    ],
    [
      "audit owner",
      (f) => {
        f.snapshot.audits[0].onBehalfOfOwnerUserId = 8;
      },
    ],
    [
      "audit reason",
      (f) => {
        f.snapshot.audits[0].reason = "other";
      },
    ],
    [
      "audit previous epoch",
      (f) => {
        f.snapshot.audits[0].previousEpoch = 2;
      },
    ],
    [
      "new run provenance",
      (f) => {
        f.operator.githubRunId = "121";
      },
    ],
    [
      "new attempt provenance",
      (f) => {
        f.operator.githubRunAttempt = 2;
      },
    ],
    [
      "new source provenance",
      (f) => {
        f.operator.sourceSha = "1".repeat(40);
      },
    ],
    [
      "wrong bundle",
      (f) => {
        f.operator.bundleSha256 = "1".repeat(64);
      },
    ],
    [
      "malformed bundle",
      (f) => {
        f.operator.bundleSha256 = "not-a-hash";
      },
    ],
    [
      "wrong operator image",
      (f) => {
        f.operator.operatorImage = f.operator.runtimeImage;
      },
    ],
    [
      "wrong artifact source",
      (f) => {
        f.operator.artifactSourceSha = "1".repeat(40);
      },
    ],
    [
      "wrong runtime image",
      (f) => {
        f.operator.runtimeImage = f.operator.operatorImage;
      },
    ],
    [
      "wrong deployment",
      (f) => {
        f.operator.deploymentIdentity = "deploy-101-1";
      },
    ],
    [
      "wrong principal",
      (f) => {
        f.operator.runtimePrincipalSha256 = "1".repeat(64);
      },
    ],
  ])("rejects %s before accepting execution evidence", (_, mutate) => {
    const f = fixture();
    mutate(f);
    expect(() =>
      validateCommittedTestPaymentActivation(f.snapshot, f.input),
    ).toThrow();
  });
  it.each(["failure", "cancelled", "timed_out"])(
    "recovers a committed original operator with %s conclusion without mutation",
    async (conclusion) => {
      const f = fixture();
      f.remoteRun.conclusion = conclusion;
      const proof = await inspectCommittedTestPaymentActivation(
        f.session,
        f.input,
      );
      expect(proof.operator.githubRunId).toBe("120");
      expect(proof.readOnly).toBe(true);
      expect(
        f.session.execute.mock.calls.every(([sql]) =>
          sql.startsWith("SELECT "),
        ),
      ).toBe(true);
    },
  );
  it.each([
    { id: 121 },
    { run_attempt: 2 },
    { head_sha: "f".repeat(40) },
    { head_branch: "other" },
    { head_repository: { full_name: "other/repo" } },
    { event: "pull_request" },
    { path: ".github/workflows/deploy-production.yml" },
    { status: "in_progress", conclusion: null },
    { conclusion: "skipped" },
    { actor: { id: 12 } },
    { triggering_actor: { id: 12 } },
  ])("rejects mismatched original GitHub attempt %j", async (change) => {
    const f = fixture();
    Object.assign(f.remoteRun, change);
    await expect(
      inspectCommittedTestPaymentActivation(f.session, f.input),
    ).rejects.toThrow();
  });
  it("rejects disabled state during the GitHub lookup", async () => {
    const f = fixture();
    f.input.fetchImpl.mockImplementation(async () => {
      f.snapshot.controls[0].enabled = 0;
      return { ok: true, json: async () => f.remoteRun };
    });
    await expect(
      inspectCommittedTestPaymentActivation(f.session, f.input),
    ).rejects.toThrow();
    expect(f.session.execute).toHaveBeenCalledTimes(2);
  });
  it("sanitizes database and GitHub errors without fabricating recovery", async () => {
    const f = fixture();
    f.session.execute.mockRejectedValue(
      new Error("private database credentials"),
    );
    await expect(
      inspectCommittedTestPaymentActivation(f.session, f.input),
    ).rejects.toThrow("credit_test_activation_audit_rejected");
    expect(f.input.fetchImpl).not.toHaveBeenCalled();
  });
});
