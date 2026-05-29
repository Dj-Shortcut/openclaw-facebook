import type { BotFeature } from "../features";

function isAdmin(psid: string, userId: string): boolean {
  const configured = (process.env.MESSENGER_ADMIN_IDS ?? "")
    .split(",")
    .map(value => value.trim())
    .filter(Boolean);

  if (configured.length === 0) {
    return false;
  }

  const allowed = new Set(configured);
  return allowed.has(psid) || allowed.has(userId);
}

function formatUptime(totalSeconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
}

export const statsFeature: BotFeature = {
  name: "stats",
  async onText(context) {
    if (context.messageText.trim() !== "/stats") {
      return { handled: false };
    }

    if (!isAdmin(context.senderId, context.userId)) {
      return { handled: false };
    }

    const stats = context.getRuntimeStats();
    const avgLatency = `${stats.averageGenerationLatencyMs ?? 0}ms`;
    const uptime = formatUptime(process.uptime());

    await context.sendText(
      [
        "Leaderbot Stats",
        "",
        `Images generated: ${stats.imagesGeneratedToday}`,
        `Users: ${stats.activeUsersToday}`,
        `Styles used: ${stats.stylesUsedToday}`,
        `Errors: ${stats.errorCountToday}`,
        `Avg latency: ${avgLatency}`,
        "",
        `Bot uptime: ${uptime}`,
        "",
        `Node-local stats for ${stats.date}`,
      ].join("\n")
    );

    return { handled: true };
  },
};
