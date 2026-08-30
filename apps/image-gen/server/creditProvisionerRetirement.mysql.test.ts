import { randomBytes } from "node:crypto";

import mysql, { type Connection, type RowDataPacket } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildRetirementAttributeSql,
  CREDIT_PROVISIONER_RETIREMENT_ATTRIBUTE_KEY,
  deriveRetirementCohortSha256,
  retireImageGenCreditProvisioners,
} from "../../../scripts/retire-image-gen-credit-provisioners.mjs";

const suite = describe.runIf(
  process.env.RUN_MYSQL_INTEGRATION === "1" && Boolean(process.env.DATABASE_URL)
);

const DATABASE_APP = "leaderbot-portal-mysql";
const DATABASE_MACHINE_ID = "a".repeat(14);
const DEPLOYMENT_IDENTITY = "deploy-123-1";
const RUNTIME_PRINCIPAL_SHA256 = "a".repeat(64);
const OBSOLETE_PRINCIPAL_SHA256 = "b".repeat(64);
const SOURCE_HEAD = "c".repeat(40);
const SCHEMA_PHASE = "0018_credit_checkout_reservation";
const OBSOLETE_EVIDENCE_PATH = "/tmp/obsolete-principal/evidence.json";
const LOCK_EVIDENCE_PATH = "/tmp/credit-provisioner-lock/evidence.json";

type Evidence = Record<string, unknown>;

function quoteAccount(username: string): string {
  if (!/^lbcp_[a-f0-9]{16}$/.test(username)) {
    throw new Error("invalid test account");
  }
  return `'${username}'@'%'`;
}

function rowsToLines(rows: unknown): string[] {
  if (!Array.isArray(rows)) return [];
  return rows.map(row => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error("unexpected MySQL row");
    }
    return Object.values(row)
      .map(value => (value === null ? "NULL" : String(value)))
      .join("\t");
  });
}

function parseUserAttributes(
  value: unknown
): Record<string, { state?: unknown }> {
  const parsed =
    typeof value === "string"
      ? JSON.parse(value)
      : Buffer.isBuffer(value)
        ? JSON.parse(value.toString("utf8"))
        : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("unexpected MySQL user attributes");
  }
  return parsed as Record<string, { state?: unknown }>;
}

class LocalRootMysqlSession {
  private lockHeld = false;

  constructor(private readonly connection: Connection) {}

  async execute(sql: string): Promise<string[]> {
    const [rows] = await this.connection.query(sql);
    return rowsToLines(rows);
  }

  async initialize(): Promise<void> {
    expect(await this.execute("SELECT 1")).toEqual(["1"]);
  }

  async acquireLock(): Promise<void> {
    const result = await this.execute(
      "SELECT GET_LOCK('leaderbot_credit_provisioner_bootstrap_v1',0)"
    );
    expect(result).toEqual(["1"]);
    this.lockHeld = true;
  }

  async assertLockHeld(): Promise<void> {
    expect(
      await this.execute(
        "SELECT IS_USED_LOCK('leaderbot_credit_provisioner_bootstrap_v1')=CONNECTION_ID()"
      )
    ).toEqual(["1"]);
  }

  async close({
    releaseLock = true,
  }: { releaseLock?: boolean } = {}): Promise<void> {
    if (releaseLock && this.lockHeld) {
      await this.execute(
        "SELECT RELEASE_LOCK('leaderbot_credit_provisioner_bootstrap_v1')"
      );
      this.lockHeld = false;
    }
  }
}

