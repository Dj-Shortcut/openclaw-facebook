import { createHash } from "node:crypto";

const REPOSITORY = "Dj-Shortcut/openclaw-facebook";
const WORKFLOW = ".github/workflows/enable-image-gen-test-payments.yml";
const REASON = "protected workflow test payment preparation";
const LANES = ["ai_finalization", "outbox", "profile_expiry", "reconciliation"];
const sha = (value, length = 64) =>
  typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const id = (value) =>
  Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const positive = (value) =>
  typeof value === "string" && /^[1-9][0-9]{0,19}$/.test(value);
const image = (value) =>
  typeof value === "string" &&
  /^registry\.fly\.io\/leaderbot-fb-image-gen@sha256:[a-f0-9]{64}$/.test(value);
const reject = () => {
  throw new Error("credit_test_activation_audit_rejected");
};

// One consistent statement snapshot, bounded rows and explicit metadata fields.
// Existing provisioner SELECT on leaderbot.* suffices; no locks or writes.
export const TEST_PAYMENT_ACTIVATION_AUDIT_SQL = `SELECT CAST(JSON_OBJECT(
  'controls', (SELECT JSON_ARRAYAGG(JSON_OBJECT(
    'workspaceId', c.workspace_id, 'mode', c.mode,
    'enabled', c.commercial_enabled, 'epoch', c.authorization_epoch
  )) FROM (SELECT workspace_id, mode, commercial_enabled, authorization_epoch
    FROM billing_execution_controls WHERE workspace_id=1 AND mode='test' LIMIT 2) c),
  'lanes', (SELECT JSON_ARRAYAGG(JSON_OBJECT(
    'workspaceId', s.workspace_id, 'mode', s.mode, 'kind', s.kind,
    'enabled', s.enabled, 'epoch', s.execution_epoch,
    'requestId', s.operator_request_id, 'fingerprint', s.operator_request_fingerprint,
    'ownerUserId', s.enabled_by_user_id
  )) FROM (SELECT workspace_id, mode, kind, enabled, execution_epoch,
      operator_request_id, operator_request_fingerprint, enabled_by_user_id
    FROM billing_scheduler_tenants WHERE workspace_id=1 AND mode='test' LIMIT 5) s),
  'audits', (SELECT JSON_ARRAYAGG(JSON_OBJECT(
    'id', a.id, 'workspaceId', a.workspaceId, 'ownerUserId', a.userId, 'event', a.event,
    'metadataFieldCount', JSON_LENGTH(a.metadata),
    'operatorFieldCount', JSON_LENGTH(JSON_EXTRACT(a.metadata, '$.operator')),
    'mode', JSON_EXTRACT(a.metadata, '$.mode'),
    'requestId', JSON_EXTRACT(a.metadata, '$.requestId'),
    'previousEpoch', JSON_EXTRACT(a.metadata, '$.previousExecutionEpoch'),
    'epoch', JSON_EXTRACT(a.metadata, '$.resultingExecutionEpoch'),
    'reason', JSON_EXTRACT(a.metadata, '$.reason'),
    'onBehalfOfOwnerUserId', JSON_EXTRACT(a.metadata, '$.onBehalfOfOwnerUserId'),
    'operator', JSON_OBJECT(
      'source', JSON_EXTRACT(a.metadata, '$.operator.source'),
      'githubActorId', JSON_EXTRACT(a.metadata, '$.operator.githubActorId'),
      'githubRunId', JSON_EXTRACT(a.metadata, '$.operator.githubRunId'),
      'githubRunAttempt', JSON_EXTRACT(a.metadata, '$.operator.githubRunAttempt'),
      'sourceSha', JSON_EXTRACT(a.metadata, '$.operator.sourceSha'),
      'deploymentIdentity', JSON_EXTRACT(a.metadata, '$.operator.deploymentIdentity'),
      'runtimePrincipalSha256', JSON_EXTRACT(a.metadata, '$.operator.runtimePrincipalSha256'),
      'operatorImage', JSON_EXTRACT(a.metadata, '$.operator.operatorImage'),
      'artifactSourceSha', JSON_EXTRACT(a.metadata, '$.operator.artifactSourceSha'),
      'bundleSha256', JSON_EXTRACT(a.metadata, '$.operator.bundleSha256'),
      'runtimeImage', JSON_EXTRACT(a.metadata, '$.operator.runtimeImage')
    )
  )) FROM (SELECT id, workspaceId, userId, event, metadata FROM auditLog
    WHERE workspaceId=1 AND event='billing_scheduler_enabled'
      AND JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.requestId')) IN (
        SELECT operator_request_id FROM billing_scheduler_tenants
        WHERE workspace_id=1 AND mode='test')
    LIMIT 2) a)
) AS CHAR) AS activation_audit`;

