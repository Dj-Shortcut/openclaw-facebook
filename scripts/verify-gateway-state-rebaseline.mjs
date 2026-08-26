import crypto from "node:crypto";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

const SHA256_RE = /^[a-f0-9]{64}$/;
const COMMIT_RE = /^[a-f0-9]{40}$/;
const MACHINE_ID_RE = /^[a-f0-9]{14}$/;
const VOLUME_ID_RE = /^vol_[a-z0-9]+$/;
const BASELINE_GATEWAY_IMAGE_RE =
  /^registry\.fly\.io\/leaderbot-openclaw-gateway:[a-z0-9][a-z0-9._-]{0,127}@sha256:[a-f0-9]{64}$/;
const REVIEWED_GATEWAY_IMAGE_RE =
  /^registry\.fly\.io\/leaderbot-openclaw-gateway@sha256:[a-f0-9]{64}$/;
const REHEARSAL_PROTOCOL = "leaderbot-gateway-state-rehearsal-v1";

function fail(message) {
  throw new Error(message);
}

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function requireString(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function sortedJsonValue(value) {
  if (Array.isArray(value)) return value.map(sortedJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedJsonValue(value[key])]),
  );
}

export function sha256CanonicalJson(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(sortedJsonValue(value)))
    .digest("hex");
}

export function sha256FileBytes(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requireExactCheckSet(checks, expected, label) {
  const value = requireObject(checks, label);
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(Object.keys(expected).sort())) {
    fail(`${label} has unexpected fields`);
  }
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (value[key] !== expectedValue) {
      fail(`${label}.${key} must be ${String(expectedValue)}`);
    }
  }
}

export function validateGatewayStateRebaselineContract(
  manifest,
  { requireApproved = false } = {},
) {
  const root = requireObject(manifest, "production manifest");
  const gateway = requireObject(root.apps?.gateway, "gateway manifest");
  const contract = requireObject(
    gateway.stateRebaseline,
    "gateway state rebaseline",
  );
  if (gateway.deploymentEnabled !== false || contract.enforcementEnabled !== false) {
    fail("gateway deployment and rebaseline enforcement must remain disabled");
  }
  if (!new Set(["awaiting_rehearsal", "rehearsal_approved"]).has(contract.state)) {
    fail("gateway state rebaseline state is invalid");
  }
  if (requireApproved && contract.state !== "rehearsal_approved") {
    fail("gateway state rebaseline is not approved for rehearsal");
  }

  const baseline = requireObject(contract.baseline, "gateway baseline");
  if (baseline.app !== gateway.app) fail("gateway baseline app mismatch");
  requireString(baseline.machineId, MACHINE_ID_RE, "gateway baseline Machine id");
  requireString(
    baseline.image,
    BASELINE_GATEWAY_IMAGE_RE,
    "gateway baseline image",
  );
  requireString(baseline.volumeId, VOLUME_ID_RE, "gateway baseline volume id");
  if (baseline.mountPath !== "/data") fail("gateway baseline mount path mismatch");
  if (!/^[a-z0-9]{3}$/.test(baseline.region ?? "")) {
    fail("gateway baseline region is invalid");
  }
  if (baseline.encrypted !== true) fail("gateway baseline must be encrypted");
  if (
    typeof baseline.deploymentIdentity !== "string" ||
    !/^(?:legacy_unlabeled|(?:deploy|rollback)-[0-9]+-[0-9]+)$/.test(
      baseline.deploymentIdentity,
    )
  ) {
    fail("gateway baseline deployment identity is invalid");
  }
  const configIdentity = requireObject(
    baseline.configIdentity,
    "gateway baseline config identity",
  );
  for (const key of [
    "machineConfigSha256",
    "flyConfigSha256",
    "generatedConfigSha256",
  ]) {
    if (
      contract.state === "awaiting_rehearsal" &&
      configIdentity[key] === null
    ) {
      continue;
    }
    requireString(configIdentity[key], SHA256_RE, `gateway baseline config identity ${key}`);
  }

  const artifact = requireObject(
    contract.reviewedArtifact,
    "gateway reviewed artifact",
  );
  if (contract.state === "awaiting_rehearsal") {
    if (
      artifact.state !== "unreviewed" ||
      [
        artifact.image,
        artifact.sourceCommit,
        artifact.builderWorkflow,
        artifact.predicateType,
        artifact.attestationBundleSha256,
      ].some((value) => value !== null)
    ) {
      fail("awaiting gateway artifact must remain unreviewed");
    }
  } else {
    if (artifact.state !== "reviewed") {
      fail("gateway reviewed artifact is not approved");
    }
    requireString(artifact.image, REVIEWED_GATEWAY_IMAGE_RE, "gateway reviewed artifact image");
    requireString(artifact.sourceCommit, COMMIT_RE, "gateway reviewed artifact source commit");
    if (
      typeof artifact.builderWorkflow !== "string" ||
      !/^\.github\/workflows\/[a-z0-9-]+\.yml$/.test(artifact.builderWorkflow)
    ) {
      fail("gateway reviewed artifact builder workflow is invalid");
    }
    if (
      typeof artifact.predicateType !== "string" ||
      !/^https:\/\/leaderbot\.live\/attestations\/[a-z0-9-]+\/v1$/.test(
        artifact.predicateType,
      )
    ) {
      fail("gateway reviewed artifact predicate type is invalid");
    }
    requireString(
      artifact.attestationBundleSha256,
      SHA256_RE,
      "gateway reviewed artifact attestation bundle hash",
    );
  }

  const rehearsal = requireObject(contract.rehearsal, "gateway rehearsal");
  if (rehearsal.state !== "pending") fail("gateway rehearsal must be pending");
  if (rehearsal.evidenceArtifact !== null || rehearsal.evidenceSha256 !== null) {
    fail("pending gateway rehearsal must not claim evidence");
  }
  if (contract.state === "awaiting_rehearsal") {
    if (rehearsal.sourceVolumeId !== null) {
      fail("awaiting gateway rehearsal must not claim a source volume");
    }
  } else if (rehearsal.sourceVolumeId !== baseline.volumeId) {
    fail("gateway rehearsal source volume differs from the baseline");
  }
  if (
    rehearsal.mountPath !== baseline.mountPath ||
    rehearsal.region !== baseline.region ||
    rehearsal.encrypted !== true
  ) {
    fail("gateway rehearsal source tuple differs from the baseline");
  }
  if (rehearsal.contentInspectionAllowed !== false) {
    fail("gateway rehearsal content inspection must remain disabled");
  }
  requireExactCheckSet(
    rehearsal.checks,
    {
      startupPassed: false,
      tenantIsolationPassed: false,
      rollbackPassed: false,
      metadataOnlyEvidence: false,
    },
    "gateway rehearsal checks",
  );

  for (const label of ["recovery", "successor"]) {
    const value = requireObject(contract[label], `gateway ${label}`);
    if (
      value.state !== "unreviewed" ||
      [value.identity, value.image, value.sourceCommit, value.configSha256].some(
        (field) => field !== null,
      )
    ) {
      fail(`gateway ${label} must remain unreviewed`);
    }
  }
  const historical = requireObject(
    contract.historicalResources,
    "gateway historical resources",
  );
  if (
    historical.automaticDeletionAllowed !== false ||
    historical.preserveUnlistedMachines !== true ||
    historical.preserveUnlistedVolumes !== true
  ) {
    fail("gateway historical resources must remain preserved");
  }

  return Object.freeze({ gateway, contract, baseline, artifact, rehearsal });
}

