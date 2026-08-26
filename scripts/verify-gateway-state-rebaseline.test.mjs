import { describe, expect, it } from "vitest";

import {
  captureGatewayLiveBaseline,
  sha256CanonicalJson,
  sha256FileBytes,
  validateGatewayStateRebaselineContract,
  verifyGatewayLiveBaseline,
} from "./verify-gateway-state-rebaseline.mjs";

const app = "leaderbot-openclaw-gateway";
const machineId = "28621d2c559558";
const volumeId = "vol_v8elpyo26xwdmk1v";
const currentImage =
  "registry.fly.io/leaderbot-openclaw-gateway:codex-codex-disabled-20260803@sha256:b0992d818d6fde9790f010f4866c97d78fd1d8c376492b515d50efa4778c704e";
const reviewedImage =
  "registry.fly.io/leaderbot-openclaw-gateway@sha256:1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";
const flyConfigText = 'app = "leaderbot-openclaw-gateway"\n';

function machine() {
  return {
    id: machineId,
    state: "started",
    region: "ams",
    image_ref: {
      registry: "registry.fly.io",
      repository: app,
      tag: "codex-codex-disabled-20260803",
      digest: currentImage.slice(currentImage.indexOf("sha256:")),
    },
    config: {
      env: { NODE_ENV: "production" },
      mounts: [{ volume: volumeId, path: "/data" }],
      metadata: { fly_process_group: "app" },
    },
  };
}

function generatedConfig() {
  return {
    app,
    env: { NODE_ENV: "production" },
    primary_region: "ams",
  };
}

function manifest(overrides = {}) {
  const currentMachine = machine();
  const currentGeneratedConfig = generatedConfig();
  const stateRebaseline = {
    state: "rehearsal_approved",
    enforcementEnabled: false,
    baseline: {
      app,
      machineId,
      deploymentIdentity: "legacy_unlabeled",
      image: currentImage,
      volumeId,
      mountPath: "/data",
      region: "ams",
      encrypted: true,
      configIdentity: {
        machineConfigSha256: sha256CanonicalJson(currentMachine.config),
        flyConfigSha256: sha256FileBytes(flyConfigText),
        generatedConfigSha256: sha256CanonicalJson(currentGeneratedConfig),
      },
    },
    reviewedArtifact: {
      state: "reviewed",
      image: reviewedImage,
      sourceCommit: "a".repeat(40),
      builderWorkflow: ".github/workflows/build-production-artifacts.yml",
      predicateType:
        "https://leaderbot.live/attestations/gateway-runtime/v1",
      attestationBundleSha256: "b".repeat(64),
    },
    rehearsal: {
      state: "pending",
      evidenceArtifact: null,
      evidenceSha256: null,
      sourceVolumeId: volumeId,
      mountPath: "/data",
      region: "ams",
      encrypted: true,
      contentInspectionAllowed: false,
      checks: {
        startupPassed: false,
        tenantIsolationPassed: false,
        rollbackPassed: false,
        metadataOnlyEvidence: false,
      },
    },
    recovery: {
      state: "unreviewed",
      identity: null,
      image: null,
      sourceCommit: null,
      configSha256: null,
    },
    successor: {
      state: "unreviewed",
      identity: null,
      image: null,
      sourceCommit: null,
      configSha256: null,
    },
    historicalResources: {
      automaticDeletionAllowed: false,
      preserveUnlistedMachines: true,
      preserveUnlistedVolumes: true,
    },
    ...overrides,
  };
  return {
    schemaVersion: 1,
    apps: {
      gateway: {
        app,
        deploymentEnabled: false,
        stateRebaseline,
      },
    },
  };
}

function liveInput(overrides = {}) {
  return {
    manifest: manifest(),
    machines: [machine()],
    volumes: [
      {
        id: volumeId,
        encrypted: true,
        region: "ams",
        attached_machine_id: machineId,
      },
    ],
    generatedConfig: generatedConfig(),
    flyConfigText,
    ...overrides,
  };
}

function awaitingManifest() {
  return manifest({
    state: "awaiting_rehearsal",
    baseline: {
      ...manifest().apps.gateway.stateRebaseline.baseline,
      configIdentity: {
        machineConfigSha256: null,
        flyConfigSha256: null,
        generatedConfigSha256: null,
      },
    },
    reviewedArtifact: {
      state: "unreviewed",
      image: null,
      sourceCommit: null,
      builderWorkflow: null,
      predicateType: null,
      attestationBundleSha256: null,
    },
    rehearsal: {
      ...manifest().apps.gateway.stateRebaseline.rehearsal,
      sourceVolumeId: null,
    },
  });
}

