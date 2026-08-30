import {
  assertCreditProvisionerGrantScope,
  creditWalletMigrationTablePrivileges,
  productionRuntimeWritableTableNames,
} from "../apps/image-gen/scripts/production-schema-contract.mjs";

export const CREDIT_PROVISIONER_ACCOUNT_PATTERN = /^lbcp_[a-f0-9]{16}$/;
export const CREDIT_PROVISIONER_LOCK_NAME =
  "leaderbot_credit_provisioner_bootstrap_v1";
export const CREDIT_PROVISIONER_SECRET_NAME =
  "IMAGE_GEN_DATABASE_PROVISIONER_URL";
export const CREDIT_PROVISIONER_SUCCESS_MARKER = "credit_provisioner_ready";
export const CREDIT_PROVISIONER_FAILURE_MARKER =
  "credit_provisioner_bootstrap_failed";
export const CREDIT_PROVISIONER_CLEANUP_FAILURE_MARKER =
  "credit_provisioner_bootstrap_cleanup_incomplete";

const EXPECTED_SCHEMA_PHASES = Object.freeze([
  "0016_expand",
  "0017_credit_wallet_expand",
  "0018_credit_checkout_reservation",
]);
const MAX_SNAPSHOT_AGE_MS = 60 * 60 * 1000;

function fail(message) {
  throw new Error(message);
}

export function quoteMysqlIdentifier(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_]+$/.test(value)) {
    fail("unsafe database identifier");
  }
  return `\`${value}\``;
}

export function assertBootstrapManifest(manifest) {
  const app = manifest?.apps?.["image-gen"];
  const transition = app?.databaseSchemaTransition;
  const recovery = app?.databaseRecovery;
  if (
    app?.deploymentEnabled !== false ||
    app?.sourceDeployEnabled !== false ||
    app?.reviewedArtifactKind !== "migration-bridge" ||
    app?.databaseSchemaPhase !== "0016_expand" ||
    transition?.state !== "expand_pending" ||
    transition?.from !== "0016_expand" ||
    transition?.to !== "0018_credit_checkout_reservation" ||
    app?.reviewedImage !== transition?.bridgeImage ||
    !Array.isArray(app?.reviewedRollbackImages) ||
    app.reviewedRollbackImages.length !== 1 ||
    app.reviewedRollbackImages[0] !== transition?.bridgeImage ||
    JSON.stringify(app?.reviewedImageSchemaPhases) !==
      JSON.stringify(EXPECTED_SCHEMA_PHASES) ||
    JSON.stringify(
      app?.reviewedRollbackImageSchemaPhases?.[transition?.bridgeImage],
    ) !== JSON.stringify(EXPECTED_SCHEMA_PHASES)
  ) {
    fail("reviewed credit transition is not frozen");
  }
  if (
    recovery?.app !== "leaderbot-portal-mysql" ||
    recovery?.databaseName !== "leaderbot" ||
    recovery?.region !== "ams" ||
    recovery?.sizeGb !== 10 ||
    !/^vol_[a-z0-9]+$/.test(recovery?.volumeId ?? "") ||
    !/^docker-hub-mirror\.fly\.io\/library\/mysql:8\.4\.11@sha256:[a-f0-9]{64}$/.test(
      recovery?.mysqlImage ?? "",
    )
  ) {
    fail("reviewed database recovery target mismatch");
  }
  return { app, recovery, transition };
}

