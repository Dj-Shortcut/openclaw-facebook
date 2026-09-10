// Draft inspection primitive, not activation authority. The caller must separately
// verify the database/principal identity, account lock (or absence), and deploy lock.
// execute(sql) must use one pinned connection and return tab-separated rows.
export async function collectCreditTestSessionInventory(
  session,
  { obsoletePrincipalSha256, expectedSessionId, maxAttempts = 3 },
) {
  if (
    !/^[a-f0-9]{64}$/.test(obsoletePrincipalSha256 ?? "") ||
    !/^[1-9][0-9]{0,19}$/.test(String(expectedSessionId ?? "")) ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > 3
  ) {
    throw new Error("invalid credit session inventory input");
  }
  const rejected = (reason, attempt) => ({ verified: false, reason, attempt });
  const number = (value) => {
    if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value))
      throw new Error("invalid metadata count");
    return BigInt(value);
  };
  const one = async (sql) => {
    const rows = await session.execute(sql);
    if (
      !Array.isArray(rows) ||
      rows.length !== 1 ||
      typeof rows[0] !== "string"
    )
      throw new Error("invalid metadata result");
    return rows[0].split("\t");
  };
  const status = async (name) => {
    const row = await one(`SHOW GLOBAL STATUS LIKE '${name}'`);
    if (row.length !== 2 || row[0] !== name)
      throw new Error("invalid metadata status");
    return number(row[1]);
  };
  const identity = async () => {
    const row = await one(
      "SELECT @@performance_schema,@@thread_handling,CONNECTION_ID()",
    );
    return (
      row.length === 3 &&
      row[0] === "1" &&
      row[1] === "one-thread-per-connection" &&
      row[2] === String(expectedSessionId)
    );
  };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (!(await identity()))
        return rejected("unsupported_or_changed_session", attempt);
      // Connections does not reset with FLUSH STATUS. Stable brackets rule out
      // replacement connections; matching global counts detect missing P_S rows.
      const connectionsBefore = await status("Connections");
      const connectedBefore = await status("Threads_connected");
      // MySQL 8.4 assigns processlist IDs to these two internal daemon threads,
      // so TYPE alone does not identify client connections. Neither contributes
      // to Connection_handler_manager::connection_count (Threads_connected).
      // Match both the server-owned instrumentation name and its fixed user;
      // never exclude event workers, plugin sessions or client-supplied names.
      // Source: mysql/mysql-server mysql-8.4.11 sql/event_scheduler.cc,
      // sql/rpl_gtid_persist.cc and storage/perfschema/table_threads.cc.
      const row =
        await one(`SELECT COUNT(CASE WHEN internal_daemon=0 THEN PROCESSLIST_ID END),
        COUNT(DISTINCT CASE WHEN internal_daemon=0 THEN PROCESSLIST_ID END),
        COALESCE(SUM(PROCESSLIST_ID=CONNECTION_ID()),0),
        COALESCE(SUM(SHA2(PROCESSLIST_USER,256)='${obsoletePrincipalSha256}'),0),
        COALESCE(SUM(internal_daemon=0 AND (PROCESSLIST_USER IS NULL OR PROCESSLIST_USER IN ('','unauthenticated user','system user'))),0),
        COALESCE(SUM(internal_daemon=0 AND (NAME IS NULL OR NAME<>'thread/sql/one_connection')),0)
        FROM (
          SELECT NAME,PROCESSLIST_ID,PROCESSLIST_USER,
          CASE WHEN (BINARY NAME='thread/sql/event_scheduler' AND BINARY PROCESSLIST_USER='event_scheduler')
            OR (BINARY NAME='thread/sql/compress_gtid_table' AND PROCESSLIST_USER IS NULL)
            THEN 1 ELSE 0 END AS internal_daemon
          FROM performance_schema.threads WHERE TYPE='FOREGROUND' AND PROCESSLIST_ID>0
        ) AS session_inventory`);
      if (row.length !== 6) throw new Error("invalid metadata census");
      const [total, distinct, own, obsolete, unknown, unsupported] =
        row.map(number);
      const connectedAfter = await status("Threads_connected");
      const connectionsAfter = await status("Connections");
      if (!(await identity()))
        return rejected("unsupported_or_changed_session", attempt);
      if (obsolete > 0n) return rejected("obsolete_sessions_present", attempt);
      if (unknown > 0n || unsupported > 0n)
        return rejected("unknown_session_type", attempt);
      if (
        connectionsBefore !== connectionsAfter ||
        connectedBefore !== connectedAfter
      ) {
        if (attempt < maxAttempts) continue;
        return rejected("unstable_inventory", attempt);
      }
      if (own !== 1n || total !== distinct || total !== connectedBefore)
        return rejected("incomplete_inventory", attempt);
      return {
        verified: true,
        obsoleteSessionCount: 0,
        sessionCount: total.toString(),
        attempt,
      };
    } catch {
      // Never relay query errors: adapters/drivers can embed usernames or SQL.
      return rejected("metadata_unavailable", attempt);
    }
  }
}
