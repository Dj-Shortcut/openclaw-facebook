export const GDPR_CONSENT_AGREE = "GDPR_CONSENT_AGREE";
export const GDPR_CONSENT_DECLINE = "GDPR_CONSENT_DECLINE";
export const GDPR_DELETE_CONFIRM = "GDPR_DELETE_CONFIRM";
export const GDPR_DELETE_CANCEL = "GDPR_DELETE_CANCEL";

const GDPR_ACTION_IDS = new Set<string>([
  GDPR_CONSENT_AGREE,
  GDPR_CONSENT_DECLINE,
  GDPR_DELETE_CONFIRM,
  GDPR_DELETE_CANCEL,
]);

export function isGdprActionId(payload: string | null | undefined): boolean {
  return Boolean(payload && GDPR_ACTION_IDS.has(payload));
}
