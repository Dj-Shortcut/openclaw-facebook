import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  CREDIT_PROVISIONER_RETIREMENT_ATTRIBUTE_KEY,
  CREDIT_PROVISIONER_RETIREMENT_ACTIVE_SESSION_QUERY,
  CREDIT_PROVISIONER_RETIREMENT_DATABASE_TIME_QUERY,
  CREDIT_PROVISIONER_RETIREMENT_DROPPED_MARKER,
  CREDIT_PROVISIONER_RETIREMENT_FAILURE_MARKER,
  CREDIT_PROVISIONER_RETIREMENT_INVENTORY_QUERY,
  CREDIT_PROVISIONER_RETIREMENT_LOCKED_MARKER,
  CREDIT_PROVISIONER_RETIREMENT_LOCK_NAME,
  CREDIT_PROVISIONER_RETIREMENT_MAX_ACCOUNTS,
  CREDIT_PROVISIONER_RETIREMENT_UNLOCKED_MARKER,
  assertLockEvidence,
  assertObsoletePrincipalDropEvidence,
  assertRetirementEvidence,
  buildRetirementAttributeSql,
  deriveRetirementCohortSha256,
  deriveRetirementMembersSha256,
  parseRetirementCliArguments,
  parseRetirementInventoryRows,
  retireImageGenCreditProvisioners,
  runRetirementCli,
} from "./retire-image-gen-credit-provisioners.mjs";
import { CREDIT_PROVISIONER_LOCK_NAME } from "./image-gen-credit-provisioner-bootstrap-contract.mjs";

const SOURCE_HEAD = "a".repeat(40);
const RUNTIME_SHA256 = "b".repeat(64);
const OBSOLETE_SHA256 = "c".repeat(64);
const FOREIGN_SHA256 = "d".repeat(64);
const DEPLOYMENT_IDENTITY = "deploy-123-1";
const DATABASE_APP = "leaderbot-portal-mysql";
const DATABASE_MACHINE = "28607e7c932038";
const OBSOLETE_EVIDENCE_PATH = "/tmp/obsolete-drop/evidence.json";
const LOCK_EVIDENCE_PATH = "/tmp/retirement-lock/evidence.json";
const OUTPUT_PATH = "/tmp/retirement-output/evidence.json";
const T0 = "2026-08-30T00:00:00.000000Z";
const T1 = "2026-08-30T01:00:00.000000Z";
const T2 = "2026-08-30T02:00:00.000000Z";
const DROP_NOW = "2026-08-31T02:00:00.000000Z";
const DROP_DONE = "2026-08-31T02:00:00.000001Z";
const MANAGED_ACCOUNTS = [
  { hostname: "%", username: "lbcp_0123456789abcdef" },
  { hostname: "%", username: "lbcp_fedcba9876543210" },
];
const MEMBERS_SHA256 = deriveRetirementMembersSha256(MANAGED_ACCOUNTS);

function context(overrides = {}) {
  return {
    databaseApp: DATABASE_APP,
    databaseMachineId: DATABASE_MACHINE,
    databaseName: "leaderbot",
    deploymentIdentity: DEPLOYMENT_IDENTITY,
    obsoletePrincipalSha256: OBSOLETE_SHA256,
    runtimePrincipalSha256: RUNTIME_SHA256,
    sourceHead: SOURCE_HEAD,
    ...overrides,
  };
}

function obsoleteDropEvidence(overrides = {}) {
  return {
    deploymentIdentity: DEPLOYMENT_IDENTITY,
    mutationAt: "2026-08-29T00:00:00.000Z",
    obsoletePrincipalSha256: OBSOLETE_SHA256,
    operation: "drop",
    runtimePrincipalSha256: RUNTIME_SHA256,
    schemaPhase: "0018_credit_checkout_reservation",
    ...overrides,
  };
}

function retirementAttribute({
  cohortSha256 = deriveRetirementCohortSha256(context()),
  lockedAt = T0,
  membersSha256 = MEMBERS_SHA256,
  state = "locked",
  unlockedAt = null,
} = {}) {
  return {
    cohortSha256,
    contractVersion: 1,
    lockedAt,
    membersSha256,
    state,
    unlockedAt,
  };
}

function lockEvidence(overrides = {}) {
  return {
    cohortSha256: deriveRetirementCohortSha256(context()),
    contractVersion: 1,
    deploymentIdentity: DEPLOYMENT_IDENTITY,
    lockedAt: T0,
    managedAccountCountAfter: 2,
    managedAccountCountBefore: 2,
    membersSha256: MEMBERS_SHA256,
    mutationAt: T0,
    obsoletePrincipalSha256: OBSOLETE_SHA256,
    operation: "lock",
    runtimePrincipalSha256: RUNTIME_SHA256,
    schemaPhase: "0018_credit_checkout_reservation",
    sourceHead: SOURCE_HEAD,
    ...overrides,
  };
}