describe("gateway state rebaseline contract", () => {
  it("accepts an exact disabled baseline and reviewed rehearsal artifact", () => {
    const parsed = validateGatewayStateRebaselineContract(manifest());

    expect(parsed.baseline.machineId).toBe(machineId);
    expect(parsed.artifact.image).toBe(reviewedImage);
    expect(parsed.rehearsal.checks.metadataOnlyEvidence).toBe(false);
  });

  it("accepts the current unreviewed state but refuses it for a Fly rehearsal", () => {
    const value = awaitingManifest();

    expect(() => validateGatewayStateRebaselineContract(value)).not.toThrow();
    expect(() =>
      validateGatewayStateRebaselineContract(value, { requireApproved: true }),
    ).toThrow("not approved for rehearsal");
  });

  it("refuses missing configuration hashes", () => {
    const value = manifest();
    value.apps.gateway.stateRebaseline.baseline.configIdentity.machineConfigSha256 =
      null;

    expect(() => validateGatewayStateRebaselineContract(value)).toThrow(
      "machineConfigSha256 is invalid",
    );
  });
});

describe("gateway live baseline verification", () => {
  it("captures metadata-only hashes before approval and verifies the reviewed update", () => {
    const captureInput = liveInput({ manifest: awaitingManifest() });
    const captured = captureGatewayLiveBaseline(captureInput);
    const approved = manifest();
    approved.apps.gateway.stateRebaseline.baseline.configIdentity =
      captured.configIdentity;

    expect(captured).toEqual(
      expect.objectContaining({
        protocol: "leaderbot-gateway-state-rehearsal-v1",
        metadataOnly: true,
        configIdentity: {
          machineConfigSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          flyConfigSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          generatedConfigSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      }),
    );
    expect(
      verifyGatewayLiveBaseline(
        liveInput({ manifest: approved }),
      ).configIdentity,
    ).toEqual(captured.configIdentity);
  });

  it("refuses capture when the awaiting live image or active Machine set drifts", () => {
    const wrongImage = machine();
    wrongImage.image_ref.digest = `sha256:${"f".repeat(64)}`;
    expect(() =>
      captureGatewayLiveBaseline(
        liveInput({ manifest: awaitingManifest(), machines: [wrongImage] }),
      ),
    ).toThrow("Machine tuple mismatch");

    const extra = { ...machine(), id: "11111111111111" };
    expect(() =>
      captureGatewayLiveBaseline(
        liveInput({
          manifest: awaitingManifest(),
          machines: [machine(), extra],
        }),
      ),
    ).toThrow("another active Machine");
  });

  it("returns only redacted metadata for the exact live tuple", () => {
    const evidence = verifyGatewayLiveBaseline(liveInput());

    expect(evidence).toEqual(
      expect.objectContaining({
        protocol: "leaderbot-gateway-state-rehearsal-v1",
        app,
        machineId,
        image: currentImage,
        volumeId,
        mountPath: "/data",
        region: "ams",
        encrypted: true,
        deploymentIdentity: "legacy_unlabeled",
        metadataOnly: true,
      }),
    );
    expect(JSON.stringify(evidence)).not.toContain("NODE_ENV");
  });

  it("refuses a second active Machine", () => {
    const extra = {
      ...machine(),
      id: "11111111111111",
      config: { ...machine().config, mounts: [] },
    };

    expect(() =>
      verifyGatewayLiveBaseline(
        liveInput({ machines: [machine(), extra] }),
      ),
    ).toThrow("another active Machine");
  });

  it("refuses an image, volume, or configuration hash mismatch", () => {
    const wrongImage = machine();
    wrongImage.image_ref.digest = `sha256:${"f".repeat(64)}`;
    expect(() =>
      verifyGatewayLiveBaseline(liveInput({ machines: [wrongImage] })),
    ).toThrow("Machine tuple mismatch");

    const wrongVolume = liveInput();
    wrongVolume.volumes[0].attached_machine_id = "11111111111111";
    expect(() => verifyGatewayLiveBaseline(wrongVolume)).toThrow(
      "volume tuple mismatch",
    );

    const wrongConfig = liveInput();
    wrongConfig.generatedConfig.env.UNREVIEWED = "1";
    expect(() => verifyGatewayLiveBaseline(wrongConfig)).toThrow(
      "configuration hash mismatch",
    );
  });
});
