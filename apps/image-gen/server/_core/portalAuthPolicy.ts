const FACEBOOK_LOGIN_METHODS = new Set([
  "facebook",
  "meta",
  "registered_platform_facebook",
  "registered_platform_meta",
]);

export function normalizeLoginMethod(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

export function isFacebookLoginMethod(value: string | null | undefined) {
  const normalized = normalizeLoginMethod(value);
  return Boolean(normalized && FACEBOOK_LOGIN_METHODS.has(normalized));
}