function hexAttributes(attributes) {
  return Buffer.from(JSON.stringify(attributes), "utf8").toString("hex");
}

function inventoryLine({
  accountLocked = "N",
  attributes = {},
  hostname = "%",
  username = "lbcp_0123456789abcdef",
} = {}) {
  return `${username}\t${hostname}\t${accountLocked}\t${hexAttributes(attributes)}`;
}

function createDatabase({
  accounts = ["lbcp_0123456789abcdef", "lbcp_fedcba9876543210"],
  activeSessions = [],
  times = [T0],
} = {}) {
  return {
    activeSessions: [...activeSessions],
    accounts: new Map(
      accounts.map((username) => [
        username,
        { accountLocked: "N", attributes: {} },
      ]),
    ),
    calls: [],
    failAfterMutation: undefined,
    failOnMutation: undefined,
    mutationCount: 0,
    sessions: [],
    times: [...times],
  };
}

function markDatabaseCohortLocked(database) {
  for (const account of database.accounts.values()) {
    account.accountLocked = "Y";
    account.attributes[CREDIT_PROVISIONER_RETIREMENT_ATTRIBUTE_KEY] =
      retirementAttribute();
  }
  return database;
}

function accountFromPrincipal(value) {
  const match = /^'(lbcp_[a-f0-9]{16})'@'%'$/.exec(value);
  if (!match) throw new Error("unexpected test principal");
  return match[1];
}

class FakeRootSession {
  constructor(database) {
    this.database = database;
    this.lockHeld = false;
    database.sessions.push(this);
  }

  async initialize() {
    this.database.calls.push("initialize");
  }

  async acquireLock() {
    this.database.calls.push("acquire-lock");
    if (this.lockHeld) throw new Error("synthetic lock contention");
    this.lockHeld = true;
  }

  async assertLockHeld() {
    this.database.calls.push("assert-lock");
    if (!this.lockHeld) throw new Error("synthetic missing lock");
  }

