import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { getLoginUrl } from "@/const";
import { trpc } from "@/lib/trpc";
import {
  Bot,
  Database,
  FileDown,
  LogIn,
  MessageCircle,
  Pencil,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";

function StatusPill({ value }: { value: string }) {
  const toneClass =
    value === "connected" || value === "completed"
      ? "bg-emerald-500/15 text-emerald-200"
      : value === "rejected"
        ? "bg-red-500/15 text-red-200"
        : value === "processing"
          ? "bg-sky-500/15 text-sky-200"
          : "bg-amber-500/15 text-amber-200";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${toneClass}`}
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
  const [isEditingIdentity, setIsEditingIdentity] = useState(false);
  const [identityForm, setIdentityForm] = useState({
    name: "",
    instructions: "",
    tone: "",
    language: "",
    modelDefault: "",
  });
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
  const privacyRequestsQuery = trpc.portal.privacy.requests.useQuery(
    { workspaceId: workspaceId ?? 0 },
    { enabled: Boolean(workspaceId) }
  );
  const privacyMutation = trpc.portal.privacy.updateControls.useMutation({
    onSuccess: async () => {
      if (!workspaceId) return;
      await utils.portal.privacy.controls.invalidate({ workspaceId });
    },
  });
  const privacyRequestMutation = trpc.portal.privacy.createRequest.useMutation({
    onSuccess: async () => {
      if (!workspaceId) return;
      await utils.portal.privacy.requests.invalidate({ workspaceId });
    },
  });
  const aiIdentityMutation = trpc.portal.aiIdentity.update.useMutation({
    onSuccess: async () => {
      if (!workspaceId) return;
      setIsEditingIdentity(false);
      await utils.portal.aiIdentity.get.invalidate({ workspaceId });
    },
  });

  const privacy = privacyQuery.data;
  const privacyRequests = privacyRequestsQuery.data ?? [];
  const privacyRequestsError = privacyRequestsQuery.error;
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
  const startEditingIdentity = () => {
    const identity = aiIdentityQuery.data;
    if (!identity) return;
    setIdentityForm({
      name: identity.name,
      instructions: identity.instructions ?? "",
      tone: identity.tone,
      language: identity.language,
      modelDefault: identity.modelDefault,
    });
    setIsEditingIdentity(true);
  };
  const createPrivacyRequest = (requestType: "export" | "deletion") => {
    if (!workspaceId) return;
    privacyRequestMutation.mutate({
      workspaceId,
      requestType,
      note: null,
    });
  };
  const saveIdentity = async () => {
    if (!workspaceId) return;
    await aiIdentityMutation.mutateAsync({
      workspaceId,
      name: identityForm.name,
      instructions: identityForm.instructions.trim() ? identityForm.instructions : null,
      tone: identityForm.tone,
      language: identityForm.language,
      modelDefault: identityForm.modelDefault,
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
    privacyQuery.isLoading ||
    privacyRequestsQuery.isLoading;

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
              <div className="flex items-start justify-between gap-3">
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
                {!isEditingIdentity ? (
                  <Button
                    className="gap-2"
                    size="sm"
                    variant="outline"
                    onClick={startEditingIdentity}
                  >
                    <Pencil className="h-4 w-4" />
                    Edit
                  </Button>
                ) : null}
              </div>
              {isEditingIdentity ? (
                <form
                  className="mt-5 grid gap-4"
                  onSubmit={event => {
                    event.preventDefault();
                    void saveIdentity();
                  }}
                >
                  <div className="grid gap-4 md:grid-cols-2">
                    <label className="grid gap-2 text-sm text-slate-300">
                      Name
                      <input
                        className="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                        maxLength={120}
                        required
                        value={identityForm.name}
                        onChange={event =>
                          setIdentityForm(current => ({
                            ...current,
                            name: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="grid gap-2 text-sm text-slate-300">
                      Tone
                      <input
                        className="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                        maxLength={80}
                        required
                        value={identityForm.tone}
                        onChange={event =>
                          setIdentityForm(current => ({
                            ...current,
                            tone: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="grid gap-2 text-sm text-slate-300">
                      Language
                      <input
                        className="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                        maxLength={16}
                        minLength={2}
                        required
                        value={identityForm.language}
                        onChange={event =>
                          setIdentityForm(current => ({
                            ...current,
                            language: event.target.value,
                          }))
                        }
                      />
                    </label>
                    <label className="grid gap-2 text-sm text-slate-300">
                      Model default
                      <input
                        className="rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                        maxLength={80}
                        required
                        value={identityForm.modelDefault}
                        onChange={event =>
                          setIdentityForm(current => ({
                            ...current,
                            modelDefault: event.target.value,
                          }))
                        }
                      />
                    </label>
                  </div>
                  <label className="grid gap-2 text-sm text-slate-300">
                    Instructions
                    <textarea
                      className="min-h-36 rounded border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100"
                      maxLength={8000}
                      value={identityForm.instructions}
                      onChange={event =>
                        setIdentityForm(current => ({
                          ...current,
                          instructions: event.target.value,
                        }))
                      }
                    />
                  </label>
                  {aiIdentityMutation.error ? (
                    <div className="text-sm text-red-300">
                      {aiIdentityMutation.error.message}
                    </div>
                  ) : null}
                  <div className="flex flex-wrap gap-3">
                    <Button
                      className="gap-2"
                      disabled={aiIdentityMutation.isPending}
                      type="submit"
                    >
                      <Save className="h-4 w-4" />
                      Save
                    </Button>
                    <Button
                      className="gap-2"
                      disabled={aiIdentityMutation.isPending}
                      type="button"
                      variant="outline"
                      onClick={() => setIsEditingIdentity(false)}
                    >
                      <X className="h-4 w-4" />
                      Cancel
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="mt-5 rounded-lg border border-slate-800 bg-slate-950/60 p-4 text-sm leading-6 text-slate-300">
                  {aiIdentityQuery.data?.instructions ??
                    "No custom assistant instructions have been saved yet."}
                </div>
              )}
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
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div className="flex items-center gap-3">
                  <ShieldCheck className="h-5 w-5 text-cyan-200" />
                  <h2 className="text-lg font-semibold text-slate-50">
                    Data requests
                  </h2>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    className="bg-slate-100 text-slate-950 hover:bg-white"
                    size="sm"
                    type="button"
                    disabled={!workspaceId || privacyRequestMutation.isPending}
                    onClick={() => createPrivacyRequest("export")}
                  >
                    <FileDown className="h-4 w-4" />
                    Export
                  </Button>
                  <Button
                    className="border-red-400/40 text-red-100 hover:bg-red-500/10"
                    variant="outline"
                    size="sm"
                    type="button"
                    disabled={!workspaceId || privacyRequestMutation.isPending}
                    onClick={() => createPrivacyRequest("deletion")}
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete data
                  </Button>
                </div>
              </div>
              <div className="mt-5 overflow-hidden rounded-lg border border-slate-800">
                {privacyRequestMutation.error ? (
                  <div className="bg-slate-950/60 px-4 py-3 text-sm text-red-300">
                    Unable to create data request. Please try again.
                  </div>
                ) : privacyRequestsError ? (
                  <div className="bg-slate-950/60 px-4 py-3 text-sm text-red-300">
                    Unable to load data requests. Please try again.
                  </div>
                ) : privacyRequests.length === 0 ? (
                  <div className="bg-slate-950/60 px-4 py-3 text-sm text-slate-400">
                    No data requests yet.
                  </div>
                ) : (
                  <div className="divide-y divide-slate-800">
                    {privacyRequests.slice(0, 4).map(request => (
                      <div
                        className="grid gap-2 bg-slate-950/60 px-4 py-3 text-sm sm:grid-cols-[1fr_auto_auto]"
                        key={request.id}
                      >
                        <span className="font-medium capitalize text-slate-100">
                          {request.requestType}
                        </span>
                        <span className="text-slate-400">
                          {new Date(request.createdAt).toLocaleDateString()}
                        </span>
                        <StatusPill value={request.status} />
                      </div>
                    ))}
                  </div>
                )}
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