function immutableMachineImage(machine) {
  const imageRef = machine?.image_ref;
  if (
      imageRef?.registry === "registry.fly.io" &&
      imageRef?.repository === "leaderbot-openclaw-gateway" &&
      typeof imageRef?.tag === "string" &&
      /^[a-z0-9][a-z0-9._-]{0,127}$/.test(imageRef.tag) &&
      /^sha256:[a-f0-9]{64}$/.test(imageRef?.digest ?? "")
  ) {
    return `${imageRef.registry}/${imageRef.repository}:${imageRef.tag}@${imageRef.digest}`;
  }
  return null;
}

function inspectGatewayLiveBaseline({
  manifest,
  machines,
  volumes,
  generatedConfig,
  flyConfigText,
}, { captureOnly = false } = {}) {
  const { contract, baseline } = validateGatewayStateRebaselineContract(
    manifest,
    { requireApproved: !captureOnly },
  );
  if (captureOnly && contract.state !== "awaiting_rehearsal") {
    fail("gateway baseline capture requires awaiting_rehearsal");
  }
  if (!Array.isArray(machines) || !Array.isArray(volumes)) {
    fail("gateway live inventory is invalid");
  }
  const matchingMachines = machines.filter(
    (machine) => machine?.id === baseline.machineId,
  );
  if (matchingMachines.length !== 1) fail("gateway baseline Machine mismatch");
  const machine = matchingMachines[0];
  if (machine.state !== "started") fail("gateway baseline Machine is not started");
  if (
    machines.some(
      (candidate) =>
        candidate?.id !== baseline.machineId &&
        ["created", "starting", "started", "stopping"].includes(
          candidate?.state,
        ),
    )
  ) {
    fail("gateway has another active Machine");
  }
  if (
    immutableMachineImage(machine) !== baseline.image ||
    machine.region !== baseline.region
  ) {
    fail("gateway baseline Machine tuple mismatch");
  }
  const mounts = machine.config?.mounts;
  if (
    !Array.isArray(mounts) ||
    mounts.length !== 1 ||
    mounts[0]?.volume !== baseline.volumeId ||
    mounts[0]?.path !== baseline.mountPath
  ) {
    fail("gateway baseline Machine mount mismatch");
  }
  const machineIdentity =
    machine.config?.env?.LEADERBOT_DEPLOYMENT_IDENTITY ?? "legacy_unlabeled";
  if (machineIdentity !== baseline.deploymentIdentity) {
    fail("gateway baseline Machine deployment identity mismatch");
  }

  const matchingVolumes = volumes.filter(
    (volume) => volume?.id === baseline.volumeId,
  );
  if (matchingVolumes.length !== 1) fail("gateway baseline volume mismatch");
  const volume = matchingVolumes[0];
  if (
    volume.encrypted !== true ||
    volume.region !== baseline.region ||
    volume.attached_machine_id !== baseline.machineId
  ) {
    fail("gateway baseline volume tuple mismatch");
  }

  const liveConfig = requireObject(generatedConfig, "gateway generated config");
  if (liveConfig.app !== baseline.app) fail("gateway generated config app mismatch");
  const generatedIdentity =
    liveConfig.env?.LEADERBOT_DEPLOYMENT_IDENTITY ?? "legacy_unlabeled";
  if (generatedIdentity !== baseline.deploymentIdentity) {
    fail("gateway generated config deployment identity mismatch");
  }
  if (typeof flyConfigText !== "string" || flyConfigText.length === 0) {
    fail("gateway reviewed Fly config is missing");
  }

  const observedHashes = {
    machineConfigSha256: sha256CanonicalJson(machine.config),
    flyConfigSha256: sha256FileBytes(flyConfigText),
    generatedConfigSha256: sha256CanonicalJson(liveConfig),
  };
  if (
    !captureOnly &&
    Object.entries(observedHashes).some(
      ([key, value]) => value !== baseline.configIdentity[key],
    )
  ) {
    fail("gateway baseline configuration hash mismatch");
  }

  return {
    protocol: REHEARSAL_PROTOCOL,
    app: baseline.app,
    machineId: baseline.machineId,
    image: baseline.image,
    volumeId: baseline.volumeId,
    mountPath: baseline.mountPath,
    region: baseline.region,
    encrypted: true,
    deploymentIdentity: baseline.deploymentIdentity,
    configIdentity: observedHashes,
    metadataOnly: true,
  };
}