export function selectReviewedDatabaseTarget({ machines, volumes, recovery }) {
  if (!Array.isArray(machines) || !Array.isArray(volumes)) {
    fail("database provider metadata is invalid");
  }
  const started = machines.filter((machine) => machine?.state === "started");
  if (started.length !== 1) {
    fail("database must have exactly one started Machine");
  }
  const machine = started[0];
  const mounts = machine?.config?.mounts;
  const expectedDigest = recovery.mysqlImage.split("@sha256:")[1];
  if (
    !/^[a-f0-9]{14}$/.test(machine?.id ?? "") ||
    !/^fdaa:[0-9a-f:]+$/.test(machine?.private_ip ?? "") ||
    machine?.region !== recovery.region ||
    machine?.host_status !== "ok" ||
    machine?.cordoned !== false ||
    machine?.image_ref?.digest !== `sha256:${expectedDigest}` ||
    machine?.config?.image !== recovery.mysqlImage ||
    !Array.isArray(mounts) ||
    mounts.length !== 1 ||
    mounts[0]?.volume !== recovery.volumeId ||
    mounts[0]?.path !== "/var/lib/mysql" ||
    mounts[0]?.encrypted !== true ||
    mounts[0]?.size_gb !== recovery.sizeGb
  ) {
    fail("reviewed database Machine mismatch");
  }
  const matchingVolumes = volumes.filter(
    (volume) => volume?.id === recovery.volumeId,
  );
  if (matchingVolumes.length !== 1) {
    fail("reviewed database volume is not unique");
  }
  const volume = matchingVolumes[0];
  if (
    volume?.encrypted !== true ||
    volume?.region !== recovery.region ||
    volume?.size_gb !== recovery.sizeGb ||
    volume?.attached_machine_id !== machine.id ||
    volume?.auto_backup_enabled !== true
  ) {
    fail("reviewed database volume mismatch");
  }
  return { machine, volume };
}

export function assertRecoverySnapshot(
  snapshots,
  { snapshotId, recovery, now = Date.now() },
) {
  if (
    !Array.isArray(snapshots) ||
    typeof snapshotId !== "string" ||
    !/^[A-Za-z0-9_-]{16,80}$/.test(snapshotId)
  ) {
    fail("recovery snapshot input is invalid");
  }
  const matching = snapshots.filter((snapshot) => snapshot?.id === snapshotId);
  if (matching.length !== 1) {
    fail("recovery snapshot is not unique");
  }
  const snapshot = matching[0];
  const createdAt = Date.parse(snapshot?.created_at ?? "");
  const age = now - createdAt;
  if (
    snapshot?.status !== "created" ||
    typeof snapshot?.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(snapshot.digest) ||
    !Number.isSafeInteger(snapshot?.size) ||
    snapshot.size < 1 ||
    snapshot?.volume_size !== recovery.sizeGb * 1024 ** 3 ||
    !Number.isFinite(createdAt) ||
    age < -60_000 ||
    age > MAX_SNAPSHOT_AGE_MS
  ) {
    fail("recovery snapshot is not fresh and usable");
  }
  return {
    createdAt: snapshot.created_at,
    digest: snapshot.digest,
    id: snapshot.id,
    size: snapshot.size,
    status: snapshot.status,
    volumeSize: snapshot.volume_size,
  };
}

export function parseManagedProvisionerAccounts(lines) {
  if (!Array.isArray(lines)) fail("managed account inventory is invalid");
  return lines.filter(Boolean).map((line) => {
    const [username, hostname, extra] = String(line).split("\t");
    if (
      extra !== undefined ||
      !CREDIT_PROVISIONER_ACCOUNT_PATTERN.test(username ?? "") ||
      hostname !== "%"
    ) {
      fail("managed account inventory is invalid");
    }
    return Object.freeze({ hostname, username });
  });
}

export function quoteManagedAccount(account) {
  if (
    !CREDIT_PROVISIONER_ACCOUNT_PATTERN.test(account?.username ?? "") ||
    account?.hostname !== "%"
  ) {
    fail("managed account identity is invalid");
  }
  return `'${account.username}'@'%'`;
}

