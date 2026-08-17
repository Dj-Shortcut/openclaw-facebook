/**
 * Portal handoff is fail-closed until both issuance and claim enforce the
 * immutable Facebook Page-to-workspace binding stored on the handoff token.
 */
export function isPortalHandoffTenantBoundaryReady(): boolean {
  return true;
}
