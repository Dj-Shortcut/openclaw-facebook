/**
 * Emergency fail-closed gate for the legacy Messenger-to-portal handoff.
 *
 * Issuance currently accepts a workspace and a Messenger sender key without
 * proving that the receiving Page belongs to that workspace. Claiming such a
 * token can grant workspace ownership, so neither issuance nor claim may be
 * reachable until an immutable Page/channel/workspace binding is enforced at
 * both steps. This deliberately has no environment-variable bypass.
 */
export function isPortalHandoffTenantBoundaryReady(): boolean {
  return false;
}
