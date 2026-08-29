import { and, eq } from "drizzle-orm";

import { billingExecutionControls } from "../../../drizzle/schema";
import { getDatabaseOrThrow } from "../../db";
import type { MollieMode } from "./config";

export async function readCreditCheckoutAuthorization(input: {
  workspaceId: number;
  mode: MollieMode;
}): Promise<Readonly<{ authorizationEpoch: number }> | null> {
  const database = await getDatabaseOrThrow();
  const rows = await database
    .select({
      commercialEnabled: billingExecutionControls.commercialEnabled,
      authorizationEpoch: billingExecutionControls.authorizationEpoch,
    })
    .from(billingExecutionControls)
    .where(
      and(
        eq(billingExecutionControls.workspaceId, input.workspaceId),
        eq(billingExecutionControls.mode, input.mode)
      )
    )
    .limit(2);
  if (
    rows.length !== 1 ||
    !rows[0]?.commercialEnabled ||
    !Number.isSafeInteger(rows[0].authorizationEpoch) ||
    rows[0].authorizationEpoch < 1
  ) {
    return null;
  }
  return Object.freeze({ authorizationEpoch: rows[0].authorizationEpoch });
}
