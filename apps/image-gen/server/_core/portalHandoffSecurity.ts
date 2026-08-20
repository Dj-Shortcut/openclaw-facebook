/**
 * Portal handoff is fail-closed until both issuance and claim enforce the
 * immutable Facebook Page-to-workspace binding stored on the handoff token.
 */
export function isPortalHandoffTenantBoundaryReady(): boolean {
  return true;
}

/**
 * Manual recovery cannot prove the failed outbox operation or a support
 * principal. Keep this separately fail-closed; automated outbox delivery is
 * bound to its stable delivery operation and does not use this route.
 */
export function isManualPortalHandoffRecoveryReady(): boolean {
  return false;
}
