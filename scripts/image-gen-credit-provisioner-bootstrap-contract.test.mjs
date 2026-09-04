import { describe, expect, it } from "vitest";

import {
  CREDIT_PROVISIONER_ACCOUNT_LEVEL_GRANT_COUNT,
  assertBootstrapManifest,
  assertProvisionerGrants,
  assertProvisionerUrl,
  assertRecoverySnapshot,
  buildExpectedProvisionerGrants,
  buildProvisionerSql,
  buildProvisionerUrl,
  githubSecretSetArgs,
  parseManagedProvisionerAccounts,
  quoteManagedAccount,
  quoteMysqlIdentifier,
  selectReviewedDatabaseTarget,
} from "./image-gen-credit-provisioner-bootstrap-contract.mjs";
import { productionRuntimeWritableTableNames } from "../apps/image-gen/scripts/production-schema-contract.mjs";

const BRIDGE_IMAGE =
  "registry.fly.io/leaderbot-fb-image-gen@sha256:" + "b".repeat(64);
const MYSQL_DIGEST = "a".repeat(64);
const MYSQL_IMAGE =
  "docker-hub-mirror.fly.io/library/mysql:8.4.11@sha256:" + MYSQL_DIGEST;
const USERNAME = "lbcp_0123456789abcdef";
const PASSWORD = `Aa1!${"c".repeat(96)}`;
const SNAPSHOT_ID = "vs_01K39M7A7WEXAMPLE3";
const SNAPSHOT_DIGEST = "d".repeat(64);
const NOW = Date.parse("2026-08-30T08:00:00.000Z");

function canonicalManifest() {
  return {
    apps: {
      "image-gen": {
        databaseRecovery: {
          app: "leaderbot-portal-mysql",
          databaseName: "leaderbot",
          mysqlImage: MYSQL_IMAGE,
          region: "ams",
          sizeGb: 10,
          volumeId: "vol_49165px70nx9ylzr",
        },
        databaseSchemaPhase: "0016_expand",
        databaseSchemaTransition: {
          bridgeImage: BRIDGE_IMAGE,
          from: "0016_expand",
          state: "expand_pending",
          to: "0018_credit_checkout_reservation",
        },
        deploymentEnabled: false,
        reviewedArtifactKind: "migration-bridge",
        reviewedImage: BRIDGE_IMAGE,
        reviewedImageSchemaPhases: [
          "0016_expand",
          "0017_credit_wallet_expand",
          "0018_credit_checkout_reservation",
        ],
        reviewedRollbackImages: [BRIDGE_IMAGE],
        reviewedRollbackImageSchemaPhases: {
          [BRIDGE_IMAGE]: [
            "0016_expand",
            "0017_credit_wallet_expand",
            "0018_credit_checkout_reservation",
          ],
        },
        sourceDeployEnabled: false,
      },
    },
  };
}

function canonicalRecovery() {
  return canonicalManifest().apps["image-gen"].databaseRecovery;
}

function canonicalMachine() {
  const recovery = canonicalRecovery();
  return {
    config: {
      image: recovery.mysqlImage,
      mounts: [
        {
          encrypted: true,
          path: "/var/lib/mysql",
          size_gb: recovery.sizeGb,
          volume: recovery.volumeId,
        },
      ],
    },
    cordoned: false,
    host_status: "ok",
    id: "28607e7c932038",
    image_ref: { digest: `sha256:${MYSQL_DIGEST}` },
    private_ip: "fdaa:0:1234:a7b:42:1:abcd:2",
    region: recovery.region,
    state: "started",
  };
}

function canonicalVolume() {
  const recovery = canonicalRecovery();
  return {
    attached_machine_id: canonicalMachine().id,
    auto_backup_enabled: true,
    encrypted: true,
    id: recovery.volumeId,
    region: recovery.region,
    size_gb: recovery.sizeGb,
  };
}

function canonicalSnapshot() {
  return {
    created_at: "2026-08-30T07:55:00.000Z",
    digest: SNAPSHOT_DIGEST,
    id: SNAPSHOT_ID,
    size: 4096,
    status: "created",
    volume_size: canonicalRecovery().sizeGb * 1024 ** 3,
  };
}