export function buildTestPaymentActivationAuditQuery(workspaceId) {
  if (!id(workspaceId)) reject();
  return TEST_PAYMENT_ACTIVATION_AUDIT_SQL.replace(
    /workspace_id=1\b|workspaceId=1\b/g,
    (value) => value.replace(/1$/, String(workspaceId)),
  );
}

export function validateCommittedTestPaymentActivation(
  snapshot,
  { app, workspaceId },
) {
  if (!id(workspaceId)) reject();
  // This reviewed activation anchor is immutable after enable. Desired builds
  // and the independently inspected current runtime may advance later.
  const anchor = app.creditTestActivation?.operator;
  if (
    !anchor ||
    typeof anchor !== "object" ||
    Array.isArray(anchor) ||
    Object.keys(anchor).sort().join(",") !==
      "artifactSourceSha,deploymentIdentity,epoch,operatorImage,previousEpoch,requestId,runtimeImage" ||
    typeof anchor.requestId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      anchor.requestId,
    ) ||
    anchor.previousEpoch !== 1 ||
    anchor.epoch !== 2
  )
    reject();
  const controls = snapshot?.controls;
  const lanes = snapshot?.lanes;
  const audits = snapshot?.audits;
  if (
    !Array.isArray(controls) ||
    controls.length !== 1 ||
    !Array.isArray(lanes) ||
    lanes.length !== 4 ||
    !Array.isArray(audits) ||
    audits.length !== 1
  )
    reject();
  const control = controls[0];
  const audit = audits[0];
  const provenance = audit?.operator;
  if (
    !control ||
    !audit ||
    !provenance ||
    control.workspaceId !== workspaceId ||
    control.mode !== "test" ||
    control.enabled !== 1 ||
    !id(control.epoch) ||
    !id(audit.id) ||
    audit.workspaceId !== workspaceId ||
    audit.mode !== "test" ||
    audit.event !== "billing_scheduler_enabled" ||
    !id(audit.ownerUserId) ||
    audit.metadataFieldCount !== 7 ||
    audit.operatorFieldCount !== 11 ||
    audit.onBehalfOfOwnerUserId !== audit.ownerUserId ||
    audit.requestId !== anchor.requestId ||
    audit.previousEpoch !== anchor.previousEpoch ||
    audit.epoch !== anchor.epoch ||
    audit.epoch !== audit.previousEpoch + 1 ||
    audit.epoch !== control.epoch ||
    audit.reason !== REASON ||
    typeof audit.requestId !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
      audit.requestId,
    ) ||
    provenance.source !== "protected_workflow" ||
    !positive(provenance.githubActorId) ||
    !positive(provenance.githubRunId) ||
    !id(provenance.githubRunAttempt) ||
    !sha(provenance.sourceSha, 40) ||
    !image(provenance.operatorImage) ||
    provenance.operatorImage !== anchor.operatorImage ||
    !sha(provenance.artifactSourceSha, 40) ||
    provenance.artifactSourceSha !== anchor.artifactSourceSha ||
    !sha(provenance.bundleSha256) ||
    !image(provenance.runtimeImage) ||
    provenance.runtimeImage !== anchor.runtimeImage ||
    provenance.deploymentIdentity !== anchor.deploymentIdentity ||
    !/^deploy-[1-9][0-9]*-[1-9][0-9]*$/.test(
      provenance.deploymentIdentity ?? "",
    ) ||
    !sha(provenance.runtimePrincipalSha256) ||
    provenance.runtimePrincipalSha256 !==
      app.databaseSchemaTransition?.runtimePrincipalSha256 ||
    lanes
      .map((row) => row?.kind)
      .sort()
      .join(",") !== LANES.join(",")
  )
    reject();
  // Preserve exactly the mutation's original field order and fingerprint.
  // A different deployment/run must never turn into a new enable replay.
  const operator = {
    source: provenance.source,
    githubActorId: provenance.githubActorId,
    githubRunId: provenance.githubRunId,
    githubRunAttempt: provenance.githubRunAttempt,
    sourceSha: provenance.sourceSha,
    deploymentIdentity: provenance.deploymentIdentity,
    runtimePrincipalSha256: provenance.runtimePrincipalSha256,
    operatorImage: provenance.operatorImage,
    artifactSourceSha: provenance.artifactSourceSha,
    bundleSha256: provenance.bundleSha256,
    runtimeImage: provenance.runtimeImage,
  };
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        "billing-scheduler-enable-v1",
        workspaceId,
        "test",
        audit.ownerUserId,
        audit.previousEpoch,
        REASON,
        operator,
      ]),
    )
    .digest("hex");
  if (
    lanes.some(
      (row) =>
        row.workspaceId !== workspaceId ||
        row.mode !== "test" ||
        row.enabled !== 1 ||
        row.epoch !== control.epoch ||
        row.requestId !== audit.requestId ||
        row.fingerprint !== fingerprint ||
        row.ownerUserId !== audit.ownerUserId,
    )
  )
    reject();
  return {
    verified: true,
    committed: true,
    readOnly: true,
    workspaceId,
    mode: "test",
    executionEpoch: control.epoch,
    previousExecutionEpoch: audit.previousEpoch,
    requestId: audit.requestId,
    fingerprint,
    ownerUserId: audit.ownerUserId,
    auditId: audit.id,
    operator,
  };
}