export function buildProvisionerSql({ databaseName, password, username }) {
  if (
    !CREDIT_PROVISIONER_ACCOUNT_PATTERN.test(username ?? "") ||
    typeof password !== "string" ||
    !/^Aa1![a-f0-9]{96}$/.test(password)
  ) {
    fail("generated provisioner credential is invalid");
  }
  const account = quoteManagedAccount({ hostname: "%", username });
  const database = quoteMysqlIdentifier(databaseName);
  const expectedTablePrivileges = new Map(
    productionRuntimeWritableTableNames.map((tableName) => [
      tableName,
      new Set(["INSERT", "UPDATE", "DELETE"]),
    ]),
  );
  for (const [tableName, privileges] of Object.entries(
    creditWalletMigrationTablePrivileges,
  )) {
    const expected = expectedTablePrivileges.get(tableName) ?? new Set();
    for (const privilege of privileges) expected.add(privilege);
    expectedTablePrivileges.set(tableName, expected);
  }
  const grantStatements = [
    `GRANT CREATE USER ON *.* TO ${account}`,
    `GRANT SELECT ON \`mysql\`.\`user\` TO ${account}`,
    `GRANT SELECT, EXECUTE ON ${database}.* TO ${account} WITH GRANT OPTION`,
  ];
  for (const [tableName, privileges] of expectedTablePrivileges) {
    grantStatements.push(
      `GRANT ${[...privileges].sort().join(", ")} ON ${database}.${quoteMysqlIdentifier(tableName)} TO ${account} WITH GRANT OPTION`,
    );
  }
  return Object.freeze({
    account,
    createStatement: `CREATE USER ${account} IDENTIFIED BY '${password}'`,
    grantStatements: Object.freeze(grantStatements),
  });
}

export function buildExpectedProvisionerGrants({ databaseName, username }) {
  if (!CREDIT_PROVISIONER_ACCOUNT_PATTERN.test(username ?? "")) {
    fail("managed account identity is invalid");
  }
  const account = `\`${username}\`@\`%\``;
  const database = `\`${databaseName}\``;
  const grants = [
    `GRANT USAGE ON *.* TO ${account}`,
    `GRANT CREATE USER ON *.* TO ${account}`,
    `GRANT SELECT ON \`mysql\`.\`user\` TO ${account}`,
    `GRANT SELECT, EXECUTE ON ${database}.* TO ${account} WITH GRANT OPTION`,
  ];
  const sql = buildProvisionerSql({
    databaseName,
    password: `Aa1!${"a".repeat(96)}`,
    username,
  });
  for (const statement of sql.grantStatements.slice(3)) {
    grants.push(statement.replace(` TO '${username}'@'%'`, ` TO ${account}`));
  }
  assertCreditProvisionerGrantScope(grants, databaseName);
  return Object.freeze(grants);
}

export function assertProvisionerGrants(grants, databaseName) {
  assertCreditProvisionerGrantScope(grants, databaseName);
}

export function buildProvisionerUrl({
  databaseName,
  password,
  port = 13306,
  username,
}) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    fail("provisioner URL port is invalid");
  }
  const url = new URL(`mysql://127.0.0.1/${databaseName}`);
  url.username = username;
  url.password = password;
  url.port = String(port);
  assertProvisionerUrl(url.toString(), { databaseName, port, username });
  return url.toString();
}

export function assertProvisionerUrl(
  value,
  { databaseName, port = 13306, username },
) {
  let url;
  try {
    url = new URL(value);
  } catch {
    fail("provisioner URL is invalid");
  }
  if (
    !new Set(["mysql:", "mysql2:"]).has(url.protocol) ||
    url.hostname !== "127.0.0.1" ||
    url.port !== String(port) ||
    url.pathname !== `/${databaseName}` ||
    url.username !== username ||
    !CREDIT_PROVISIONER_ACCOUNT_PATTERN.test(url.username) ||
    !/^Aa1![a-f0-9]{96}$/.test(url.password) ||
    url.search ||
    url.hash
  ) {
    fail("provisioner URL is invalid");
  }
  return url;
}

export function githubSecretSetArgs(repository, environment) {
  return Object.freeze([
    "secret",
    "set",
    CREDIT_PROVISIONER_SECRET_NAME,
    "--repo",
    repository,
    "--env",
    environment,
  ]);
}
