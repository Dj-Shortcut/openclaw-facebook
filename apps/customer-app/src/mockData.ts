import type { PortalSnapshot } from "./portalApi";

export const mockSnapshot: PortalSnapshot = {
  user: {
    id: 1,
    name: "Customer",
    email: "customer@example.com",
  },
  workspace: {
    id: 1,
    name: "Leaderbot workspace",
    slug: "workspace-1",
  },
  aiIdentity: {
    workspaceId: 1,
    name: "Leaderbot",
    instructions: "Help customers with clear, useful answers.",
    tone: "Helpful",
    language: "nl",
    modelDefault: "default",
  },
  channels: [
    {
      id: 1,
      workspaceId: 1,
      channel: "facebook_messenger",
      status: "disconnected",
      externalId: null,
      displayName: null,
      lastCheckedAt: null,
    },
  ],
  usage: {
    workspaceId: 1,
    period: "today",
    messageCount: 0,
    imageCount: 0,
    blockedCount: 0,
  },
  privacy: {
    privacy: "/privacy",
    terms: "/terms",
    dataDeletion: "/data-deletion",
    exportRequest: "mailto:privacy@leaderbot.live?subject=Leaderbot data export",
    deletionRequest: "mailto:privacy@leaderbot.live?subject=Leaderbot data deletion",
  },
};