  async execute(sql) {
    this.database.calls.push(sql);
    if (sql === CREDIT_PROVISIONER_RETIREMENT_INVENTORY_QUERY) {
      return [...this.database.accounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(
          ([username, value]) =>
            `${username}\t%\t${value.accountLocked}\t${hexAttributes(value.attributes)}`,
        );
    }
    if (sql === CREDIT_PROVISIONER_RETIREMENT_ACTIVE_SESSION_QUERY) {
      return [...this.database.activeSessions];
    }
    if (sql === CREDIT_PROVISIONER_RETIREMENT_DATABASE_TIME_QUERY) {
      const value = this.database.times.shift();
      if (!value) throw new Error("synthetic missing database time");
      return [value];
    }
    if (!this.lockHeld) throw new Error("synthetic unlocked mutation");
    this.database.mutationCount += 1;
    if (this.database.mutationCount === this.database.failOnMutation) {
      throw new Error("synthetic mutation failure");
    }
    const failAfterAppliedMutation = () => {
      if (this.database.mutationCount === this.database.failAfterMutation) {
        throw new Error("synthetic committed mutation response loss");
      }
    };
    const attributeMatch =
      /^ALTER USER ('lbcp_[a-f0-9]{16}'@'%') ATTRIBUTE '(.+)'$/.exec(sql);
    if (attributeMatch) {
      const username = accountFromPrincipal(attributeMatch[1]);
      const account = this.database.accounts.get(username);
      if (!account) throw new Error("synthetic missing account");
      account.attributes = {
        ...account.attributes,
        ...JSON.parse(attributeMatch[2]),
      };
      failAfterAppliedMutation();
      return [];
    }
    const stateMatch =
      /^ALTER USER ('lbcp_[a-f0-9]{16}'@'%') ACCOUNT (LOCK|UNLOCK)$/.exec(sql);
    if (stateMatch) {
      const account = this.database.accounts.get(
        accountFromPrincipal(stateMatch[1]),
      );
      if (!account) throw new Error("synthetic missing account");
      account.accountLocked = stateMatch[2] === "LOCK" ? "Y" : "N";
      failAfterAppliedMutation();
      return [];
    }
    if (sql.startsWith("DROP USER ")) {
      const principals = [...sql.matchAll(/'lbcp_[a-f0-9]{16}'@'%'/g)].map(
        (match) => accountFromPrincipal(match[0]),
      );
      if (principals.length === 0) throw new Error("synthetic empty drop");
      for (const username of principals)
        this.database.accounts.delete(username);
      failAfterAppliedMutation();
      return [];
    }
    throw new Error("unexpected test SQL");
  }

  async close({ releaseLock }) {
    this.database.calls.push(`close-${releaseLock}`);
    this.lockHeld = false;
  }
}

function dependencies(database, evidence = {}) {
  const values = new Map([
    [OBSOLETE_EVIDENCE_PATH, obsoleteDropEvidence()],
    ...Object.entries(evidence),
  ]);
  return {
    createRootSession: () => new FakeRootSession(database),
    async readFile(filePath) {
      if (!values.has(filePath)) throw new Error("synthetic missing evidence");
      return `${JSON.stringify(values.get(filePath))}\n`;
    },
  };
}

function operationInput(operation, overrides = {}) {
  return {
    ...context(),
    obsoleteDropEvidence: OBSOLETE_EVIDENCE_PATH,
    operation,
    ...(operation === "drop" ? { lockEvidence: LOCK_EVIDENCE_PATH } : {}),
    ...overrides,
  };
}

function cliArguments(operation, overrides = {}) {
  const values = {
    "--database-app": DATABASE_APP,
    "--database-machine": DATABASE_MACHINE,
    "--evidence-out": OUTPUT_PATH,
    "--expected-deployment-identity": DEPLOYMENT_IDENTITY,
    "--expected-head": SOURCE_HEAD,
    "--expected-runtime-principal-sha256": RUNTIME_SHA256,
    "--obsolete-drop-evidence": OBSOLETE_EVIDENCE_PATH,
    "--operation": operation,
    ...(operation === "drop" ? { "--lock-evidence": LOCK_EVIDENCE_PATH } : {}),
    ...overrides,
  };
  return Object.entries(values).flat();
}

describe("image-gen credit provisioner retirement", () => {
  it("shares the bootstrap advisory lock and pins the bounded namespace", () => {
    expect(CREDIT_PROVISIONER_RETIREMENT_LOCK_NAME).toBe(
      CREDIT_PROVISIONER_LOCK_NAME,
    );
    expect(CREDIT_PROVISIONER_RETIREMENT_MAX_ACCOUNTS).toBe(16);
    expect(CREDIT_PROVISIONER_RETIREMENT_INVENTORY_QUERY).toContain(
      "User LIKE 'lbcp\\\\_%' ESCAPE '\\\\'",
    );
  });

  it("derives one deterministic cohort from only reviewed retirement state", () => {
    const first = deriveRetirementCohortSha256(context());
    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(deriveRetirementCohortSha256(context())).toBe(first);
    expect(
      deriveRetirementCohortSha256(
        context({ deploymentIdentity: "deploy-124-1" }),
      ),
    ).not.toBe(first);
    expect(() =>
      deriveRetirementCohortSha256(
        context({ obsoletePrincipalSha256: RUNTIME_SHA256 }),
      ),
    ).toThrow("credit provisioner retirement rejected");
    expect(deriveRetirementMembersSha256(MANAGED_ACCOUNTS)).toBe(
      MEMBERS_SHA256,
    );
    expect(deriveRetirementMembersSha256([...MANAGED_ACCOUNTS].reverse())).toBe(
      MEMBERS_SHA256,
    );
    expect(
      deriveRetirementMembersSha256([
        MANAGED_ACCOUNTS[0],
        { hostname: "%", username: "lbcp_1111111111111111" },
      ]),
    ).not.toBe(MEMBERS_SHA256);
  });

  it("accepts only the exact operation-specific CLI", () => {
    expect(parseRetirementCliArguments(cliArguments("lock"))).toMatchObject({
      databaseApp: DATABASE_APP,
      databaseMachineId: DATABASE_MACHINE,
      databaseName: "leaderbot",
      deploymentIdentity: DEPLOYMENT_IDENTITY,
      evidenceOutput: OUTPUT_PATH,
      obsoleteDropEvidence: OBSOLETE_EVIDENCE_PATH,
      operation: "lock",
      runtimePrincipalSha256: RUNTIME_SHA256,
      sourceHead: SOURCE_HEAD,
    });
    expect(parseRetirementCliArguments(cliArguments("drop"))).toMatchObject({
      lockEvidence: LOCK_EVIDENCE_PATH,
      operation: "drop",
    });
    expect(() =>
      parseRetirementCliArguments([
        ...cliArguments("lock"),
        "--lock-evidence",
        LOCK_EVIDENCE_PATH,
      ]),
    ).toThrow();
    expect(() =>
      parseRetirementCliArguments(
        cliArguments("drop", { "--lock-evidence": undefined }),
      ),
    ).toThrow();
    expect(() =>
      parseRetirementCliArguments(
        cliArguments("lock", { "--database-app": "other-app" }),
      ),
    ).toThrow();
    expect(() =>
      parseRetirementCliArguments(
        cliArguments("lock", { "--evidence-out": "evidence.json" }),
      ),
    ).toThrow();
  });

  it("validates the exact obsolete-principal drop evidence contract", () => {
    expect(
      assertObsoletePrincipalDropEvidence(obsoleteDropEvidence(), context()),
    ).toEqual(obsoleteDropEvidence());
    expect(() =>
      assertObsoletePrincipalDropEvidence(
        obsoleteDropEvidence({ operation: "lock" }),
        context(),
      ),
    ).toThrow();
    expect(() =>
      assertObsoletePrincipalDropEvidence(
        { ...obsoleteDropEvidence(), unexpected: true },
        context(),
      ),
    ).toThrow();
  });

  it("parses exact accounts, lock state, and MySQL User_attributes", () => {
    const attribute = retirementAttribute();
    const rows = parseRetirementInventoryRows([
      inventoryLine({
        accountLocked: "Y",
        attributes: {
          unrelated: { retained: true },
          [CREDIT_PROVISIONER_RETIREMENT_ATTRIBUTE_KEY]: attribute,
        },
      }),
    ]);
    expect(rows).toEqual([
      {
        account: { hostname: "%", username: "lbcp_0123456789abcdef" },
        accountLocked: "Y",
        attributes: {
          unrelated: { retained: true },
          [CREDIT_PROVISIONER_RETIREMENT_ATTRIBUTE_KEY]: attribute,
        },
        retirement: attribute,
      },
    ]);
    expect(() =>
      parseRetirementInventoryRows([inventoryLine({ hostname: "localhost" })]),
    ).toThrow();
    expect(() =>
      parseRetirementInventoryRows([inventoryLine(), inventoryLine()]),
    ).toThrow();
    expect(() =>
      parseRetirementInventoryRows(
        Array.from(
          { length: CREDIT_PROVISIONER_RETIREMENT_MAX_ACCOUNTS + 1 },
          (_, index) =>
            inventoryLine({
              username: `lbcp_${index.toString(16).padStart(16, "0")}`,
            }),
        ),
      ),
    ).toThrow();
  });

  it("builds an attribute patch only after strict identity and shape checks", () => {
    const sql = buildRetirementAttributeSql(
      { hostname: "%", username: "lbcp_0123456789abcdef" },
      retirementAttribute(),
    );
    expect(sql).toContain(
      `ALTER USER 'lbcp_0123456789abcdef'@'%' ATTRIBUTE '{"${CREDIT_PROVISIONER_RETIREMENT_ATTRIBUTE_KEY}":`,
    );
    expect(() =>
      buildRetirementAttributeSql(
        { hostname: "%", username: "root" },
        retirementAttribute(),
      ),
    ).toThrow();
    expect(() =>
      buildRetirementAttributeSql(
        { hostname: "%", username: "lbcp_0123456789abcdef" },
        { ...retirementAttribute(), extra: true },
      ),
    ).toThrow();
  });

  it("locks every account under one DB timestamp before returning evidence", async () => {
    const database = createDatabase({ times: [T0] });
    const evidence = await retireImageGenCreditProvisioners(
      operationInput("lock"),
      dependencies(database),
    );

    expect(evidence).toEqual(lockEvidence());
    expect(database.calls.indexOf("acquire-lock")).toBeLessThan(
      database.calls.indexOf(CREDIT_PROVISIONER_RETIREMENT_INVENTORY_QUERY),
    );
    expect(database.calls.at(-1)).toBe("close-true");
    for (const account of database.accounts.values()) {
      expect(account.accountLocked).toBe("Y");
      expect(
        account.attributes[CREDIT_PROVISIONER_RETIREMENT_ATTRIBUTE_KEY],
      ).toEqual(retirementAttribute());
    }
    expect(JSON.stringify(evidence)).not.toMatch(/lbcp_|User_attributes|GRANT/);
  });

  it("replays a partially applied lock and restarts the common lock time", async () => {
    const database = createDatabase({ times: [T1] });
    const firstPartial = database.accounts.get("lbcp_0123456789abcdef");
    firstPartial.attributes[CREDIT_PROVISIONER_RETIREMENT_ATTRIBUTE_KEY] = {
      ...retirementAttribute({ lockedAt: null, state: "locking" }),
    };
    const partial = database.accounts.get("lbcp_fedcba9876543210");
    partial.accountLocked = "Y";
    partial.attributes[CREDIT_PROVISIONER_RETIREMENT_ATTRIBUTE_KEY] = {
      ...retirementAttribute({ lockedAt: null, state: "locking" }),
    };

    const evidence = await retireImageGenCreditProvisioners(
      operationInput("lock"),
      dependencies(database),
    );

    expect(evidence.lockedAt).toBe(T1);
    expect(
      [...database.accounts.values()].every(
        (account) =>
          account.attributes[CREDIT_PROVISIONER_RETIREMENT_ATTRIBUTE_KEY]
            .lockedAt === T1,
      ),
    ).toBe(true);
  });

  it("refuses to adopt a locked managed account without cohort evidence", async () => {
    const database = createDatabase({ times: [T1] });
    database.accounts.get("lbcp_0123456789abcdef").accountLocked = "Y";

    await expect(
      retireImageGenCreditProvisioners(
        operationInput("lock"),
        dependencies(database),
      ),
    ).rejects.toThrow();
    expect(database.mutationCount).toBe(0);
  });

  it("closes the root session after interruption and permits an exact lock replay", async () => {
    const database = createDatabase({ times: [T1] });
    database.failOnMutation = 3;
    await expect(
      retireImageGenCreditProvisioners(
        operationInput("lock"),
        dependencies(database),
      ),
    ).rejects.toThrow();
    expect(database.calls.at(-1)).toBe("close-true");

    database.failOnMutation = undefined;
    database.mutationCount = 0;
    const evidence = await retireImageGenCreditProvisioners(
      operationInput("lock"),
      dependencies(database),
    );
    expect(evidence.operation).toBe("lock");
    expect(evidence.lockedAt).toBe(T1);
  });

  it("converges when ACCOUNT LOCK commits before its response is lost", async () => {
    const database = createDatabase({ times: [T1] });
    database.failAfterMutation = 2;
    await expect(
      retireImageGenCreditProvisioners(
        operationInput("lock"),
        dependencies(database),
      ),
    ).rejects.toThrow();
    expect(database.accounts.get("lbcp_0123456789abcdef").accountLocked).toBe(
      "Y",
    );

    database.failAfterMutation = undefined;
    database.mutationCount = 0;
    await expect(
      retireImageGenCreditProvisioners(
        operationInput("lock"),
        dependencies(database),
      ),
    ).resolves.toMatchObject({ lockedAt: T1, operation: "lock" });
  });

  it("converges when final lock metadata commits before response loss", async () => {
    const database = createDatabase({ times: [T0, T1] });
    database.failAfterMutation = 5;
    await expect(
      retireImageGenCreditProvisioners(
        operationInput("lock"),
        dependencies(database),
      ),
    ).rejects.toThrow();

    database.failAfterMutation = undefined;
    database.mutationCount = 0;
    await expect(
      retireImageGenCreditProvisioners(
        operationInput("lock"),
        dependencies(database),
      ),
    ).resolves.toMatchObject({ lockedAt: T1, operation: "lock" });
  });

  it("rejects a foreign cohort before any account mutation", async () => {
    const database = createDatabase({ times: [T0] });
    database.accounts.get("lbcp_0123456789abcdef").attributes[
      CREDIT_PROVISIONER_RETIREMENT_ATTRIBUTE_KEY
    ] = retirementAttribute({ cohortSha256: FOREIGN_SHA256 });

    await expect(
      retireImageGenCreditProvisioners(
        operationInput("lock"),
        dependencies(database),
      ),
    ).rejects.toThrow();
    expect(database.mutationCount).toBe(0);
  });

  it("unlocks only the complete current cohort and preserves recovery metadata", async () => {
    const database = createDatabase({ times: [T0, T1] });
    const locked = await retireImageGenCreditProvisioners(
      operationInput("lock"),
      dependencies(database),
    );
    const unlocked = await retireImageGenCreditProvisioners(
      operationInput("unlock"),
      dependencies(database),
    );

    expect(locked.operation).toBe("lock");
    expect(unlocked).toMatchObject({
      lockedAt: null,
      managedAccountCountAfter: 2,
      managedAccountCountBefore: 2,
      mutationAt: T1,
      operation: "unlock",
    });
    for (const account of database.accounts.values()) {
      expect(account.accountLocked).toBe("N");
      expect(
        account.attributes[CREDIT_PROVISIONER_RETIREMENT_ATTRIBUTE_KEY],
      ).toEqual(
        retirementAttribute({
          lockedAt: T0,
          state: "unlocked",
          unlockedAt: T1,
        }),
      );
    }
  });

  it("replays an interrupted unlock without widening its cohort", async () => {
    const database = createDatabase({ times: [T0, T1] });
    await retireImageGenCreditProvisioners(
      operationInput("lock"),
      dependencies(database),
    );
    database.mutationCount = 0;
    database.failOnMutation = 3;
    await expect(
      retireImageGenCreditProvisioners(
        operationInput("unlock"),
        dependencies(database),
      ),
    ).rejects.toThrow();
    expect(
      [...database.accounts.values()].map((account) => account.accountLocked),
    ).toEqual(["N", "Y"]);

    database.mutationCount = 0;
    database.failOnMutation = undefined;
    const evidence = await retireImageGenCreditProvisioners(
      operationInput("unlock"),
      dependencies(database),
    );
    expect(evidence).toMatchObject({ mutationAt: T1, operation: "unlock" });
    expect(
      [...database.accounts.values()].every(
        (account) => account.accountLocked === "N",
      ),
    ).toBe(true);
  });

  it("converges when ACCOUNT UNLOCK commits before response loss", async () => {
    const database = createDatabase({ times: [T0, T1] });
    await retireImageGenCreditProvisioners(
      operationInput("lock"),
      dependencies(database),
    );
    database.mutationCount = 0;
    database.failAfterMutation = 2;
    await expect(
      retireImageGenCreditProvisioners(
        operationInput("unlock"),
        dependencies(database),
      ),
    ).rejects.toThrow();
    expect(database.accounts.get("lbcp_0123456789abcdef").accountLocked).toBe(
      "N",
    );

    database.failAfterMutation = undefined;
    database.mutationCount = 0;
    await expect(
      retireImageGenCreditProvisioners(
        operationInput("unlock"),
        dependencies(database),
      ),
    ).resolves.toMatchObject({ mutationAt: T1, operation: "unlock" });
  });

  it("refuses empty first-use lock and unattributed unlock", async () => {
    await expect(
      retireImageGenCreditProvisioners(
        operationInput("lock"),
        dependencies(createDatabase({ accounts: [] })),
      ),
    ).rejects.toThrow();
    await expect(
      retireImageGenCreditProvisioners(
        operationInput("unlock"),
        dependencies(createDatabase()),
      ),
    ).rejects.toThrow();
  });

  it("refuses to mutate while a managed provisioner session is active", async () => {
    const database = createDatabase({
      activeSessions: ["lbcp_0123456789abcdef"],
    });
    await expect(
      retireImageGenCreditProvisioners(
        operationInput("lock"),
        dependencies(database),
      ),
    ).rejects.toThrow();
    expect(database.mutationCount).toBe(0);

    database.activeSessions = [];
    await expect(
      retireImageGenCreditProvisioners(
        operationInput("lock"),
        dependencies(database),
      ),
    ).resolves.toMatchObject({ operation: "lock" });
  });

  it("invalidates old lock evidence after unlock and relock", async () => {
    const database = createDatabase({ times: [T0, T1, T2] });
    const oldLock = await retireImageGenCreditProvisioners(
      operationInput("lock"),
      dependencies(database),
    );
    await retireImageGenCreditProvisioners(
      operationInput("unlock"),
      dependencies(database),
    );
    const newLock = await retireImageGenCreditProvisioners(
      operationInput("lock"),
      dependencies(database),
    );
    database.times.push(DROP_NOW);

    await expect(
      retireImageGenCreditProvisioners(
        operationInput("drop"),
        dependencies(database, { [LOCK_EVIDENCE_PATH]: oldLock }),
      ),
    ).rejects.toThrow();
    expect(database.accounts.size).toBe(2);
    expect(newLock.lockedAt).toBe(T2);
  });

  it("refuses to publish a reused or regressed lock timestamp", async () => {
    const database = createDatabase({ times: [T0, T0, T0] });
    await retireImageGenCreditProvisioners(
      operationInput("lock"),
      dependencies(database),
    );
    await expect(
      retireImageGenCreditProvisioners(
        operationInput("lock"),
        dependencies(database),
      ),
    ).rejects.toThrow();
    expect(
      [...database.accounts.values()].every(
        (account) =>
          account.attributes[CREDIT_PROVISIONER_RETIREMENT_ATTRIBUTE_KEY]
            .state === "locking" &&
          account.attributes[CREDIT_PROVISIONER_RETIREMENT_ATTRIBUTE_KEY]
            .lockedAt === T0,
      ),
    ).toBe(true);
    await expect(
      retireImageGenCreditProvisioners(
        operationInput("lock"),
        dependencies(database),
      ),
    ).rejects.toThrow();
  });

  it("drops the exact locked cohort after the DB-backed window", async () => {
    const database = createDatabase({ times: [T0] });
    const locked = await retireImageGenCreditProvisioners(
      operationInput("lock"),
      dependencies(database),
    );
    database.times.push(DROP_NOW, DROP_DONE);
    const dropped = await retireImageGenCreditProvisioners(
      operationInput("drop"),
      dependencies(database, { [LOCK_EVIDENCE_PATH]: locked }),
    );

    expect(dropped).toMatchObject({
      lockedAt: T0,
      managedAccountCountAfter: 0,
      managedAccountCountBefore: 2,
      mutationAt: DROP_DONE,
      operation: "drop",
    });
    expect(database.accounts.size).toBe(0);
    const dropSql = database.calls.find(
      (call) => typeof call === "string" && call.startsWith("DROP USER "),
    );
    expect(dropSql).toBe(
      "DROP USER 'lbcp_0123456789abcdef'@'%', 'lbcp_fedcba9876543210'@'%'",
    );
  });

  it("converges when DROP USER commits before its response is lost", async () => {
    const database = markDatabaseCohortLocked(
      createDatabase({ times: [DROP_NOW, DROP_DONE, DROP_DONE] }),
    );
    database.failAfterMutation = 1;
    await expect(
      retireImageGenCreditProvisioners(
        operationInput("drop"),
        dependencies(database, {
          [LOCK_EVIDENCE_PATH]: lockEvidence(),
        }),
      ),
    ).rejects.toThrow();
    expect(database.accounts.size).toBe(0);

    database.failAfterMutation = undefined;
    database.mutationCount = 0;
    await expect(
      retireImageGenCreditProvisioners(
        operationInput("drop"),
        dependencies(database, {
          [LOCK_EVIDENCE_PATH]: lockEvidence(),
        }),
      ),
    ).resolves.toMatchObject({ operation: "drop" });
    expect(database.mutationCount).toBe(0);
  });

  it("accepts only the inclusive 24-hour through 30-day drop window", async () => {
    const scenarios = [
      ["2026-08-30T23:59:59.999999Z", false],
      ["2026-08-31T00:00:00.000000Z", true],
      ["2026-09-29T00:00:00.000000Z", true],
      ["2026-09-29T00:00:00.001000Z", false],
    ];
    for (const [databaseNow, accepted] of scenarios) {
      const database = markDatabaseCohortLocked(
        createDatabase({ times: [databaseNow] }),
      );
      if (accepted) database.times.push(databaseNow);
      const run = retireImageGenCreditProvisioners(
        operationInput("drop"),
        dependencies(database, {
          [LOCK_EVIDENCE_PATH]: lockEvidence(),
        }),
      );
      if (accepted)
        await expect(run).resolves.toMatchObject({ operation: "drop" });
      else await expect(run).rejects.toThrow();
    }
  });

  it("recovers a completed drop only with the same exact lock evidence", async () => {
    const database = createDatabase({
      accounts: [],
      times: [DROP_NOW, DROP_DONE],
    });
    const dropped = await retireImageGenCreditProvisioners(
      operationInput("drop"),
      dependencies(database, {
        [LOCK_EVIDENCE_PATH]: lockEvidence(),
      }),
    );
    expect(dropped).toMatchObject({
      managedAccountCountAfter: 0,
      managedAccountCountBefore: 2,
      operation: "drop",
    });
    expect(
      database.calls.some((call) => String(call).startsWith("DROP USER")),
    ).toBe(false);
  });

  it("recovers completed drop evidence even after the new-drop window", async () => {
    const database = createDatabase({
      accounts: [],
      times: ["2026-10-30T00:00:00.000000Z", "2026-10-30T00:00:00.000001Z"],
    });
    await expect(
      retireImageGenCreditProvisioners(
        operationInput("drop"),
        dependencies(database, {
          [LOCK_EVIDENCE_PATH]: lockEvidence(),
        }),
      ),
    ).resolves.toMatchObject({
      managedAccountCountAfter: 0,
      managedAccountCountBefore: 2,
      operation: "drop",
    });
    expect(database.mutationCount).toBe(0);
  });

  it("does not certify an empty replay before the minimum lock window", async () => {
    const database = createDatabase({
      accounts: [],
      times: ["2026-08-30T23:59:59.999999Z"],
    });
    await expect(
      retireImageGenCreditProvisioners(
        operationInput("drop"),
        dependencies(database, {
          [LOCK_EVIDENCE_PATH]: lockEvidence(),
        }),
      ),
    ).rejects.toThrow();
    expect(database.mutationCount).toBe(0);
  });

  it("keeps a new drop blocked after the maximum window", async () => {
    const database = markDatabaseCohortLocked(
      createDatabase({ times: ["2026-10-30T00:00:00.000000Z"] }),
    );
    await expect(
      retireImageGenCreditProvisioners(
        operationInput("drop"),
        dependencies(database, {
          [LOCK_EVIDENCE_PATH]: lockEvidence(),
        }),
      ),
    ).rejects.toThrow();
    expect(database.accounts.size).toBe(2);
    expect(database.mutationCount).toBe(0);
  });

  it("rejects changed membership, unlocked accounts, and stale evidence", async () => {
    const cohortSha256 = deriveRetirementCohortSha256(context());
    for (const mutate of [
      (database) =>
        database.accounts.set("lbcp_1111111111111111", {
          accountLocked: "Y",
          attributes: {
            [CREDIT_PROVISIONER_RETIREMENT_ATTRIBUTE_KEY]:
              retirementAttribute(),
          },
        }),
      (database) => {
        database.accounts.get("lbcp_0123456789abcdef").accountLocked = "N";
      },
      (database) => {
        database.accounts.get("lbcp_0123456789abcdef").attributes[
          CREDIT_PROVISIONER_RETIREMENT_ATTRIBUTE_KEY
        ] = retirementAttribute({ cohortSha256: FOREIGN_SHA256 });
      },
    ]) {
      const database = createDatabase({ times: [DROP_NOW] });
      for (const account of database.accounts.values()) {
        account.accountLocked = "Y";
        account.attributes[CREDIT_PROVISIONER_RETIREMENT_ATTRIBUTE_KEY] =
          retirementAttribute({ cohortSha256 });
      }
      mutate(database);
      await expect(
        retireImageGenCreditProvisioners(
          operationInput("drop"),
          dependencies(database, {
            [LOCK_EVIDENCE_PATH]: lockEvidence(),
          }),
        ),
      ).rejects.toThrow();
      expect(
        database.calls.some((call) => String(call).startsWith("DROP USER")),
      ).toBe(false);
    }
  });

  it("rejects a same-count replacement carrying copied cohort metadata", async () => {
    const database = markDatabaseCohortLocked(
      createDatabase({ times: [DROP_NOW] }),
    );
    database.accounts.delete("lbcp_fedcba9876543210");
    database.accounts.set("lbcp_1111111111111111", {
      accountLocked: "Y",
      attributes: {
        [CREDIT_PROVISIONER_RETIREMENT_ATTRIBUTE_KEY]: retirementAttribute(),
      },
    });

    await expect(
      retireImageGenCreditProvisioners(
        operationInput("drop"),
        dependencies(database, {
          [LOCK_EVIDENCE_PATH]: lockEvidence(),
        }),
      ),
    ).rejects.toThrow();
    expect(database.accounts.size).toBe(2);
    expect(database.mutationCount).toBe(0);
  });

  it("requires exact metadata-only lock and operation evidence", () => {
    expect(() => assertRetirementEvidence(lockEvidence())).not.toThrow();
    expect(() =>
      assertLockEvidence(lockEvidence(), {
        ...context(),
        cohortSha256: deriveRetirementCohortSha256(context()),
      }),
    ).not.toThrow();
    expect(() =>
      assertRetirementEvidence({ ...lockEvidence(), account: "lbcp_secret" }),
    ).toThrow();
    expect(() =>
      assertRetirementEvidence({
        ...lockEvidence(),
        managedAccountCountAfter: 17,
        managedAccountCountBefore: 17,
      }),
    ).toThrow();
  });

  it("emits only fixed CLI markers and writes evidence before success", async () => {
    const output = [];
    const writes = [];
    const evidence = lockEvidence();
    await expect(
      runRetirementCli(cliArguments("lock"), {
        output: (value) => output.push(value),
        retire: async () => evidence,
        writeEvidence: async (...args) => writes.push(args),
      }),
    ).resolves.toBe(CREDIT_PROVISIONER_RETIREMENT_LOCKED_MARKER);
    expect(writes).toEqual([[OUTPUT_PATH, evidence]]);
    expect(output).toEqual([CREDIT_PROVISIONER_RETIREMENT_LOCKED_MARKER]);

    const failedOutput = [];
    await expect(
      runRetirementCli(cliArguments("lock"), {
        output: (value) => failedOutput.push(value),
        retire: async () => {
          throw new Error("dynamic secret account SQL detail");
        },
        writeEvidence: vi.fn(),
      }),
    ).resolves.toBe(CREDIT_PROVISIONER_RETIREMENT_FAILURE_MARKER);
    expect(failedOutput).toEqual([
      CREDIT_PROVISIONER_RETIREMENT_FAILURE_MARKER,
    ]);
    expect(
      new Set([
        CREDIT_PROVISIONER_RETIREMENT_LOCKED_MARKER,
        CREDIT_PROVISIONER_RETIREMENT_UNLOCKED_MARKER,
        CREDIT_PROVISIONER_RETIREMENT_DROPPED_MARKER,
      ]).size,
    ).toBe(3);
  });

  it("reconciles a dropped cohort after the first evidence write fails", async () => {
    const database = markDatabaseCohortLocked(
      createDatabase({ times: [DROP_NOW, DROP_DONE] }),
    );
    const output = [];
    const deps = dependencies(database, {
      [LOCK_EVIDENCE_PATH]: lockEvidence(),
    });
    const retire = (input) => retireImageGenCreditProvisioners(input, deps);

    await expect(
      runRetirementCli(cliArguments("drop"), {
        output: (value) => output.push(value),
        retire,
        writeEvidence: async () => {
          throw new Error("synthetic evidence storage failure");
        },
      }),
    ).resolves.toBe(CREDIT_PROVISIONER_RETIREMENT_FAILURE_MARKER);
    expect(database.accounts.size).toBe(0);

    database.times.push(
      "2026-10-30T00:00:00.000000Z",
      "2026-10-30T00:00:00.000001Z",
    );
    const writes = [];
    await expect(
      runRetirementCli(cliArguments("drop"), {
        output: (value) => output.push(value),
        retire,
        writeEvidence: async (...args) => writes.push(args),
      }),
    ).resolves.toBe(CREDIT_PROVISIONER_RETIREMENT_DROPPED_MARKER);
    expect(writes).toHaveLength(1);
    expect(output).toEqual([
      CREDIT_PROVISIONER_RETIREMENT_FAILURE_MARKER,
      CREDIT_PROVISIONER_RETIREMENT_DROPPED_MARKER,
    ]);
    expect(database.mutationCount).toBe(1);
  });

  it("contains no secret, deployment, provider, or dynamic-error mutation path", () => {
    const source = fs.readFileSync(
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "retire-image-gen-credit-provisioners.mjs",
      ),
      "utf8",
    );
    expect(source).not.toMatch(
      /gh secret|flyctl secrets|fly deploy|flyctl deploy|MOLLIE|OPENAI|console\.|process\.stderr|error\.(?:message|stack)/,
    );
    expect(source).toContain("RootMysqlSession");
  });
});
