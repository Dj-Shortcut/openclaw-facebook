export function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function hasMessengerCredentials(account: any): boolean {
  return Boolean(
    hasText(account.pageId) &&
      hasText(account.pageAccessToken) &&
      hasText(account.appSecret) &&
      hasText(account.verifyToken),
  );
}