// Also serves recovery after a lost operator response/artifact: validate the
// original committed audit, never re-run enable under new GitHub provenance.
export async function inspectCommittedTestPaymentActivation(
  session,
  { app, workspaceId, signal, githubToken, fetchImpl = fetch },
) {
  try {
    if (signal?.aborted || !githubToken) reject();
    const query = buildTestPaymentActivationAuditQuery(workspaceId);
    const readSnapshot = async () => {
      const rows = await session.execute(query, { signal });
      if (
        rows.length !== 1 ||
        typeof rows[0] !== "string" ||
        rows[0].length > 32768
      )
        reject();
      return validateCommittedTestPaymentActivation(JSON.parse(rows[0]), {
        app,
        workspaceId,
      });
    };
    const proof = await readSnapshot();
    const original = proof.operator;
    const response = await fetchImpl(
      `https://api.github.com/repos/${REPOSITORY}/actions/runs/${original.githubRunId}/attempts/${original.githubRunAttempt}`,
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: "application/vnd.github+json",
        },
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
          : AbortSignal.timeout(15000),
        redirect: "error",
      },
    );
    if (!response.ok) reject();
    const run = await response.json();
    if (
      String(run.id) !== original.githubRunId ||
      run.run_attempt !== original.githubRunAttempt ||
      run.head_sha !== original.sourceSha ||
      run.head_branch !== "main" ||
      run.head_repository?.full_name !== REPOSITORY ||
      run.event !== "workflow_dispatch" ||
      run.path !== WORKFLOW ||
      run.status !== "completed" ||
      !["success", "failure", "cancelled", "timed_out"].includes(
        run.conclusion,
      ) ||
      String(run.actor?.id) !== original.githubActorId ||
      String(run.triggering_actor?.id) !== original.githubActorId ||
      signal?.aborted
    )
      reject();
    // Recheck after the remote metadata lookup, so a disable/change during
    // verification cannot be retained as an enabled proof.
    if (JSON.stringify(await readSnapshot()) !== JSON.stringify(proof))
      reject();
    return proof;
  } catch {
    reject();
  }
}
