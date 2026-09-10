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
    if (!baseline.verified) {
      const [instruments] = await inspector.query(
        `SELECT NAME,COUNT(*) AS thread_count,
          COALESCE(SUM(PROCESSLIST_USER IS NULL),0) AS anonymous_count
         FROM performance_schema.threads
         WHERE TYPE='FOREGROUND' AND PROCESSLIST_ID>0 GROUP BY NAME`,
      );
      metadataDiagnostics.push({
        operation: "instrument_inventory",
        // This is a disposable server: expose only server instrumentation names
        // and counts, never process IDs, account names or SQL text.
        instruments: instruments.map((row) => ({
          name: /^thread\/[a-z0-9_]+\/[a-z0-9_]+$/.test(row.NAME ?? "")
            ? row.NAME
            : "unsupported_instrument_name",
          count: /^\d+$/.test(String(row.thread_count))
            ? String(row.thread_count)
            : "invalid",
          anonymousCount: /^\d+$/.test(String(row.anonymous_count))
            ? String(row.anonymous_count)
            : "invalid",
        })),
      });
    }
    expect(
      baseline,
      JSON.stringify({ baseline, metadataDiagnostics }),
    ).toMatchObject({
      verified: true,
      obsoleteSessionCount: 0,
    });
    // Exercise the actual SQL classifier, not a mock of its aggregate output.
    // Only this disposable test substitutes synthetic metadata for P_S rows.
    const syntheticThread = (offset, name, user) => {
      if (
        !/^thread\/[a-z0-9_]+\/[a-z0-9_]+$/.test(name) ||
        (user !== null && !/^[a-z0-9_]+$/.test(user))
      )
        throw new Error("invalid synthetic thread metadata");
      const id = BigInt(expectedSessionId) + BigInt(offset);
      return `SELECT '${name}' AS NAME,'FOREGROUND' AS TYPE,
        ${id} AS PROCESSLIST_ID,${user === null ? "NULL" : `'${user}'`} AS PROCESSLIST_USER`;
    };
    const clientRows = [
      syntheticThread(0, "thread/sql/one_connection", names.inspector),
      syntheticThread(1, "thread/sql/one_connection", "fixture_user"),
    ];
    for (const [
      label,
      extraRows,
      expected,
      includedClients = clientRows,
      obsoleteHash = oldHash,
    ] of [
      [
        "exact internal daemon pairs",
        [
          syntheticThread(2, "thread/sql/event_scheduler", "event_scheduler"),
          syntheticThread(3, "thread/sql/compress_gtid_table", null),
        ],
        { verified: true, sessionCount: "2" },
      ],
      [
        "internal rows cannot compensate for a missing client",
        [
          syntheticThread(2, "thread/sql/event_scheduler", "event_scheduler"),
          syntheticThread(3, "thread/sql/compress_gtid_table", null),
        ],
        { verified: false, reason: "incomplete_inventory" },
        clientRows.slice(0, 1),
      ],
      [
        "obsolete match is checked even on excluded internal rows",
        [syntheticThread(2, "thread/sql/event_scheduler", "event_scheduler")],
        { verified: false, reason: "obsolete_sessions_present" },
        clientRows,
        createHash("sha256").update("event_scheduler").digest("hex"),
      ],
      [
        "client using an internal username",
        [syntheticThread(2, "thread/sql/one_connection", "event_scheduler")],
        { verified: false, reason: "incomplete_inventory" },
      ],
      [
        "daemon name with a different user",
        [syntheticThread(2, "thread/sql/event_scheduler", "fixture_user")],
        { verified: false, reason: "unknown_session_type" },
      ],
      [
        "daemon name with the obsolete account",
        [syntheticThread(2, "thread/sql/event_scheduler", names.old)],
        { verified: false, reason: "obsolete_sessions_present" },
      ],
      [
        "compression daemon name with the obsolete account",
        [syntheticThread(2, "thread/sql/compress_gtid_table", names.old)],
        { verified: false, reason: "obsolete_sessions_present" },
      ],
      [
        "unknown anonymous instrument",
        [syntheticThread(2, "thread/plugin/unknown", null)],
        { verified: false, reason: "unknown_session_type" },
      ],
      [
        "event worker is not the scheduler",
        [syntheticThread(2, "thread/sql/event_worker", "event_scheduler")],
        { verified: false, reason: "unknown_session_type" },
      ],
    ]) {
      const syntheticSession = {
        async execute(sql) {
          if (sql.includes("LIKE 'Connections'")) return ["Connections\t10"];
          if (sql.includes("LIKE 'Threads_connected'"))
            return ["Threads_connected\t2"];
          if (sql.includes("AS internal_daemon")) {
            return session.execute(
              sql.replace(
                "FROM performance_schema.threads",
                `FROM (${[...includedClients, ...extraRows].join(" UNION ALL ")}) AS synthetic_threads`,
              ),
            );
          }
          return session.execute(sql);
        },
      };
      expect(
        await collectCreditTestSessionInventory(syntheticSession, {
          obsoletePrincipalSha256: obsoleteHash,
          expectedSessionId,
        }),
        label,
      ).toMatchObject(expected);
    }
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
