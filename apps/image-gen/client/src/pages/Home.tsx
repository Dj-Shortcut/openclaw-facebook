import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { getLoginUrl } from "@/const";
import { trpc } from "@/lib/trpc";
import {
  Bot,
  CheckCircle2,
  CreditCard,
  Database,
  ExternalLink,
  FileDown,
  FileText,
  Info,
  LogIn,
  MessageCircle,
  Pencil,
  Plus,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";

const FACEBOOK_CONNECT_STATE_KEY = "leaderbot.facebookConnectState";

type FacebookConnectPage = {
  id: string;
  name: string;
  grantedScopes: string[];
};

function StatusPill({ value }: { value: string }) {
  const toneClass =
    value === "connected" || value === "completed"
      ? "bg-emerald-100 text-emerald-800"
      : value === "rejected"
        ? "bg-red-100 text-red-800"
        : value === "processing"
          ? "bg-sky-100 text-sky-800"
          : "bg-amber-100 text-amber-800";
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
  detail,
}: {
  label: string;
  value: string | number;
  detail?: string;
}) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white p-4 shadow-sm">
      <div className="text-sm text-stone-600">{label}</div>
      <div className="mt-2 text-2xl font-semibold text-stone-950">{value}</div>
      {detail ? <div className="mt-2 text-xs text-stone-500">{detail}</div> : null}
    </div>
  );
}

function formatDate(value?: string | Date | null) {
  if (!value) return "Not set";
  return new Date(value).toLocaleDateString();
}

