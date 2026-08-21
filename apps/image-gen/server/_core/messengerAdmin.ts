export function isMessengerAdmin(
  senderId: string,
  userId: string,
  configuredIds = process.env.MESSENGER_ADMIN_IDS
): boolean {
  const configured = (configuredIds ?? "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);
  if (configured.length === 0) return false;

  const allowed = new Set(configured);
  return allowed.has(senderId) || allowed.has(userId);
}
