import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { getLoginUrl } from "@/const";
import { trpc } from "@/lib/trpc";
import {
  Bot,
  Database,
  LogIn,
  MessageCircle,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";

function StatusPill({ value }: { value: string }) {
  const isConnected = value === "connected";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${
        isConnected
          ? "bg-emerald-500/15 text-emerald-200"
          : "bg-amber-500/15 text-amber-200"
      }`}
    >
      {value.replace(/_/g, " ")}
    </span>
  );
}

function MetricTile({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/75 p-4">
      <div className="text-sm text-slate-400">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-slate-50">{value}</div>
    </div>
  );
}

function Home() {
  const auth = useAuth();
  const utils = trpc.useUtils();
  const workspaceQuery = trpc.portal.workspace.current.useQuery(undefined, {
    enabled: auth.isAuthenticated,
  });
  const workspaceId = workspaceQuery.data?.id;
  const aiIdentityQuery = trpc.portal.aiIdentity.get.useQuery(
    { workspaceId: workspaceId ?? 0 },
    { enabled: Boolean(workspaceId) }
  );
  const channelStatusQuery = trpc.portal.channels.status.useQuery(
    { workspaceId: workspaceId ?? 0 },
    { enabled: Boolean(workspaceId) }
  );
  const usageQuery = trpc.portal.usage.summary.useQuery(
    { workspaceId: workspaceId ?? 0 },
    { enabled: Boolean(workspaceId) }
  );
  const knowledgeQuery = trpc.portal.knowledge.summary.useQuery(
    { workspaceId: workspaceId ?? 0 },
    { enabled: Boolean(workspaceId) }
  );
  const privacyQuery = trpc.portal.privacy.controls.useQuery(
    { workspaceId: workspaceId ?? 0 },
    { enabled: Boolean(workspaceId) }
  );
  const privacyMutation = trpc.portal.privacy.updateControls.useMutation({
    onSuccess: async () => {
      if (!workspaceId) return;
      await utils.portal.privacy.controls.invalidate({ workspaceId });
    },
  });

  const privacy = privacyQuery.data;
  const updatePrivacy = (
    updates: Partial<{
      allowKnowledgeIndexing: boolean;
      allowUsageAnalytics: boolean;
      imageMemoryRetentionDays: number;
    }>
  ) => {
    if (!workspaceId || !privacy) return;
    privacyMutation.mutate({
      workspaceId,
      allowKnowledgeIndexing: updates.allowKnowledgeIndexing ?? privacy.allowKnowledgeIndexing,
      allowUsageAnalytics: updates.allowUsageAnalytics ?? privacy.allowUsageAnalytics,
      imageMemoryRetentionDays:
        updates.imageMemoryRetentionDays ?? privacy.imageMemoryRetentionDays,
    });
  };

  if (!auth.isAuthenticated) {
    return (
      <main className="min-h-full bg-slate-950 px-6 py-10 text-slate-100">
        <div className="mx-auto flex min-h-[70vh] max-w-5xl items-center">
          <section className="w-full">
            <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-200">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <h1 className="max-w-2xl text-4xl font-semibold text-slate-50">
              Leaderbot customer portal
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-slate-300">
              Sign in to manage your workspace, AI identity, Messenger channel,
              usage, knowledge, and privacy controls.
            </p>
            <Button
              className="mt-8 gap-2"
              onClick={() => {
                window.location.href = getLoginUrl();
              }}
            >
              <LogIn className="h-4 w-4" />
              Sign in
            </Button>
          </section>
        </div>
      </main>
    );
  }

  const isLoading =
    auth.loading ||
    workspaceQuery.isLoading ||
    aiIdentityQuery.isLoading ||
    channelStatusQuery.isLoading ||
    usageQuery.isLoading ||
    knowledgeQuery.isLoading ||
    privacyQuery.isLoading;

  return (
    <main className="min-h-full bg-slate-950 px-4 py-6 text-slate-100 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <header className="flex flex-col gap-4 border-b border-slate-800 pb-6 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm text-cyan-200">Workspace</p>
            <h1 className="mt-1 text-3xl font-semibold text-slate-50">
              {workspaceQuery.data?.name ?? "Leaderbot workspace"}
            </h1>
            <p className="mt-2 text-sm text-slate-400">
              Signed in as {auth.user?.email ?? auth.user?.name ?? "customer"}
            </p>
          </div>
          <Button
            variant="outline"
            onClick={() => {
              void auth.logout();
            }}
          >
            Sign out
          </Button>
        </header>

        {isLoading ? (
          <div className="py-12 text-sm text-slate-400">Loading workspace...</div>
        ) : (
          <div className="grid gap-4 py-6 lg:grid-cols-3">
            <section className="rounded-lg border border-slate-800 bg-slate-900/70 p-5 lg:col-span-2">
              <div className="flex items-start gap-3">
                <Bot className="mt-1 h-5 w-5 text-cyan-200" />
                <div>
                  <h2 className="text-lg font-semibold text-slate-50">
                    {aiIdentityQuery.data?.name ?? "Leaderbot"}
                  </h2>
                  <p className="mt-1 text-sm text-slate-300">
                    {aiIdentityQuery.data?.tone ?? "Helpful"} ·{" "}
                    {aiIdentityQuery.data?.language ?? "nl"} ·{" "}
                    {aiIdentityQuery.data?.modelDefault ?? "default"}
                  </p>
                </div>
              </div>
              <div className="mt-5 rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-sm leading-6 text-slate-300">
                {aiIdentityQuery.data?.instructions ??
                  "No custom assistant instructions have been saved yet."}
              </div>
            </section>

            <section className="rounded-lg border border-slate-800 bg-slate-900/70 p-5">
              <div className="flex items-center gap-3">
                <MessageCircle className="h-5 w-5 text-cyan-200" />
                <h2 className="text-lg font-semibold text-slate-50">Messenger</h2>
              </div>
              <div className="mt-5 space-y-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-slate-400">Status</span>
                  <StatusPill
                    value={channelStatusQuery.data?.facebook.status ?? "disconnected"}
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-slate-400">Page</span>
                  <span className="text-right text-slate-200">
                    {channelStatusQuery.data?.facebook.pageName ?? "Not connected"}
                  </span>
                </div>
              </div>
            </section>

            <section className="grid gap-4 sm:grid-cols-3 lg:col-span-3">
              <MetricTile label="Messages today" value={usageQuery.data?.messageCount ?? 0} />
              <MetricTile label="Images today" value={usageQuery.data?.imageCount ?? 0} />
              <MetricTile label="Blocked today" value={usageQuery.data?.blockedCount ?? 0} />
            </section>

            <section className="rounded-lg border border-slate-800 bg-slate-900/70 p-5 lg:col-span-3">
              <div className="flex items-center gap-3">
                <SlidersHorizontal className="h-5 w-5 text-cyan-200" />
                <h2 className="text-lg font-semibold text-slate-50">
                  Privacy controls
                </h2>
              </div>
              <div className="mt-5 grid gap-4 md:grid-cols-3">
                <label className="flex min-h-24 items-start justify-between gap-4 rounded-lg border border-slate-800 bg-slate-950/60 p-4">
                  <span>
                    <span className="block text-sm font-medium text-slate-100">
                      Knowledge indexing
                    </span>
                    <span className="mt-1 block text-sm text-slate-400">
                      Allow uploaded knowledge to be indexed.
                    </span>
                  </span>
                  <input
                    className="mt-1 h-5 w-5"
                    type="checkbox"
                    checked={privacy?.allowKnowledgeIndexing ?? false}
                    disabled={!privacy || privacyMutation.isPending}
                    onChange={event =>
                      updatePrivacy({ allowKnowledgeIndexing: event.target.checked })
                    }
                  />
                </label>
                <label className="flex min-h-24 items-start justify-between gap-4 rounded-lg border border-slate-800 bg-slate-950/60 p-4">
                  <span>
                    <span className="block text-sm font-medium text-slate-100">
                      Usage analytics
                    </span>
                    <span className="mt-1 block text-sm text-slate-400">
                      Allow workspace usage analytics.
                    </span>
                  </span>
                  <input
                    className="mt-1 h-5 w-5"
                    type="checkbox"
                    checked={privacy?.allowUsageAnalytics ?? false}
                    disabled={!privacy || privacyMutation.isPending}
                    onChange={event =>
                      updatePrivacy({ allowUsageAnalytics: event.target.checked })
                    }
                  />
                </label>
                <label className="flex min-h-24 items-start justify-between gap-4 rounded-lg border border-slate-800 bg-slate-950/60 p-4">
                  <span>
                    <span className="block text-sm font-medium text-slate-100">
                      Image memory retention
                    </span>
                    <span className="mt-1 block text-sm text-slate-400">
                      Days retained: {privacy?.imageMemoryRetentionDays ?? 0}
                    </span>
                  </span>
                  <input
                    className="w-24 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-right text-sm text-slate-100"
                    type="number"
                    min={0}
                    max={365}
                    value={privacy?.imageMemoryRetentionDays ?? 0}
                    disabled={!privacy || privacyMutation.isPending}
                    onChange={event =>
                      updatePrivacy({
                        imageMemoryRetentionDays: Number(event.target.value),
                      })
                    }
                  />
                </label>
              </div>
            </section>

            <section className="rounded-lg border border-slate-800 bg-slate-900/70 p-5 lg:col-span-3">
              <div className="flex items-center gap-3">
                <Database className="h-5 w-5 text-cyan-200" />
                <h2 className="text-lg font-semibold text-slate-50">Knowledge base</h2>
              </div>
              <div className="mt-5 grid gap-4 sm:grid-cols-3">
                <MetricTile label="Sources" value={knowledgeQuery.data?.totalSources ?? 0} />
                <MetricTile label="Active" value={knowledgeQuery.data?.activeSources ?? 0} />
                <MetricTile
                  label="Last update"
                  value={
                    knowledgeQuery.data?.lastUpdate
                      ? new Date(knowledgeQuery.data.lastUpdate).toLocaleDateString()
                      : "-"
                  }
                />
              </div>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}

export default Home;