describe("image-gen credit provisioner bootstrap contract", () => {
  describe("reviewed manifest", () => {
    it("accepts only the frozen 0016-to-0018 bridge and reviewed recovery target", () => {
      const manifest = canonicalManifest();

      expect(assertBootstrapManifest(manifest)).toEqual({
        app: manifest.apps["image-gen"],
        recovery: manifest.apps["image-gen"].databaseRecovery,
        transition: manifest.apps["image-gen"].databaseSchemaTransition,
      });
    });

    it.each([
      [
        "enabled deploys",
        (manifest) => (manifest.apps["image-gen"].deploymentEnabled = true),
      ],
      [
        "enabled source deploys",
        (manifest) => (manifest.apps["image-gen"].sourceDeployEnabled = true),
      ],
      [
        "wrong artifact kind",
        (manifest) =>
          (manifest.apps["image-gen"].reviewedArtifactKind = "runtime"),
      ],
      [
        "wrong schema phase",
        (manifest) =>
          (manifest.apps["image-gen"].databaseSchemaPhase =
            "0017_credit_wallet_expand"),
      ],
      [
        "wrong transition state",
        (manifest) =>
          (manifest.apps["image-gen"].databaseSchemaTransition.state =
            "bridge_reviewed"),
      ],
      [
        "wrong transition start",
        (manifest) =>
          (manifest.apps["image-gen"].databaseSchemaTransition.from =
            "0015_base"),
      ],
      [
        "wrong transition target",
        (manifest) =>
          (manifest.apps["image-gen"].databaseSchemaTransition.to =
            "0017_credit_wallet_expand"),
      ],
      [
        "different reviewed image",
        (manifest) =>
          (manifest.apps["image-gen"].reviewedImage = `${BRIDGE_IMAGE}-other`),
      ],
      [
        "extra rollback",
        (manifest) =>
          manifest.apps["image-gen"].reviewedRollbackImages.push(
            `${BRIDGE_IMAGE}-old`,
          ),
      ],
      [
        "reordered phase support",
        (manifest) =>
          manifest.apps["image-gen"].reviewedRollbackImageSchemaPhases[
            BRIDGE_IMAGE
          ].reverse(),
      ],
      [
        "reordered current-image phase support",
        (manifest) =>
          manifest.apps["image-gen"].reviewedImageSchemaPhases.reverse(),
      ],
    ])("rejects %s", (_label, mutate) => {
      const manifest = canonicalManifest();
      mutate(manifest);

      expect(() => assertBootstrapManifest(manifest)).toThrow(
        "reviewed credit transition is not frozen",
      );
    });

    it.each([
      ["wrong app", (recovery) => (recovery.app = "other-db")],
      ["wrong database", (recovery) => (recovery.databaseName = "other")],
      ["wrong region", (recovery) => (recovery.region = "iad")],
      ["wrong size", (recovery) => (recovery.sizeGb = 20)],
      ["malformed volume", (recovery) => (recovery.volumeId = "volume")],
      [
        "mutable MySQL image",
        (recovery) => (recovery.mysqlImage = "mysql:8.4.11"),
      ],
    ])("rejects a recovery target with %s", (_label, mutate) => {
      const manifest = canonicalManifest();
      mutate(manifest.apps["image-gen"].databaseRecovery);

      expect(() => assertBootstrapManifest(manifest)).toThrow(
        "reviewed database recovery target mismatch",
      );
    });
  });

  describe("database Machine, mount, and volume", () => {
    it("selects the sole healthy started Machine bound to the exact encrypted volume", () => {
      const recovery = canonicalRecovery();
      const machine = canonicalMachine();
      const volume = canonicalVolume();

      expect(
        selectReviewedDatabaseTarget({
          machines: [
            machine,
            { ...machine, id: "11111111111111", state: "stopped" },
          ],
          recovery,
          volumes: [volume],
        }),
      ).toEqual({ machine, volume });
    });

    it("requires exactly one started Machine in the database app", () => {
      const recovery = canonicalRecovery();
      const machine = canonicalMachine();
      const volume = canonicalVolume();

      expect(() =>
        selectReviewedDatabaseTarget({
          machines: [{ ...machine, state: "stopped" }],
          recovery,
          volumes: [volume],
        }),
      ).toThrow("database must have exactly one started Machine");
      expect(() =>
        selectReviewedDatabaseTarget({
          machines: [machine, { ...machine, id: "11111111111111" }],
          recovery,
          volumes: [volume],
        }),
      ).toThrow("database must have exactly one started Machine");
    });

    it.each([
      ["Machine id", (machine) => (machine.id = "not-a-machine")],
      ["private IPv6", (machine) => (machine.private_ip = "127.0.0.1")],
      ["region", (machine) => (machine.region = "iad")],
      ["host health", (machine) => (machine.host_status = "unknown")],
      ["cordon", (machine) => (machine.cordoned = true)],
      [
        "digest",
        (machine) => (machine.image_ref.digest = `sha256:${"e".repeat(64)}`),
      ],
      ["image", (machine) => (machine.config.image = "mysql:8.4.11")],
      [
        "single mount",
        (machine) =>
          machine.config.mounts.push({ ...machine.config.mounts[0] }),
      ],
      [
        "mount volume",
        (machine) => (machine.config.mounts[0].volume = "vol_other"),
      ],
      ["mount path", (machine) => (machine.config.mounts[0].path = "/data")],
      [
        "mount encryption",
        (machine) => (machine.config.mounts[0].encrypted = false),
      ],
      ["mount size", (machine) => (machine.config.mounts[0].size_gb = 20)],
    ])("rejects drift in the %s", (_label, mutate) => {
      const machine = canonicalMachine();
      mutate(machine);

      expect(() =>
        selectReviewedDatabaseTarget({
          machines: [machine],
          recovery: canonicalRecovery(),
          volumes: [canonicalVolume()],
        }),
      ).toThrow("reviewed database Machine mismatch");
    });

    it("requires one unique reviewed volume", () => {
      const volume = canonicalVolume();

      expect(() =>
        selectReviewedDatabaseTarget({
          machines: [canonicalMachine()],
          recovery: canonicalRecovery(),
          volumes: [],
        }),
      ).toThrow("reviewed database volume is not unique");
      expect(() =>
        selectReviewedDatabaseTarget({
          machines: [canonicalMachine()],
          recovery: canonicalRecovery(),
          volumes: [volume, { ...volume }],
        }),
      ).toThrow("reviewed database volume is not unique");
    });

    it.each([
      ["encryption", (volume) => (volume.encrypted = false)],
      ["region", (volume) => (volume.region = "iad")],
      ["size", (volume) => (volume.size_gb = 20)],
      [
        "attachment",
        (volume) => (volume.attached_machine_id = "11111111111111"),
      ],
      ["automatic backup", (volume) => (volume.auto_backup_enabled = false)],
    ])("rejects volume drift in %s", (_label, mutate) => {
      const volume = canonicalVolume();
      mutate(volume);

      expect(() =>
        selectReviewedDatabaseTarget({
          machines: [canonicalMachine()],
          recovery: canonicalRecovery(),
          volumes: [volume],
        }),
      ).toThrow("reviewed database volume mismatch");
    });
  });

  describe("recovery snapshot", () => {
    it("accepts one fresh, completed, non-empty snapshot with an exact digest", () => {
      const snapshot = canonicalSnapshot();

      expect(
        assertRecoverySnapshot([snapshot], {
          now: NOW,
          recovery: canonicalRecovery(),
          snapshotId: SNAPSHOT_ID,
        }),
      ).toEqual({
        createdAt: snapshot.created_at,
        digest: SNAPSHOT_DIGEST,
        id: SNAPSHOT_ID,
        size: snapshot.size,
        status: snapshot.status,
        volumeSize: snapshot.volume_size,
      });
    });

    it("requires one exact snapshot id", () => {
      const snapshot = canonicalSnapshot();

      expect(() =>
        assertRecoverySnapshot([snapshot], {
          now: NOW,
          recovery: canonicalRecovery(),
          snapshotId: "short",
        }),
      ).toThrow("recovery snapshot input is invalid");
      expect(() =>
        assertRecoverySnapshot([snapshot, { ...snapshot }], {
          now: NOW,
          recovery: canonicalRecovery(),
          snapshotId: SNAPSHOT_ID,
        }),
      ).toThrow("recovery snapshot is not unique");
    });

    it.each([
      ["unfinished status", (snapshot) => (snapshot.status = "pending")],
      ["zero bytes", (snapshot) => (snapshot.size = 0)],
      ["fractional bytes", (snapshot) => (snapshot.size = 1.5)],
      [
        "non-finite bytes",
        (snapshot) => (snapshot.size = Number.POSITIVE_INFINITY),
      ],
      ["wrong source-volume bytes", (snapshot) => (snapshot.volume_size -= 1)],
      ["short digest", (snapshot) => (snapshot.digest = "d".repeat(63))],
      [
        "prefixed digest",
        (snapshot) => (snapshot.digest = `sha256:${SNAPSHOT_DIGEST}`),
      ],
      ["non-hex digest", (snapshot) => (snapshot.digest = "z".repeat(64))],
      ["invalid timestamp", (snapshot) => (snapshot.created_at = "not-a-date")],
      [
        "stale timestamp",
        (snapshot) => (snapshot.created_at = "2026-08-30T06:59:59.999Z"),
      ],
      [
        "future timestamp",
        (snapshot) => (snapshot.created_at = "2026-08-30T08:01:00.001Z"),
      ],
    ])("rejects a snapshot with %s", (_label, mutate) => {
      const snapshot = canonicalSnapshot();
      mutate(snapshot);

      expect(() =>
        assertRecoverySnapshot([snapshot], {
          now: NOW,
          recovery: canonicalRecovery(),
          snapshotId: SNAPSHOT_ID,
        }),
      ).toThrow("recovery snapshot is not fresh and usable");
    });
  });

  describe("managed account inventory", () => {
    it("parses only exact generated accounts at the wildcard host", () => {
      expect(
        parseManagedProvisionerAccounts([
          `${USERNAME}\t%`,
          "lbcp_fedcba9876543210\t%",
        ]),
      ).toEqual([
        { hostname: "%", username: USERNAME },
        { hostname: "%", username: "lbcp_fedcba9876543210" },
      ]);
      expect(parseManagedProvisionerAccounts([])).toEqual([]);
      expect(quoteManagedAccount({ hostname: "%", username: USERNAME })).toBe(
        `'${USERNAME}'@'%'`,
      );
    });

    it.each([
      ["wrong prefix", "other_0123456789abcdef\t%"],
      ["wrong suffix length", "lbcp_0123\t%"],
      ["uppercase suffix", "lbcp_0123456789abcdeF\t%"],
      ["wrong host", `${USERNAME}\tlocalhost`],
      ["extra column", `${USERNAME}\t%\tY`],
    ])("rejects %s", (_label, line) => {
      expect(() => parseManagedProvisionerAccounts([line])).toThrow(
        "managed account inventory is invalid",
      );
    });
  });

  describe("exact grant contract", () => {
    it("builds only the exact provisioner account and delegation statements", () => {
      const sql = buildProvisionerSql({
        databaseName: "leaderbot",
        password: PASSWORD,
        username: USERNAME,
      });
      const expectedGrants = [
        `GRANT CREATE USER ON *.* TO '${USERNAME}'@'%'`,
        `GRANT SELECT ON \`mysql\`.\`user\` TO '${USERNAME}'@'%'`,
        `GRANT SELECT, EXECUTE ON \`leaderbot\`.* TO '${USERNAME}'@'%' WITH GRANT OPTION`,
        ...productionRuntimeWritableTableNames.map(
          (tableName) =>
            `GRANT DELETE, INSERT, UPDATE ON \`leaderbot\`.\`${tableName}\` TO '${USERNAME}'@'%' WITH GRANT OPTION`,
        ),
        `GRANT CREATE, DELETE ON \`leaderbot\`.\`credit_wallets\` TO '${USERNAME}'@'%' WITH GRANT OPTION`,
      ];

      expect(sql).toEqual({
        account: `'${USERNAME}'@'%'`,
        createStatement: `CREATE USER '${USERNAME}'@'%' IDENTIFIED BY '${PASSWORD}'`,
        grantStatements: expectedGrants,
      });
      expect(sql.grantStatements).toHaveLength(45);
      for (const statement of sql.grantStatements.slice(
        CREDIT_PROVISIONER_ACCOUNT_LEVEL_GRANT_COUNT,
      )) {
        const privileges = /^GRANT (.+) ON /.exec(statement)?.[1].split(", ");
        expect(privileges?.length).toBeGreaterThan(0);
        expect(
          privileges?.every((privilege) =>
            new Set(["CREATE", "DELETE", "INSERT", "UPDATE"]).has(privilege),
          ),
        ).toBe(true);
      }
      expect(sql.grantStatements.join("\n")).not.toMatch(
        /GRANT (?:ALL|SUPER)|GRANT (?:INSERT|UPDATE|DELETE) ON `leaderbot`\.\*/,
      );
      expect(quoteMysqlIdentifier("billing_intents")).toBe("`billing_intents`");
      expect(() => quoteMysqlIdentifier("billing`intents")).toThrow(
        "unsafe database identifier",
      );
    });

    it("constructs and validates the exact SHOW GRANTS result", () => {
      const grants = buildExpectedProvisionerGrants({
        databaseName: "leaderbot",
        username: USERNAME,
      });

      expect(grants).toHaveLength(46);
      expect(grants[0]).toBe(`GRANT USAGE ON *.* TO \`${USERNAME}\`@\`%\``);
      expect(() => assertProvisionerGrants(grants, "leaderbot")).not.toThrow();
      expect(() =>
        assertProvisionerGrants(
          [...grants, `GRANT SUPER ON *.* TO \`${USERNAME}\`@\`%\``],
          "leaderbot",
        ),
      ).toThrow("credit provisioner privilege boundary mismatch");
    });
  });

  describe("provisioner URL and GitHub secret command", () => {
    it("builds an isolated localhost MySQL URL without query or fragment", () => {
      const value = buildProvisionerUrl({
        databaseName: "leaderbot",
        password: PASSWORD,
        username: USERNAME,
      });
      const url = assertProvisionerUrl(value, {
        databaseName: "leaderbot",
        username: USERNAME,
      });

      expect(url.protocol).toBe("mysql:");
      expect(url.hostname).toBe("127.0.0.1");
      expect(url.port).toBe("13306");
      expect(url.pathname).toBe("/leaderbot");
      expect(url.username).toBe(USERNAME);
      expect(url.password).toBe(PASSWORD);
      expect(url.search).toBe("");
      expect(url.hash).toBe("");
    });

    it.each([
      ["scheme", `https://${USERNAME}:${PASSWORD}@127.0.0.1:13306/leaderbot`],
      ["host", `mysql://${USERNAME}:${PASSWORD}@localhost:13306/leaderbot`],
      ["port", `mysql://${USERNAME}:${PASSWORD}@127.0.0.1:3306/leaderbot`],
      ["database", `mysql://${USERNAME}:${PASSWORD}@127.0.0.1:13306/other`],
      ["username", `mysql://other:${PASSWORD}@127.0.0.1:13306/leaderbot`],
      ["password", `mysql://${USERNAME}@127.0.0.1:13306/leaderbot`],
      [
        "query",
        `mysql://${USERNAME}:${PASSWORD}@127.0.0.1:13306/leaderbot?ssl=1`,
      ],
      [
        "fragment",
        `mysql://${USERNAME}:${PASSWORD}@127.0.0.1:13306/leaderbot#fragment`,
      ],
    ])("rejects a URL with the wrong %s", (_label, value) => {
      expect(() =>
        assertProvisionerUrl(value, {
          databaseName: "leaderbot",
          username: USERNAME,
        }),
      ).toThrow("provisioner URL is invalid");
    });

    it("requires a non-empty expected username", () => {
      expect(() =>
        assertProvisionerUrl(`mysql://:${PASSWORD}@127.0.0.1:13306/leaderbot`, {
          databaseName: "leaderbot",
          username: "",
        }),
      ).toThrow("provisioner URL is invalid");
    });

    it("passes the secret value by stdin rather than a gh --body argument", () => {
      const args = githubSecretSetArgs(
        "Dj-Shortcut/openclaw-facebook",
        "production",
      );

      expect(args).toEqual([
        "secret",
        "set",
        "IMAGE_GEN_DATABASE_PROVISIONER_URL",
        "--repo",
        "Dj-Shortcut/openclaw-facebook",
        "--env",
        "production",
      ]);
      expect(args).not.toContain("--body");
      expect(args).not.toContain("-");
      expect(Object.isFrozen(args)).toBe(true);
    });
  });
});
