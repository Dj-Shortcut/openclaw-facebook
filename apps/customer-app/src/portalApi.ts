export type ChannelStatus =
  | "connected"
  | "missing_permissions"
  | "token_expired"
  | "webhook_unhealthy"
  | "disconnected";

export type UpgradeRequest = {
  id: number;
  workspaceId: number;
  userId: number;
  status: "requested" | "contacted" | "completed" | "rejected";
  currentPlanName: string;
  billingStatus: string;
  upgradeReason: string | null;
  imagesRemainingToday: number;
  blockedToday: number;
  requestedPlanName: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
};

export type PortalSnapshot = {
  user: {
    id: number;
    name: string | null;
    email: string | null;
  };
  workspace: {
    id: number;
    name: string;
    slug: string;
  };
  aiIdentity: {
    workspaceId: number;
    name: string;
    instructions: string | null;
    tone: string;
    language: string;
    modelDefault: string;
  };
  knowledgeStore: {
    workspaceId: number;
    totalSources: number;
    activeSources: number;
    lastUpdate: string;
    sources: Array<{
      id: number;
      workspaceId: number;
      sourceType: "upload" | "website" | "manual_text" | "integration";
      name: string;
      sourceReference: string | null;
      status: "active" | "queued" | "indexing" | "error" | "disabled";
      itemCount: number;
      lastIndexedAt: string | null;
      metadata: unknown;
      createdAt: string;
      updatedAt: string;
    }>;
  };
  channels: Array<{
    id: number;
    workspaceId: number;
    channel: "facebook_messenger" | "whatsapp" | "web";
    status: ChannelStatus;
    externalId: string | null;
    displayName: string | null;
    lastCheckedAt: string | null;
  }>;
  usage: {
    workspaceId: number;
    period: "today";
    plan?: {
      name: string;
      billingStatus: string;
    };
    messageCount: number;
    imageCount: number;
    blockedCount: number;
    limits?: {
      imagesPerDay: number;
      messagesPerWindow: number;
      messageWindowSeconds: number;
    };
    remaining?: {
      imagesToday: number;
    };
    upgrade?: {
      recommended: boolean;
      reason: "image_limit_reached" | "blocked_usage" | string | null;
    };
    upgradeRequests?: UpgradeRequest[];
  };
  privacy: {
    privacy: string;
    terms: string;
    dataDeletion: string;
    exportRequest: string;
    deletionRequest: string;
    controls: {
      allowKnowledgeIndexing: boolean;
      allowUsageAnalytics: boolean;
      imageMemoryRetentionDays: number;
      createdAt: string;
      updatedAt: string;
    };
  };
};

export type FacebookStartResponse = {
  state: string;
  authorizationUrl: string | null;
  requiredScopes: string[];
};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

function getApiBaseUrl() {
  const configured = (import.meta.env.VITE_PORTAL_API_BASE_URL ?? "").trim();
  if (configured) {
    return configured.replace(/\/$/, "");
  }

  if (typeof window !== "undefined" && window.__TAURI_INTERNALS__) {
    throw new Error("VITE_PORTAL_API_BASE_URL is required for the Tauri customer app.");
  }

  return "";
}

function apiUrl(path: string) {
  return `${getApiBaseUrl()}${path}`;
}

async function readJson<T>(response: Response): Promise<T> {
  if (!response.ok) {
    throw new Error(`Portal API returned ${response.status}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new Error("Portal API did not return JSON.");
  }

  try {
    return await response.json() as T;
  } catch {
    throw new Error("Portal API returned invalid JSON.");
  }
}

export async function getPortalSnapshot() {
  const response = await fetch(apiUrl("/api/portal/snapshot"), {
    credentials: "include",
  });
  return readJson<PortalSnapshot>(response);
}

export async function updateAiIdentity(
  input: PortalSnapshot["aiIdentity"] & { workspaceId: number }
) {
  const response = await fetch(apiUrl("/api/portal/ai-identity"), {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  return readJson<PortalSnapshot["aiIdentity"]>(response);
}

export async function startFacebookConnect(workspaceId: number) {
  const response = await fetch(apiUrl("/api/portal/facebook/start"), {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ workspaceId }),
  });
  return readJson<FacebookStartResponse>(response);
}
