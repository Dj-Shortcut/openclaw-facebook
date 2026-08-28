import { assertCreditWalletRuntimeGrantScope } from "../../../scripts/production-schema-contract.mjs";

type RuntimeMetadataConnection = Readonly<{
  query(statement: string): Promise<readonly [unknown, unknown]>;
}>;

export class CreditRuntimePrivilegeReadinessError extends Error {
  constructor(cause?: unknown) {
    super("Credit runtime database privilege boundary is not ready", {
      cause,
    });
    this.name = "CreditRuntimePrivilegeReadinessError";
  }
}

function readDatabaseName(rows: unknown): string {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new CreditRuntimePrivilegeReadinessError();
  }
  const row = (rows as readonly unknown[])[0];
  if (!row || typeof row !== "object") {
    throw new CreditRuntimePrivilegeReadinessError();
  }
  const databaseName = (row as Record<string, unknown>).databaseName;
  if (typeof databaseName !== "string" || databaseName.length === 0) {
    throw new CreditRuntimePrivilegeReadinessError();
  }
  return databaseName;
}

function readGrantStatements(rows: unknown): string[] {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new CreditRuntimePrivilegeReadinessError();
  }
  return (rows as readonly unknown[]).map(row => {
    if (!row || typeof row !== "object") {
      throw new CreditRuntimePrivilegeReadinessError();
    }
    const values = Object.values(row as Record<string, unknown>);
    if (values.length !== 1 || typeof values[0] !== "string") {
      throw new CreditRuntimePrivilegeReadinessError();
    }
    return values[0];
  });
}

/**
 * Reads only the active schema name and the current principal's grant metadata.
 * Grant text never leaves this helper. The canonical production contract owns
 * the exact table and routine allowlists.
 */
export async function assertCreditRuntimePrivilegeReadiness(
  connection: RuntimeMetadataConnection
): Promise<void> {
  try {
    const [databaseRows] = await connection.query(
      "SELECT DATABASE() AS databaseName"
    );
    const databaseName = readDatabaseName(databaseRows);
    const [grantRows] = await connection.query(
      "SHOW GRANTS FOR CURRENT_USER()"
    );
    assertCreditWalletRuntimeGrantScope(
      readGrantStatements(grantRows),
      databaseName
    );
  } catch (error) {
    if (error instanceof CreditRuntimePrivilegeReadinessError) throw error;
    throw new CreditRuntimePrivilegeReadinessError(error);
  }
}
