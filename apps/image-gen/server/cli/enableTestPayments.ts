import { pathToFileURL } from "node:url";
import {
  enableTestPayments,
  TestPaymentOperatorError,
} from "../_core/billing/testPaymentOperator";
import { closeDatabasePool } from "../db";

export async function runEnableTestPaymentsCli(): Promise<void> {
  let committed = false;
  try {
    const result = await enableTestPayments();
    committed = true;
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    if (error instanceof TestPaymentOperatorError) committed = error.committed;
    process.stderr.write(
      `${JSON.stringify({
        event: "test_payment_operator_failed",
        failedStage:
          error instanceof TestPaymentOperatorError
            ? error.failedStage
            : "activation",
        outcome:
          error instanceof TestPaymentOperatorError ? error.outcome : "unknown",
        committed,
      })}\n`
    );
    process.exitCode = 1;
  } finally {
    try {
      await closeDatabasePool();
    } catch {
      // Cleanup cannot undo a committed action or hide the successful receipt.
      process.stderr.write(
        `${JSON.stringify({
          event: "test_payment_operator_cleanup_failed",
          committed,
        })}\n`
      );
      process.exitCode = 1;
    }
  }
}

// esbuild's CJS bundle is intentionally run from a unique temporary filename.
// Source imports in tests must never execute the operator action.
const isMain =
  typeof require !== "undefined" && typeof module !== "undefined"
    ? require.main === module
    : Boolean(
        process.argv[1] &&
        pathToFileURL(process.argv[1]).href === import.meta.url
      );
if (isMain) void runEnableTestPaymentsCli();