suite("credit provisioner retirement on MySQL 8.4", () => {
  let connection: Connection;
  const usernames = [
    `lbcp_${randomBytes(8).toString("hex")}`,
    `lbcp_${randomBytes(8).toString("hex")}`,
  ].sort();
  const cohortSha256 = deriveRetirementCohortSha256({
    deploymentIdentity: DEPLOYMENT_IDENTITY,
    obsoletePrincipalSha256: OBSOLETE_PRINCIPAL_SHA256,
    runtimePrincipalSha256: RUNTIME_PRINCIPAL_SHA256,
  });
  const obsoleteDropEvidence = {
    deploymentIdentity: DEPLOYMENT_IDENTITY,
    mutationAt: "2026-08-28T12:00:00.000Z",
    obsoletePrincipalSha256: OBSOLETE_PRINCIPAL_SHA256,
    operation: "drop",
    runtimePrincipalSha256: RUNTIME_PRINCIPAL_SHA256,
    schemaPhase: SCHEMA_PHASE,
  };

  beforeAll(async () => {
    connection = await mysql.createConnection(process.env.DATABASE_URL!);
    const [[version]] = await connection.query<RowDataPacket[]>(
      "SELECT VERSION() AS version"
    );
    expect(version.version).toBe("8.4.11");
    for (const username of usernames) {
      await connection.query(`DROP USER IF EXISTS ${quoteAccount(username)}`);
      await connection.query(
        `CREATE USER ${quoteAccount(username)} IDENTIFIED BY 'retirement-test-only'`
      );
    }
  });

  afterAll(async () => {
    if (!connection) return;
    try {
      for (const username of usernames) {
        await connection.query(`DROP USER IF EXISTS ${quoteAccount(username)}`);
      }
    } finally {
      await connection.end();
    }
  });

  const runOperation = async (
    operation: "lock" | "unlock" | "drop",
    lockEvidence?: Evidence
  ): Promise<Evidence> =>
    retireImageGenCreditProvisioners(
      {
        databaseApp: DATABASE_APP,
        databaseMachineId: DATABASE_MACHINE_ID,
        deploymentIdentity: DEPLOYMENT_IDENTITY,
        lockEvidence: operation === "drop" ? LOCK_EVIDENCE_PATH : undefined,
        obsoleteDropEvidence: OBSOLETE_EVIDENCE_PATH,
        operation,
        runtimePrincipalSha256: RUNTIME_PRINCIPAL_SHA256,
        sourceHead: SOURCE_HEAD,
      },
      {
        createRootSession: () => new LocalRootMysqlSession(connection),
        readFile: async (filePath: string) => {
          if (filePath === OBSOLETE_EVIDENCE_PATH) {
            return JSON.stringify(obsoleteDropEvidence);
          }
          if (filePath === LOCK_EVIDENCE_PATH && lockEvidence) {
            return JSON.stringify(lockEvidence);
          }
          throw new Error("unexpected evidence path");
        },
      }
    );

  async function readAccounts(): Promise<RowDataPacket[]> {
    const [rows] = await connection.query<RowDataPacket[]>(
      `SELECT User, account_locked, User_attributes
       FROM mysql.user
       WHERE User IN (?, ?)
       ORDER BY User`,
      usernames
    );
    return rows;
  }

  it("locks, unlocks, relocks, and drops one exact cohort", async () => {
    const firstLock = await runOperation("lock");
    expect(firstLock).toMatchObject({
      cohortSha256,
      managedAccountCountAfter: 2,
      managedAccountCountBefore: 2,
      operation: "lock",
    });

    let accounts = await readAccounts();
    expect(accounts).toHaveLength(2);
    for (const account of accounts) {
      expect(account.account_locked).toBe("Y");
      expect(
        parseUserAttributes(account.User_attributes)[
          CREDIT_PROVISIONER_RETIREMENT_ATTRIBUTE_KEY
        ]
      ).toEqual({
        cohortSha256,
        contractVersion: 1,
        lockedAt: firstLock.lockedAt,
        state: "locked",
        unlockedAt: null,
      });
    }

    const unlocked = await runOperation("unlock");
    expect(unlocked).toMatchObject({
      cohortSha256,
      lockedAt: null,
      managedAccountCountAfter: 2,
      operation: "unlock",
    });
    accounts = await readAccounts();
    expect(accounts.map(account => account.account_locked)).toEqual(["N", "N"]);
    expect(
      accounts.map(
        account =>
          parseUserAttributes(account.User_attributes)[
            CREDIT_PROVISIONER_RETIREMENT_ATTRIBUTE_KEY
          ].state
      )
    ).toEqual(["unlocked", "unlocked"]);

    await new Promise(resolve => setTimeout(resolve, 5));
    const secondLock = await runOperation("lock");
    expect(secondLock.lockedAt).not.toBe(firstLock.lockedAt);

    const [[oldTime]] = await connection.query<RowDataPacket[]>(
      "SELECT DATE_FORMAT(UTC_TIMESTAMP(6)-INTERVAL 25 HOUR,'%Y-%m-%dT%H:%i:%s.%fZ') AS value"
    );
    const oldLockedAt = String(oldTime.value);
    const oldLockedAttribute = {
      cohortSha256,
      contractVersion: 1,
      lockedAt: oldLockedAt,
      state: "locked",
      unlockedAt: null,
    };
    for (const username of usernames) {
      await connection.query(
        buildRetirementAttributeSql(
          { hostname: "%", username },
          oldLockedAttribute
        )
      );
    }
    const agedLockEvidence = {
      ...secondLock,
      lockedAt: oldLockedAt,
      mutationAt: oldLockedAt,
    };

    const dropped = await runOperation("drop", agedLockEvidence);
    expect(dropped).toMatchObject({
      cohortSha256,
      lockedAt: oldLockedAt,
      managedAccountCountAfter: 0,
      managedAccountCountBefore: 2,
      operation: "drop",
    });
    expect(await readAccounts()).toEqual([]);

    await expect(runOperation("drop", agedLockEvidence)).resolves.toMatchObject(
      {
        managedAccountCountAfter: 0,
        managedAccountCountBefore: 2,
        operation: "drop",
      }
    );
  });
});