function addDays(value: string | Date, days: number) {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

function isOpenPrivacyRequest(status: string) {
  return status === "requested" || status === "processing";
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
  const [isEditingWorkspace, setIsEditingWorkspace] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [knowledgeForm, setKnowledgeForm] = useState<{
    sourceType: "website" | "manual_text" | "integration";
    name: string;
    sourceReference: string;
  }>({
    sourceType: "website",
    name: "",
    sourceReference: "",
  });
  const [facebookConnectState, setFacebookConnectState] = useState<string | null>(() =>
    typeof window === "undefined"
      ? null
      : window.localStorage.getItem(FACEBOOK_CONNECT_STATE_KEY)
  );
  const [facebookConnectPages, setFacebookConnectPages] = useState<FacebookConnectPage[]>([]);
  const [facebookConnectIssue, setFacebookConnectIssue] = useState<string | null>(null);
  const portalSessionQuery = trpc.portal.auth.session.useQuery(undefined, {
    enabled: auth.isAuthenticated,
  });
  const workspaceQuery = trpc.portal.workspace.current.useQuery(undefined, {
    enabled: auth.isAuthenticated,
  });
  const workspaceId = workspaceQuery.data?.id;
  const workspaceDisplayName =
    portalSessionQuery.data?.workspace.name ??
    workspaceQuery.data?.name ??
    "Leaderbot workspace";
  const workspaceMembersQuery = trpc.portal.workspace.members.useQuery(
    { workspaceId: workspaceId ?? 0 },
    { enabled: Boolean(workspaceId) }
  );
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
  const upgradeRequestsQuery = trpc.portal.usage.upgradeRequests.useQuery(
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
  const upgradeRequestMutation = trpc.portal.usage.requestUpgrade.useMutation({
    onSuccess: async () => {
      if (!workspaceId) return;
      await utils.portal.usage.summary.invalidate({ workspaceId });
      await utils.portal.usage.upgradeRequests.invalidate({ workspaceId });
    },
  });
  const facebookStartMutation = trpc.portal.facebook.startConnect.useMutation({
    onSuccess: data => {
      setFacebookConnectIssue(null);
      setFacebookConnectState(data.state);
      setFacebookConnectPages([]);
      window.localStorage.setItem(FACEBOOK_CONNECT_STATE_KEY, data.state);
      if (data.authorizationUrl) {
        window.location.assign(data.authorizationUrl);
      } else {
        setFacebookConnectIssue("Facebook OAuth is not configured for this portal.");
      }
    },
  });
  const facebookCompleteMutation = trpc.portal.facebook.completeConnect.useMutation({
    onSuccess: data => {
      setFacebookConnectIssue(null);
      setFacebookConnectPages(data.pages);
    },
  });
  const facebookSelectPageMutation = trpc.portal.facebook.selectPage.useMutation({
    onSuccess: async () => {
      if (!workspaceId) return;
      setFacebookConnectIssue(null);
      setFacebookConnectState(null);
      setFacebookConnectPages([]);
      window.localStorage.removeItem(FACEBOOK_CONNECT_STATE_KEY);
      await utils.portal.channels.status.invalidate({ workspaceId });
    },
  });
  const facebookDisconnectMutation = trpc.portal.facebook.disconnect.useMutation({
    onSuccess: async () => {
      if (!workspaceId) return;
      setFacebookConnectIssue(null);
      setFacebookConnectState(null);
      setFacebookConnectPages([]);
      window.localStorage.removeItem(FACEBOOK_CONNECT_STATE_KEY);
      await utils.portal.channels.status.invalidate({ workspaceId });
    },
  });
  const aiIdentityMutation = trpc.portal.aiIdentity.update.useMutation({
    onSuccess: async () => {
      if (!workspaceId) return;
      setIsEditingIdentity(false);
      await utils.portal.aiIdentity.get.invalidate({ workspaceId });
    },
  });
  const workspaceMutation = trpc.portal.workspace.update.useMutation({
    onSuccess: async () => {
      setIsEditingWorkspace(false);
      await utils.portal.workspace.current.invalidate();
      await utils.portal.auth.session.invalidate();
    },
  });
  const knowledgeMutation = trpc.portal.knowledge.registerSource.useMutation({
    onSuccess: async () => {
      if (!workspaceId) return;
      setKnowledgeForm({
        sourceType: "website",
        name: "",
        sourceReference: "",
      });
      await utils.portal.knowledge.summary.invalidate({ workspaceId });
    },
  });
  const knowledgeDisableMutation = trpc.portal.knowledge.disableSource.useMutation({
    onSuccess: async () => {
      if (!workspaceId) return;
      await utils.portal.knowledge.summary.invalidate({ workspaceId });
    },
  });

  const privacy = privacyQuery.data;
  const usage = usageQuery.data;
  const upgradeRequests = upgradeRequestsQuery.data ?? [];
  const latestUpgradeRequest = upgradeRequests[0];
  const facebookStatus = channelStatusQuery.data?.facebook.status ?? "disconnected";
  const knowledgeSources = knowledgeQuery.data?.sources ?? [];
  const privacyRequests = privacyRequestsQuery.data ?? [];
  const privacyRequestsError = privacyRequestsQuery.error;
  const openPrivacyRequests = privacyRequests.filter(request =>
    isOpenPrivacyRequest(request.status)
  );
  const latestPrivacyRequest = privacyRequests[0];
  const imageLimit = usage?.limits.imagesPerDay ?? 0;
  const imagesRemaining = usage?.remaining.imagesToday ?? 0;
  const imageProgress =
    imageLimit > 0
      ? Math.min(100, Math.round(((usage?.imageCount ?? 0) / imageLimit) * 100))
      : 0;
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
  const startEditingWorkspace = () => {
    setWorkspaceName(workspaceDisplayName);
    setIsEditingWorkspace(true);
  };
  const createPrivacyRequest = (requestType: "export" | "deletion") => {
    if (!workspaceId) return;
    privacyRequestMutation.mutate({
      workspaceId,
      requestType,
      note: null,
    });
  };
  const requestUpgrade = () => {
    if (!workspaceId) return;
    upgradeRequestMutation.mutate({ workspaceId });
  };
  const startFacebookConnectFlow = () => {
    if (!workspaceId) return;
    setFacebookConnectIssue(null);
    facebookStartMutation.mutate({ workspaceId });
  };
  const finishFacebookConnectFlow = () => {
    if (!workspaceId || !facebookConnectState) return;
    setFacebookConnectIssue(null);
    facebookCompleteMutation.mutate({
      workspaceId,
      state: facebookConnectState,
    });
  };
  const selectFacebookPage = (pageId: string) => {
    if (!workspaceId || !facebookConnectState) return;
    setFacebookConnectIssue(null);
    facebookSelectPageMutation.mutate({
      workspaceId,
      state: facebookConnectState,
      pageId,
    });
  };
  const disconnectFacebook = () => {
    if (!workspaceId) return;
    facebookDisconnectMutation.mutate({ workspaceId });
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
  const saveWorkspace = async () => {
    if (!workspaceId) return;
    await workspaceMutation.mutateAsync({
      workspaceId,
      name: workspaceName,
    });
  };
  const registerKnowledgeSource = async () => {
    if (!workspaceId) return;
    await knowledgeMutation.mutateAsync({
      workspaceId,
      sourceType: knowledgeForm.sourceType,
      name: knowledgeForm.name,
      sourceReference: knowledgeForm.sourceReference.trim()
        ? knowledgeForm.sourceReference
        : null,
    });
  };
  const disableKnowledgeSource = (sourceId: number) => {
    if (!workspaceId) return;
    knowledgeDisableMutation.mutate({ workspaceId, sourceId });
  };

  if (!auth.isAuthenticated) {
    return (
      <main className="min-h-full bg-[#f6f2ea] px-6 py-10 text-stone-950">
        <div className="mx-auto flex min-h-[70vh] max-w-5xl items-center">
          <section className="w-full rounded-lg border border-stone-200 bg-white p-8 shadow-sm">
            <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-lg bg-teal-100 text-teal-700">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <h1 className="max-w-2xl text-4xl font-semibold text-stone-950">
              Leaderbot customer portal
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-stone-600">
              Continue with Facebook to manage your workspace, AI identity,
              Messenger channel, usage, knowledge, and privacy controls.
            </p>
            <Button
              className="mt-8 gap-2"
              onClick={() => {
                window.location.href = getLoginUrl();
              }}
            >
              <LogIn className="h-4 w-4" />
              Continue with Facebook
            </Button>
          </section>
        </div>
      </main>
    );
  }

  const isLoading =
    auth.loading ||
    portalSessionQuery.isLoading ||
    workspaceQuery.isLoading ||
    workspaceMembersQuery.isLoading ||
    aiIdentityQuery.isLoading ||
    channelStatusQuery.isLoading ||
    usageQuery.isLoading ||
    upgradeRequestsQuery.isLoading ||
    knowledgeQuery.isLoading ||
    privacyQuery.isLoading ||
    privacyRequestsQuery.isLoading;

  return (
    <main className="min-h-full bg-[#f6f2ea] px-4 py-6 text-stone-950 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <header className="flex flex-col gap-4 border-b border-stone-200 pb-6 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm font-medium text-teal-700">Workspace</p>
            {isEditingWorkspace ? (
              <form
                className="mt-2 flex max-w-xl flex-col gap-3 sm:flex-row"
                onSubmit={event => {
                  event.preventDefault();
                  void saveWorkspace();
                }}
              >
                <input
                  className="min-h-10 flex-1 rounded-md border border-stone-300 bg-white px-3 text-base text-stone-950 outline-none focus:border-teal-600"
                  value={workspaceName}
                  maxLength={160}
                  onChange={event => setWorkspaceName(event.target.value)}
                />
                <div className="flex gap-2">
                  <Button
                    className="gap-2"
                    disabled={!workspaceName.trim() || workspaceMutation.isPending}
                    size="sm"
                    type="submit"
                  >
                    <Save className="h-4 w-4" />
                    Save
                  </Button>
                  <Button
                    disabled={workspaceMutation.isPending}
                    size="sm"
                    type="button"
                    variant="outline"
                    onClick={() => setIsEditingWorkspace(false)}
                  >
                    <X className="h-4 w-4" />
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <div className="mt-1 flex flex-wrap items-center gap-3">
                <h1 className="text-3xl font-semibold text-stone-950">
                  {workspaceDisplayName}
                </h1>
                <Button
                  className="gap-2"
                  size="sm"
                  type="button"
                  variant="outline"
                  onClick={startEditingWorkspace}
                >
                  <Pencil className="h-4 w-4" />
                  Rename
                </Button>
              </div>
            )}
            <p className="mt-2 text-sm text-stone-600">
              Signed in as{" "}
              {portalSessionQuery.data?.user.email ??
                auth.user?.email ??
                auth.user?.name ??
                "customer"}
              {portalSessionQuery.data?.membership.role
                ? ` · ${portalSessionQuery.data.membership.role}`
                : ""}
            </p>
            {workspaceMutation.error ? (
              <p className="mt-2 text-sm text-red-700">
                Unable to update the workspace name. Please try again.
              </p>
            ) : null}
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
          <div className="py-12 text-sm text-stone-600">Loading workspace...</div>
        ) : (
          <div className="grid gap-4 py-6 lg:grid-cols-3">
            <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm lg:col-span-3">
              <div className="flex items-center gap-3">
                <ShieldCheck className="h-5 w-5 text-teal-700" />
                <h2 className="text-lg font-semibold text-stone-950">
                  Workspace access
                </h2>
              </div>
              <div className="mt-5 grid gap-3 md:grid-cols-2">
                {(workspaceMembersQuery.data ?? []).map(member => (
                  <div
                    className="flex items-center justify-between gap-4 rounded-lg border border-stone-200 bg-stone-50 p-4"
                    key={member.userId}
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium text-stone-900">
                        {member.name ?? member.email ?? `User ${member.userId}`}
                      </div>
                      <div className="mt-1 truncate text-xs text-stone-500">
                        {member.email ?? "No email on file"}
                      </div>
                    </div>
                    <StatusPill value={member.role} />
                  </div>
                ))}
              </div>
              {workspaceMembersQuery.error ? (
                <p className="mt-4 text-sm text-red-700">
                  Unable to load workspace access.
                </p>
              ) : (workspaceMembersQuery.data ?? []).length === 0 ? (
                <p className="mt-4 text-sm text-stone-600">
                  No workspace members found.
                </p>
              ) : null}
            </section>

            <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm lg:col-span-2">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <Bot className="mt-1 h-5 w-5 text-teal-700" />
                  <div>
                    <h2 className="text-lg font-semibold text-stone-950">
                      {aiIdentityQuery.data?.name ?? "Leaderbot"}
                    </h2>
                    <p className="mt-1 text-sm text-stone-600">
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
                    <label className="grid gap-2 text-sm text-stone-700">
                      Name
                      <input
                        className="rounded border border-stone-300 bg-white px-3 py-2 text-stone-950"
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
                    <label className="grid gap-2 text-sm text-stone-700">
                      Tone
                      <input
                        className="rounded border border-stone-300 bg-white px-3 py-2 text-stone-950"
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
                    <label className="grid gap-2 text-sm text-stone-700">
                      Language
                      <input
                        className="rounded border border-stone-300 bg-white px-3 py-2 text-stone-950"
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
                    <label className="grid gap-2 text-sm text-stone-700">
                      Model default
                      <input
                        className="rounded border border-stone-300 bg-white px-3 py-2 text-stone-950"
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
                  <label className="grid gap-2 text-sm text-stone-700">
                    Instructions
                    <textarea
                      className="min-h-36 rounded border border-stone-300 bg-white px-3 py-2 text-stone-950"
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
                    <div className="text-sm text-red-700">
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
                <div className="mt-5 rounded-lg border border-stone-200 bg-stone-50 p-4 text-sm leading-6 text-stone-700">
                  {aiIdentityQuery.data?.instructions ??
                    "No custom assistant instructions have been saved yet."}
                </div>
              )}
            </section>

            <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <MessageCircle className="h-5 w-5 text-teal-700" />
                  <h2 className="text-lg font-semibold text-stone-950">Messenger</h2>
                </div>
                {facebookStatus !== "connected" ? (
                  <Button
                    className="gap-2"
                    disabled={!workspaceId || facebookStartMutation.isPending}
                    size="sm"
                    type="button"
                    onClick={startFacebookConnectFlow}
                  >
                    <ExternalLink className="h-4 w-4" />
                    {facebookStatus === "disconnected" ? "Connect Page" : "Reconnect"}
                  </Button>
                ) : (
                  <Button
                    disabled={!workspaceId || facebookDisconnectMutation.isPending}
                    size="sm"
                    type="button"
                    variant="outline"
                    onClick={disconnectFacebook}
                  >
                    {facebookDisconnectMutation.isPending ? "Disconnecting" : "Disconnect"}
                  </Button>
                )}
              </div>
              <div className="mt-5 space-y-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-stone-600">Status</span>
                  <StatusPill
                    value={facebookStatus}
                  />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-stone-600">Page</span>
                  <span className="text-right text-stone-800">
                    {channelStatusQuery.data?.facebook.pageName ?? "Not connected"}
                  </span>
                </div>
              </div>
              {facebookConnectState && facebookStatus !== "connected" ? (
                <div className="mt-5 rounded-lg border border-teal-200 bg-teal-50 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-sm font-medium text-teal-900">
                        Facebook authorization pending
                      </div>
                      <div className="mt-1 text-sm text-teal-700">
                        Finish setup after returning from Meta.
                      </div>
                    </div>
                    <Button
                      className="gap-2 bg-teal-700 text-white hover:bg-teal-800"
                      disabled={!workspaceId || facebookCompleteMutation.isPending}
                      size="sm"
                      type="button"
                      onClick={finishFacebookConnectFlow}
                    >
                      <CheckCircle2 className="h-4 w-4" />
                      {facebookCompleteMutation.isPending ? "Checking" : "Finish setup"}
                    </Button>
                  </div>
                </div>
              ) : null}
              {facebookConnectPages.length > 0 ? (
                <div className="mt-4 space-y-2">
                  {facebookConnectPages.map(page => {
                    const isSelecting =
                      facebookSelectPageMutation.isPending &&
                      facebookSelectPageMutation.variables?.pageId === page.id;
                    return (
                      <button
                        className="flex w-full items-center justify-between gap-3 rounded-lg border border-stone-200 bg-stone-50 p-3 text-left hover:border-teal-500 disabled:opacity-60"
                        disabled={facebookSelectPageMutation.isPending}
                        key={page.id}
                        type="button"
                        onClick={() => selectFacebookPage(page.id)}
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-stone-900">
                            {page.name}
                          </span>
                          <span className="mt-1 block text-xs text-stone-500">
                            {page.grantedScopes.length} permissions granted
                          </span>
                        </span>
                        <span className="text-sm text-teal-700">
                          {isSelecting ? "Connecting" : "Select"}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {facebookConnectIssue ? (
                <p className="mt-4 text-sm text-red-700">{facebookConnectIssue}</p>
              ) : facebookStartMutation.error ? (
                <p className="mt-4 text-sm text-red-700">
                  Unable to start Facebook connection. Please try again.
                </p>
              ) : facebookCompleteMutation.error ? (
                <p className="mt-4 text-sm text-red-700">
                  Unable to finish Facebook connection. Please start again.
                </p>
              ) : facebookSelectPageMutation.error ? (
                <p className="mt-4 text-sm text-red-700">
                  Unable to connect that Page. Please try again.
                </p>
              ) : facebookSelectPageMutation.isSuccess ? (
                <p className="mt-4 text-sm text-emerald-700">
                  Messenger connected for this workspace.
                </p>
              ) : facebookDisconnectMutation.isSuccess ? (
                <p className="mt-4 text-sm text-emerald-700">
                  Messenger disconnected for this workspace.
                </p>
              ) : facebookDisconnectMutation.error ? (
                <p className="mt-4 text-sm text-red-700">
                  Unable to disconnect Messenger. Please try again.
                </p>
              ) : null}
            </section>

            <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm lg:col-span-3">
              <div className="flex items-center gap-3">
                <Info className="h-5 w-5 text-teal-700" />
                <h2 className="text-lg font-semibold text-stone-950">
                  Bot instructions
                </h2>
              </div>
              <div className="mt-5 grid gap-4 md:grid-cols-3">
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                  <h3 className="text-sm font-medium text-stone-900">
                    Prompt-first images
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-stone-600">
                    Ask naturally in Messenger. Describe the image or edit you want;
                    no style menu is required.
                  </p>
                </div>
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                  <h3 className="text-sm font-medium text-stone-900">
                    Workspace context
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-stone-600">
                    The assistant uses this workspace's identity, instructions, and
                    active knowledge sources.
                  </p>
                </div>
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                  <h3 className="text-sm font-medium text-stone-900">
                    Data controls
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-stone-600">
                    Use the portal to request exports or deletion. Messenger users can
                    also send "delete my data".
                  </p>
                </div>
              </div>
            </section>

            <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm lg:col-span-3">
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
                <div className="flex items-center gap-3">
                  <CreditCard className="h-5 w-5 text-teal-700" />
                  <div>
                    <h2 className="text-lg font-semibold text-stone-950">
                      Usage and balance
                    </h2>
                    <p className="mt-1 text-sm text-stone-600">
                      {usage?.plan.name ?? "Free"} plan
                    </p>
                  </div>
                </div>
                {usage?.upgrade.recommended ? (
                  <Button
                    className="gap-2"
                    disabled={!workspaceId || upgradeRequestMutation.isPending}
                    size="sm"
                    type="button"
                    onClick={requestUpgrade}
                  >
                    {upgradeRequestMutation.isPending ? "Requesting" : "Upgrade"}
                  </Button>
                ) : null}
              </div>
              <div className="mt-5 grid gap-4 sm:grid-cols-3">
                <MetricTile
                  label="Images remaining"
                  value={imagesRemaining}
                  detail={`${usage?.imageCount ?? 0} of ${imageLimit} used today`}
                />
                <MetricTile
                  label="Messages today"
                  value={usage?.messageCount ?? 0}
                  detail={`${usage?.limits.messagesPerWindow ?? 0} per ${
                    usage?.limits.messageWindowSeconds ?? 0
                  } seconds`}
                />
                <MetricTile
                  label="Blocked today"
                  value={usage?.blockedCount ?? 0}
                  detail={
                    usage?.upgrade.reason === "blocked_usage"
                      ? "Action may be needed"
                      : "No blocks recorded"
                  }
                />
              </div>
              <div className="mt-5 h-2 overflow-hidden rounded-full bg-stone-200">
                <div
                  className="h-full rounded-full bg-teal-600"
                  style={{ width: `${imageProgress}%` }}
                />
              </div>
              {upgradeRequestMutation.isSuccess ? (
                <p className="mt-4 text-sm text-emerald-700">
                  Upgrade request recorded for this workspace.
                </p>
              ) : upgradeRequestMutation.error ? (
                <p className="mt-4 text-sm text-red-700">
                  Unable to record the upgrade request. Please try again.
                </p>
              ) : null}
              <div className="mt-5 overflow-hidden rounded-lg border border-stone-200">
                {upgradeRequestsQuery.error ? (
                  <div className="bg-red-50 px-4 py-3 text-sm text-red-700">
                    Unable to load upgrade requests. Please try again.
                  </div>
                ) : upgradeRequests.length === 0 ? (
                  <div className="bg-stone-50 px-4 py-3 text-sm text-stone-600">
                    No upgrade requests yet.
                  </div>
                ) : (
                  <div className="divide-y divide-stone-200">
                    {upgradeRequests.slice(0, 3).map(request => (
                      <div
                        className="grid gap-2 bg-stone-50 px-4 py-3 text-sm md:grid-cols-[1fr_auto_auto]"
                        key={request.id}
                      >
                        <div>
                          <div className="font-medium text-stone-900">
                            {request.requestedPlanName} upgrade
                          </div>
                          <div className="mt-1 text-xs text-stone-500">
                            {request.upgradeReason?.replace(/_/g, " ") ??
                              "Customer requested"}
                          </div>
                        </div>
                        <span className="text-stone-600">
                          {formatDate(request.createdAt)}
                        </span>
                        <StatusPill value={request.status} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {latestUpgradeRequest ? (
                <p className="mt-3 text-xs text-stone-500">
                  Latest upgrade request: {latestUpgradeRequest.status.replace(/_/g, " ")}
                  {" · "}
                  {formatDate(latestUpgradeRequest.createdAt)}
                </p>
              ) : null}
            </section>

            <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm lg:col-span-3">
              <div className="flex items-center gap-3">
                <SlidersHorizontal className="h-5 w-5 text-teal-700" />
                <h2 className="text-lg font-semibold text-stone-950">
                  Privacy controls
                </h2>
              </div>
              <div className="mt-5 grid gap-4 md:grid-cols-3">
                <label className="flex min-h-24 items-start justify-between gap-4 rounded-lg border border-stone-200 bg-stone-50 p-4">
                  <span>
                    <span className="block text-sm font-medium text-stone-900">
                      Knowledge indexing
                    </span>
                    <span className="mt-1 block text-sm text-stone-600">
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
                <label className="flex min-h-24 items-start justify-between gap-4 rounded-lg border border-stone-200 bg-stone-50 p-4">
                  <span>
                    <span className="block text-sm font-medium text-stone-900">
                      Usage analytics
                    </span>
                    <span className="mt-1 block text-sm text-stone-600">
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
                <label className="flex min-h-24 items-start justify-between gap-4 rounded-lg border border-stone-200 bg-stone-50 p-4">
                  <span>
                    <span className="block text-sm font-medium text-stone-900">
                      Image memory retention
                    </span>
                    <span className="mt-1 block text-sm text-stone-600">
                      Days retained: {privacy?.imageMemoryRetentionDays ?? 0}
                    </span>
                  </span>
                  <input
                    className="w-24 rounded border border-stone-300 bg-white px-2 py-1 text-right text-sm text-stone-950"
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

            <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm lg:col-span-3">
              <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                <div className="flex items-center gap-3">
                  <ShieldCheck className="h-5 w-5 text-teal-700" />
                  <h2 className="text-lg font-semibold text-stone-950">
                    Data requests
                  </h2>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    className="bg-stone-900 text-white hover:bg-stone-800"
                    size="sm"
                    type="button"
                    disabled={!workspaceId || privacyRequestMutation.isPending}
                    onClick={() => createPrivacyRequest("export")}
                  >
                    <FileDown className="h-4 w-4" />
                    Export
                  </Button>
                  <Button
                    className="border-red-300 text-red-700 hover:bg-red-50"
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
              <div className="mt-5 grid gap-4 sm:grid-cols-3">
                <MetricTile
                  label="Open requests"
                  value={openPrivacyRequests.length}
                  detail="Export or deletion requests in progress"
                />
                <MetricTile
                  label="Latest request"
                  value={latestPrivacyRequest?.requestType ?? "None"}
                  detail={
                    latestPrivacyRequest
                      ? `${latestPrivacyRequest.status} · ${formatDate(
                          latestPrivacyRequest.createdAt
                        )}`
                      : "No data requests yet"
                  }
                />
                <MetricTile
                  label="Target date"
                  value={
                    latestPrivacyRequest &&
                    isOpenPrivacyRequest(latestPrivacyRequest.status)
                      ? formatDate(addDays(latestPrivacyRequest.createdAt, 30))
                      : "None"
                  }
                  detail="Standard 30-day response target"
                />
              </div>
              <div className="mt-5 overflow-hidden rounded-lg border border-stone-200">
                {privacyRequestMutation.error ? (
                  <div className="bg-red-50 px-4 py-3 text-sm text-red-700">
                    Unable to create data request. Please try again.
                  </div>
                ) : privacyRequestsError ? (
                  <div className="bg-red-50 px-4 py-3 text-sm text-red-700">
                    Unable to load data requests. Please try again.
                  </div>
                ) : privacyRequests.length === 0 ? (
                  <div className="bg-stone-50 px-4 py-3 text-sm text-stone-600">
                    No data requests yet.
                  </div>
                ) : (
                  <div className="divide-y divide-stone-200">
                    {privacyRequests.slice(0, 4).map(request => (
                      <div
                        className="grid gap-2 bg-stone-50 px-4 py-3 text-sm sm:grid-cols-[1fr_auto_auto]"
                        key={request.id}
                      >
                        <span className="font-medium capitalize text-stone-900">
                          {request.requestType}
                        </span>
                        <span className="text-stone-600">
                          {formatDate(request.createdAt)}
                        </span>
                        <StatusPill value={request.status} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm lg:col-span-3">
              <div className="flex items-center gap-3">
                <Database className="h-5 w-5 text-teal-700" />
                <h2 className="text-lg font-semibold text-stone-950">Knowledge base</h2>
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
              <form
                className="mt-5 grid gap-3 rounded-lg border border-stone-200 bg-stone-50 p-4 md:grid-cols-[160px_1fr_1fr_auto]"
                onSubmit={event => {
                  event.preventDefault();
                  void registerKnowledgeSource();
                }}
              >
                <label className="grid gap-2 text-sm text-stone-700">
                  Type
                  <select
                    className="h-10 rounded border border-stone-300 bg-white px-3 text-stone-950"
                    value={knowledgeForm.sourceType}
                    disabled={knowledgeMutation.isPending}
                    onChange={event =>
                      setKnowledgeForm(current => ({
                        ...current,
                        sourceType: event.target.value as typeof knowledgeForm.sourceType,
                      }))
                    }
                  >
                    <option value="website">Website</option>
                    <option value="manual_text">Manual text</option>
                    <option value="integration">Integration</option>
                  </select>
                </label>
                <label className="grid gap-2 text-sm text-stone-700">
                  Name
                  <input
                    className="h-10 rounded border border-stone-300 bg-white px-3 text-stone-950"
                    maxLength={200}
                    required
                    value={knowledgeForm.name}
                    disabled={knowledgeMutation.isPending}
                    onChange={event =>
                      setKnowledgeForm(current => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                  />
                </label>
                <label className="grid gap-2 text-sm text-stone-700">
                  Reference
                  <input
                    className="h-10 rounded border border-stone-300 bg-white px-3 text-stone-950"
                    maxLength={1024}
                    value={knowledgeForm.sourceReference}
                    disabled={knowledgeMutation.isPending}
                    onChange={event =>
                      setKnowledgeForm(current => ({
                        ...current,
                        sourceReference: event.target.value,
                      }))
                    }
                  />
                </label>
                <div className="flex items-end">
                  <Button
                    className="h-10 gap-2"
                    disabled={knowledgeMutation.isPending}
                    type="submit"
                  >
                    <Plus className="h-4 w-4" />
                    Add
                  </Button>
                </div>
              </form>
              {knowledgeMutation.error ? (
                <div className="mt-3 text-sm text-red-700">
                  Unable to save knowledge source. Please try again.
                </div>
              ) : knowledgeDisableMutation.error ? (
                <div className="mt-3 text-sm text-red-700">
                  Unable to disable knowledge source. Please try again.
                </div>
              ) : null}
              <div className="mt-5 overflow-hidden rounded-lg border border-stone-200">
                {knowledgeQuery.error ? (
                  <div className="bg-red-50 px-4 py-3 text-sm text-red-700">
                    Unable to load knowledge sources. Please try again.
                  </div>
                ) : knowledgeSources.length === 0 ? (
                  <div className="bg-stone-50 px-4 py-3 text-sm text-stone-600">
                    No knowledge sources yet.
                  </div>
                ) : (
                  <div className="divide-y divide-stone-200">
                    {knowledgeSources.slice(0, 5).map(source => (
                      <div
                        className="grid gap-2 bg-stone-50 px-4 py-3 text-sm md:grid-cols-[1fr_auto_auto_auto]"
                        key={source.id}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 font-medium text-stone-900">
                            <FileText className="h-4 w-4 shrink-0 text-stone-500" />
                            <span className="truncate">{source.name}</span>
                          </div>
                          <div className="mt-1 truncate text-xs text-stone-500">
                            {source.sourceReference || source.sourceType.replace(/_/g, " ")}
                          </div>
                        </div>
                        <span className="text-stone-600">
                          {source.sourceType.replace(/_/g, " ")}
                        </span>
                        <StatusPill value={source.status} />
                        {source.status === "disabled" ? (
                          <span className="text-xs text-stone-500">Disabled</span>
                        ) : (
                          <Button
                            size="sm"
                            type="button"
                            variant="outline"
                            disabled={knowledgeDisableMutation.isPending}
                            onClick={() => disableKnowledgeSource(source.id)}
                          >
                            Disable
                          </Button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>
        )}
      </div>
    </main>
  );
}

export default Home;