export function captureGatewayLiveBaseline(input) {
  return inspectGatewayLiveBaseline(input, { captureOnly: true });
}

export function verifyGatewayLiveBaseline(input) {
  return inspectGatewayLiveBaseline(input);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function runCli(argv) {
  if (argv[0] === "--validate-contract" && argv.length === 2) {
    validateGatewayStateRebaselineContract(readJson(argv[1]));
    return;
  }
  if (argv[0] === "--require-approved" && argv.length === 2) {
    validateGatewayStateRebaselineContract(readJson(argv[1]), {
      requireApproved: true,
    });
    return;
  }
  if (argv[0] === "--verify-baseline" && argv.length === 7) {
    const evidence = verifyGatewayLiveBaseline({
      manifest: readJson(argv[1]),
      machines: readJson(argv[2]),
      volumes: readJson(argv[3]),
      generatedConfig: readJson(argv[4]),
      flyConfigText: fs.readFileSync(argv[5], "utf8"),
    });
    fs.writeFileSync(argv[6], `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o600,
    });
    return;
  }
  if (argv[0] === "--capture-baseline" && argv.length === 7) {
    const evidence = captureGatewayLiveBaseline({
      manifest: readJson(argv[1]),
      machines: readJson(argv[2]),
      volumes: readJson(argv[3]),
      generatedConfig: readJson(argv[4]),
      flyConfigText: fs.readFileSync(argv[5], "utf8"),
    });
    fs.writeFileSync(argv[6], `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o600,
    });
    return;
  }
  fail(
    "usage: verify-gateway-state-rebaseline.mjs --validate-contract <manifest> | --require-approved <manifest> | --capture-baseline <manifest> <machines> <volumes> <generated-config> <fly-config> <evidence> | --verify-baseline <manifest> <machines> <volumes> <generated-config> <fly-config> <evidence>",
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "gateway rebaseline verification failed"}\n`,
    );
    process.exitCode = 1;
  }
}
