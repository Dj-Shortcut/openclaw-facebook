import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectCreditTestSessionInventory } from "./credit-test-session-inventory.mjs";

const SENTINEL = "credit-session-inventory-disposable-mysql-v1";
export function assertDisposableSessionInventoryDatabase(
  databaseUrl,
  sentinel,
) {
  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("requires disposable session-inventory MySQL");
  }
  if (
    sentinel !== SENTINEL ||
    parsed.protocol !== "mysql:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port !== "3306" ||
    parsed.username !== "root" ||
    parsed.pathname !== "/test_image_gen" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  )
    throw new Error("requires disposable session-inventory MySQL");
  return parsed;
}
describe("session inventory disposable-test boundary", () => {
  it.each([
    ["mysql://root:root@db.internal:3306/test_image_gen", SENTINEL],
    ["mysql://root:root@127.0.0.1:3306/leaderbot", SENTINEL],
    ["mysql://root:root@127.0.0.1:3306/test_image_gen", undefined],
  ])("rejects other targets before connecting", (url, sentinel) => {
    expect(() =>
      assertDisposableSessionInventoryDatabase(url, sentinel),
    ).toThrow("requires disposable");
  });
});

// Run separately/sequentially: this disposable-service test temporarily changes
// one global instrumentation switch, restores it, and drops only its own accounts.
const suite = describe.runIf(
  process.env.RUN_MYSQL_INTEGRATION === "1" &&
    Boolean(process.env.DATABASE_URL),
);
suite("narrow session inventory on disposable MySQL 8.4.11", () => {
  let mysql, root, inspector, settings, instrumentation;
  const connections = new Set();
  const accounts = [];
  const password = randomBytes(24).toString("hex");
  const names = Object.fromEntries(
    ["inspector", "old", "noise"].map((role) => [
      role,
      `lbsi_${randomBytes(8).toString("hex")}`,
    ]),
  );
  const oldHash = createHash("sha256").update(names.old).digest("hex");
  let expectedSessionId;
  const account = (name) => {
    if (!/^lbsi_[a-f0-9]{16}$/.test(name))
      throw new Error("invalid synthetic account");
    return `'${name}'@'%'`;
  };
  const close = async (connection) => {
    try {
      await connection.end();
    } finally {
      connection.destroy();
      connections.delete(connection);
    }
  };
  const connect = async (user) => {
    const connection = await mysql.createConnection({
      ...settings,
      user,
      password,
    });
    connections.add(connection);
    return connection;
  };
  let metadataDiagnostics = [];
  const session = {
    async execute(sql) {
      const operation = sql.startsWith("SELECT @@")
        ? "identity"
        : sql.startsWith("SHOW GLOBAL")
          ? "status"
          : "census";
      let rows;
      try {
        [rows] = await inspector.query(sql);
      } catch (error) {
        metadataDiagnostics.push({
          operation,
          errorCode: /^ER_[A-Z_]+$/.test(error?.code ?? "")
            ? error.code
            : "metadata_query_failed",
        });
        throw error;
      }
      // Only fixed enums, booleans and aggregate counts may reach CI failures.
      // Never include driver messages, SQL, usernames, or arbitrary row values.
      const values =
        rows.length === 1 ? Object.values(rows[0]).map(String) : [];
      if (operation === "identity") {
        metadataDiagnostics.push({
          operation,
          enabled: values[0] === "1",
          supportedThreadModel: values[1] === "one-thread-per-connection",
          expectedSession: values[2] === expectedSessionId,
        });
      } else if (operation === "status") {
        metadataDiagnostics.push({
          operation,
          name: ["Connections", "Threads_connected"].includes(values[0])
            ? values[0]
            : "unexpected",
          count: /^\d+$/.test(values[1] ?? "") ? values[1] : "invalid",
        });
      } else {
        metadataDiagnostics.push({
          operation,
          counts:
            values.length === 6 && values.every((value) => /^\d+$/.test(value))
              ? values
              : "invalid",
        });
      }
      return rows.map((row) =>
        Object.values(row)
          .map((value) => (value === null ? "NULL" : String(value)))
          .join("\t"),
      );
    },
  };
  const collect = () =>
    collectCreditTestSessionInventory(session, {
      obsoletePrincipalSha256: oldHash,
      expectedSessionId,
    });
  beforeAll(async () => {
    const parsed = assertDisposableSessionInventoryDatabase(
      process.env.DATABASE_URL,
      process.env.CREDIT_SESSION_INVENTORY_DESTRUCTIVE_TEST,
    );
    mysql = createRequire(
      new URL("../apps/image-gen/package.json", import.meta.url),
    )("mysql2/promise");
    settings = {
      host: parsed.hostname,
      port: Number(parsed.port),
      connectTimeout: 5000,
    };
    root = await mysql.createConnection({
      ...settings,
      user: "root",
      password: decodeURIComponent(parsed.password),
    });
    const [[version]] = await root.query("SELECT VERSION() AS version");
    expect(version.version).toMatch(/^8\.4\.11(?:$|[-.])/);
    for (const name of Object.values(names)) {
      await root.query(
        `CREATE USER ${account(name)} IDENTIFIED BY '${password}'`,
      );
      accounts.push(name);
    }
    await root.query(
      `GRANT SELECT (NAME,TYPE,PROCESSLIST_ID,PROCESSLIST_USER) ON performance_schema.threads TO ${account(names.inspector)}`,
    );
    inspector = await connect(names.inspector);
    const [[row]] = await inspector.query("SELECT CONNECTION_ID() AS id");
    expectedSessionId = String(row.id);
  });
  afterAll(async () => {
    let cleanupFailed = false;
    const attempt = async (operation) => {
      try {
        await operation();
      } catch {
        cleanupFailed = true;
      }
    };
    if (root && instrumentation !== undefined) {
      await attempt(() =>
        root.query(
          "UPDATE performance_schema.setup_instruments SET ENABLED=? WHERE NAME='thread/sql/one_connection'",
          [instrumentation],
        ),
      );
    }
    await Promise.all(
      [...connections].map((connection) => attempt(() => close(connection))),
    );
    if (root) {
      for (const name of accounts) {
        await attempt(() => root.query(`DROP USER IF EXISTS ${account(name)}`));
      }
      await attempt(() => close(root));
    }
    if (cleanupFailed)
      throw new Error("synthetic session inventory cleanup failed");
  });
  it("verifies restricted metadata access, existing locked sessions, absence, cache, auth and disabled instrumentation", async () => {
    metadataDiagnostics = [];
    const baseline = await collect();
    expect(
      baseline,
      JSON.stringify({ baseline, metadataDiagnostics }),
    ).toMatchObject({
      verified: true,
      obsoleteSessionCount: 0,
    });
    // Column grants expose cross-user metadata, but not SQL text or other columns.
    for (const sql of [
      "SELECT PROCESSLIST_INFO FROM performance_schema.threads",
      "SELECT * FROM performance_schema.threads",
      "SELECT PROCESSLIST_HOST FROM performance_schema.threads",
      "UPDATE performance_schema.threads SET INSTRUMENTED='YES'",
    ]) {
      await expect(inspector.query(sql)).rejects.toMatchObject({
        code: expect.stringMatching(/^ER_(COLUMN|TABLE)ACCESS_DENIED_ERROR$/),
      });
    }
    const old = await connect(names.old);
    expect(await collect()).toMatchObject({
      verified: false,
      reason: "obsolete_sessions_present",
    });
    await root.query(`ALTER USER ${account(names.old)} ACCOUNT LOCK`);
    expect((await old.query("SELECT 1 AS alive"))[0][0].alive).toBe(1);
    expect(await collect()).toMatchObject({
      verified: false,
      reason: "obsolete_sessions_present",
    });
    await close(old);
    await root.query(`DROP USER ${account(names.old)}`);
    expect(await collect()).toMatchObject({
      verified: true,
      obsoleteSessionCount: 0,
    });
    for (let index = 0; index < 12; index++)
      await close(await connect(names.noise));
    expect(await collect()).toMatchObject({ verified: true });
    const unauthenticated = net.createConnection({
      host: settings.host,
      port: settings.port,
    });
    try {
      await new Promise((resolve, reject) => {
        unauthenticated.setTimeout(3000, () =>
          reject(new Error("synthetic authentication timeout")),
        );
        unauthenticated.once("data", resolve);
        unauthenticated.once("error", reject);
      });
      expect(await collect()).toMatchObject({ verified: false });
    } finally {
      unauthenticated.destroy();
    }
    const [[instrument]] = await root.query(
      "SELECT ENABLED FROM performance_schema.setup_instruments WHERE NAME='thread/sql/one_connection'",
    );
    instrumentation = instrument.ENABLED;
    await root.query(
      "UPDATE performance_schema.setup_instruments SET ENABLED='NO' WHERE NAME='thread/sql/one_connection'",
    );
    await root.query(
      `CREATE USER ${account(names.old)} IDENTIFIED BY '${password}'`,
    );
    const disabled = await connect(names.old);
    await root.query(`ALTER USER ${account(names.old)} ACCOUNT LOCK`);
    await root.query("FLUSH STATUS");
    expect((await disabled.query("SELECT 1 AS alive"))[0][0].alive).toBe(1);
    // Whether MySQL still includes this thread or omits it, zero must not pass.
    expect(await collect()).toMatchObject({ verified: false });
    await close(disabled);
    await root.query(
      "UPDATE performance_schema.setup_instruments SET ENABLED=? WHERE NAME='thread/sql/one_connection'",
      [instrumentation],
    );
    instrumentation = undefined;
  }, 30000);
});
