import { useAuth } from "@/_core/hooks/useAuth";
import {
  clearActiveWorkspaceId,
  getWorkspaceIdFromLocation,
  readActiveWorkspaceId,
  writeActiveWorkspaceId,
} from "@/_core/portalWorkspace";
import { Button } from "@/components/ui/button";
import { getLoginUrl, isLoginConfigured } from "@/const";
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
import { useEffect, useState } from "react";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  portalCopies,
  resolveLocale,
  type AppLocale,
  type PortalCopy,
} from "./portalLocales";

const FACEBOOK_CONNECT_STATE_KEY = "leaderbot.facebookConnectState";
const LOCALE_STORAGE_KEY = "leaderbot.portal.locale";

type FacebookConnectPage = {
  id: string;
  name: string;
  grantedScopes: string[];
};

function readBrowserStorage(key: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeBrowserStorage(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    return;
  }
}

function removeBrowserStorage(key: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    return;
  }
}

function getInitialLocale(): AppLocale {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  return resolveLocale(readBrowserStorage(LOCALE_STORAGE_KEY));
}

function statusLabel(value: string, copy: PortalCopy) {
  return copy.status[value as keyof PortalCopy["status"]] ?? value.replace(/_/g, " ");
}

function sourceTypeLabel(value: string, copy: PortalCopy) {
  if (value === "manual_text") return copy.knowledge.manualText;
  if (value === "integration") return copy.knowledge.integration;
  if (value === "website") return copy.knowledge.website;
  return value.replace(/_/g, " ");
}

function upgradeReasonLabel(value: string | null | undefined, copy: PortalCopy) {
  if (!value) return copy.usage.customerRequested;
  return (
    copy.upgradeReasons[value as keyof PortalCopy["upgradeReasons"]] ??
    value.replace(/_/g, " ")
  );
}

function requestTypeLabel(value: string | null | undefined, copy: PortalCopy) {
  if (!value) return copy.common.none;
  return (
    copy.requestTypes[value as keyof PortalCopy["requestTypes"]] ??
    value.replace(/_/g, " ")
  );
}

function formatPlanName(value: string | null | undefined, copy: PortalCopy) {
  if (!value || value.toLowerCase() === "free") return copy.common.free;
  return value;
}

function localeButtonLabel(locale: AppLocale, copy: PortalCopy) {
  switch (locale) {
    case "nl-BE":
      return copy.locale.nl;
    case "fr-BE":
      return copy.locale.fr;
    case "en":
      return copy.locale.en;
  }
}

function LocaleSwitcher({
  copy,
  locale,
  onChange,
}: {
  copy: PortalCopy;
  locale: AppLocale;
  onChange: (locale: AppLocale) => void;
}) {
  return (
    <div
      aria-label={copy.locale.label}
      className="inline-grid grid-cols-3 gap-1 rounded-lg border border-stone-300 bg-white p-1"
      role="group"
    >
      {SUPPORTED_LOCALES.map(localeOption => (
        <button
          aria-pressed={localeOption === locale}
          className={`min-h-8 rounded-md px-3 text-xs font-semibold transition-colors ${
            localeOption === locale
              ? "bg-teal-700 text-white"
              : "text-stone-700 hover:bg-stone-100"
          }`}
          key={localeOption}
          type="button"
          onClick={() => onChange(localeOption)}
        >
          {localeButtonLabel(localeOption, copy)}
        </button>
      ))}
    </div>
  );
}

function StatusPill({ copy, value }: { copy: PortalCopy; value: string }) {
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
      {statusLabel(value, copy)}
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

function formatDate(
  value: string | Date | null | undefined,
  locale: AppLocale,
  copy: PortalCopy
) {
  if (!value) return copy.common.none;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return copy.common.none;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

function addDays(value: string | Date, days: number) {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

function isOpenPrivacyRequest(status: string) {
  return status === "requested" || status === "processing";
}

function hasHandoffOnboardingFlag() {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("onboarding") === "handoff";
}

type PublicPreviewView =
  | "dashboard"
  | "identity"
  | "channels"
  | "knowledge"
  | "usage"
  | "privacy";

const publicPreviewItems: Array<{
  view: PublicPreviewView;
  icon: typeof ShieldCheck;
  label: (copy: PortalCopy) => string;
}> = [
  { view: "dashboard", icon: ShieldCheck, label: copy => copy.guidance.title },
  { view: "identity", icon: Bot, label: copy => copy.identity.fallbackName },
  { view: "channels", icon: MessageCircle, label: copy => copy.messenger.title },
  { view: "knowledge", icon: Database, label: copy => copy.knowledge.title },
  { view: "usage", icon: CreditCard, label: copy => copy.usage.title },
  { view: "privacy", icon: SlidersHorizontal, label: copy => copy.privacy.controlsTitle },
];

function PublicPortalPreview({
  copy,
  locale,
  loginConfigured,
  onLocaleChange,
}: {
  copy: PortalCopy;
  locale: AppLocale;
  loginConfigured: boolean;
  onLocaleChange: (locale: AppLocale) => void;
}) {
  const [view, setView] = useState<PublicPreviewView>("dashboard");

  return (
    <main className="min-h-full bg-[#f5f7fb] text-stone-950">
      <div className="grid min-h-screen lg:grid-cols-[260px_minmax(0,1fr)]">
        <aside className="flex flex-col gap-7 bg-[#13231f] px-5 py-6 text-white">
          <div className="flex items-center gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-lg bg-lime-300 font-black text-[#10211d]">
              L
            </div>
            <div>
              <div className="font-semibold">Leaderbot</div>
              <div className="text-sm text-stone-300">{copy.auth.title}</div>
            </div>
          </div>
          <LocaleSwitcher copy={copy} locale={locale} onChange={onLocaleChange} />
          <nav className="grid gap-2" aria-label={copy.auth.title}>
            {publicPreviewItems.map(item => {
              const Icon = item.icon;
              const isActive = item.view === view;
              return (
                <button
                  aria-pressed={isActive}
                  className={`flex min-h-11 items-center gap-3 rounded-lg px-3 text-left text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-lime-300 text-[#10211d]"
                      : "text-stone-200 hover:bg-white/10"
                  }`}
                  key={item.view}
                  type="button"
                  onClick={() => setView(item.view)}
                >
                  <Icon className="h-4 w-4" />
                  {item.label(copy)}
                </button>
              );
            })}
          </nav>
          <p className="mt-auto text-sm leading-6 text-stone-300">
            {copy.publicPreview.customerDataNotice}
          </p>
        </aside>

        <section className="min-w-0 px-5 py-7 sm:px-8">
          <header className="mb-6 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-normal text-stone-500">
                {copy.common.workspace}
              </p>
              <h1 className="text-4xl font-semibold leading-tight text-stone-950">
                {copy.publicPreview.workspaceTitle}
              </h1>
              <p className="mt-3 max-w-2xl text-sm leading-6 text-stone-600">
                {copy.auth.body}
              </p>
            </div>
            <Button
              className="gap-2 self-start"
              disabled={!loginConfigured}
              onClick={() => {
                const loginUrl = getLoginUrl();
                if (!loginUrl) return;
                window.location.href = loginUrl;
              }}
            >
              <LogIn className="h-4 w-4" />
              {copy.auth.continueWithFacebook}
            </Button>
          </header>

          {!loginConfigured ? (
            <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
              {copy.publicPreview.loginNotConfigured}
            </div>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.5fr)_minmax(260px,0.8fr)]">
            <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
              {view === "dashboard" ? (
                <>
                  <h2 className="text-2xl font-semibold">
                    {copy.publicPreview.dashboardTitle}
                  </h2>
                  <div className="mt-5 grid gap-3 sm:grid-cols-3">
                    <MetricTile
                      label={copy.usage.imagesRemaining}
                      value={14}
                      detail={`6 ${copy.usage.imagesUsedDetail.replace("{limit}", "20")}`}
                    />
                    <MetricTile label={copy.usage.messagesToday} value={18} />
                    <MetricTile
                      label={copy.knowledge.active}
                      value={1}
                      detail={copy.publicPreview.sourcesDetail.replace("{count}", "2")}
                    />
                  </div>
                </>
              ) : null}
              {view === "identity" ? (
                <>
                  <h2 className="text-2xl font-semibold">{copy.identity.fallbackName}</h2>
                  <p className="mt-3 rounded-lg border border-stone-200 bg-stone-50 p-4 text-sm leading-6 text-stone-700">
                    {copy.publicPreview.identityHelp}
                  </p>
                </>
              ) : null}
              {view === "channels" ? (
                <>
                  <h2 className="text-2xl font-semibold">{copy.messenger.title}</h2>
                  <div className="mt-5 flex items-center justify-between rounded-lg border border-stone-200 bg-stone-50 p-4">
                    <span>Facebook Messenger</span>
                    <StatusPill copy={copy} value="disconnected" />
                  </div>
                </>
              ) : null}
              {view === "knowledge" ? (
                <>
                  <h2 className="text-2xl font-semibold">{copy.knowledge.title}</h2>
                  <div className="mt-5 grid gap-3">
                    <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                      {copy.publicPreview.customerFaq} ·{" "}
                      <StatusPill copy={copy} value="active" />
                    </div>
                    <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                      {copy.publicPreview.brandVoiceNotes} ·{" "}
                      <StatusPill copy={copy} value="queued" />
                    </div>
                  </div>
                </>
              ) : null}
              {view === "usage" ? (
                <>
                  <h2 className="text-2xl font-semibold">{copy.usage.title}</h2>
                  <div className="mt-5 grid gap-3 sm:grid-cols-3">
                    <MetricTile label={copy.usage.imagesRemaining} value={14} />
                    <MetricTile label={copy.usage.messagesToday} value={18} />
                    <MetricTile label={copy.usage.blockedToday} value={0} />
                  </div>
                </>
              ) : null}
              {view === "privacy" ? (
                <>
                  <h2 className="text-2xl font-semibold">{copy.privacy.controlsTitle}</h2>
                  <div className="mt-5 grid gap-3">
                    <div className="flex justify-between rounded-lg border border-stone-200 bg-stone-50 p-4">
                      <span>{copy.privacy.knowledgeIndexing}</span>
                      <StatusPill copy={copy} value="active" />
                    </div>
                    <div className="flex justify-between rounded-lg border border-stone-200 bg-stone-50 p-4">
                      <span>{copy.privacy.usageAnalytics}</span>
                      <StatusPill copy={copy} value="disabled" />
                    </div>
                  </div>
                </>
              ) : null}
            </section>

            <aside className="space-y-4">
              <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
                <h2 className="text-lg font-semibold">{copy.messenger.connectPage}</h2>
                <p className="mt-2 text-sm leading-6 text-stone-600">
                  {copy.publicPreview.messengerInactive}
                </p>
              </section>
              <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
                <h2 className="text-lg font-semibold">{copy.footer.privacy}</h2>
                <div className="mt-3 flex flex-wrap gap-3 text-sm">
                  <a className="text-teal-700 underline" href="/privacy">
                    {copy.footer.privacy}
                  </a>
                  <a className="text-teal-700 underline" href="/terms">
                    {copy.footer.terms}
                  </a>
                  <a className="text-teal-700 underline" href="/data-deletion">
                    {copy.footer.dataDeletion}
                  </a>
                </div>
              </section>
            </aside>
          </div>
        </section>
      </div>
    </main>
  );
}

function Home() {
  const auth = useAuth();
  const utils = trpc.useUtils();
  const loginConfigured = isLoginConfigured();
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<number | null>(
    () => getWorkspaceIdFromLocation() ?? readActiveWorkspaceId()
  );
  const [showHandoffBanner] = useState(hasHandoffOnboardingFlag);
  const [locale, setLocale] = useState<AppLocale>(getInitialLocale);
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
    readBrowserStorage(FACEBOOK_CONNECT_STATE_KEY)
  );
  const [facebookConnectPages, setFacebookConnectPages] = useState<FacebookConnectPage[]>([]);
  const [facebookConnectIssue, setFacebookConnectIssue] = useState<string | null>(null);
  const copy = portalCopies[locale];

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const changeLocale = (nextLocale: AppLocale) => {
    setLocale(nextLocale);
    writeBrowserStorage(LOCALE_STORAGE_KEY, nextLocale);
  };

  const portalSessionQuery = trpc.portal.auth.session.useQuery(
    activeWorkspaceId ? { workspaceId: activeWorkspaceId } : undefined,
    {
      enabled: auth.isAuthenticated,
    }
  );
  const currentWorkspaceQuery = trpc.portal.workspace.current.useQuery(undefined, {
    enabled: auth.isAuthenticated && !activeWorkspaceId,
  });
  const activeWorkspaceQuery = trpc.portal.workspace.get.useQuery(
    { workspaceId: activeWorkspaceId ?? 0 },
    {
      enabled: auth.isAuthenticated && Boolean(activeWorkspaceId),
    }
  );
  const workspace = activeWorkspaceQuery.data ?? currentWorkspaceQuery.data;
  const workspaceId = workspace?.id ?? portalSessionQuery.data?.workspace.id;
  const workspaceDisplayName =
    portalSessionQuery.data?.workspace.name ??
    workspace?.name ??
    "Leaderbot workspace";

  useEffect(() => {
    if (!activeWorkspaceId) return;
    writeActiveWorkspaceId(activeWorkspaceId);
  }, [activeWorkspaceId]);

  useEffect(() => {
    if (!activeWorkspaceId || !activeWorkspaceQuery.error) return;
    clearActiveWorkspaceId();
    setActiveWorkspaceId(null);
    if (typeof window !== "undefined" && window.location.search) {
      const url = new URL(window.location.href);
      url.searchParams.delete("workspaceId");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, [activeWorkspaceId, activeWorkspaceQuery.error]);

  const workspaceQuery = activeWorkspaceId ? activeWorkspaceQuery : currentWorkspaceQuery;
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
      writeBrowserStorage(FACEBOOK_CONNECT_STATE_KEY, data.state);
      if (data.authorizationUrl) {
        window.location.assign(data.authorizationUrl);
      } else {
        setFacebookConnectIssue(copy.messenger.oauthMissing);
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
      removeBrowserStorage(FACEBOOK_CONNECT_STATE_KEY);
      await utils.portal.channels.status.invalidate({ workspaceId });
    },
  });
  const facebookDisconnectMutation = trpc.portal.facebook.disconnect.useMutation({
    onSuccess: async () => {
      if (!workspaceId) return;
      setFacebookConnectIssue(null);
      setFacebookConnectState(null);
      setFacebookConnectPages([]);
      removeBrowserStorage(FACEBOOK_CONNECT_STATE_KEY);
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
      if (workspaceId) {
        await utils.portal.workspace.get.invalidate({ workspaceId });
      }
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
      <PublicPortalPreview
        copy={copy}
        locale={locale}
        loginConfigured={loginConfigured}
        onLocaleChange={changeLocale}
      />
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
    <main className="min-h-full bg-[#f5f7fb] px-4 py-6 text-stone-950 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-7xl">
        <header className="flex flex-col gap-4 border-b border-stone-200 pb-6 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-sm font-medium text-teal-700">{copy.common.workspace}</p>
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
                    {copy.common.save}
                  </Button>
                  <Button
                    disabled={workspaceMutation.isPending}
                    size="sm"
                    type="button"
                    variant="outline"
                    onClick={() => setIsEditingWorkspace(false)}
                  >
                    <X className="h-4 w-4" />
                    {copy.common.cancel}
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
                  {copy.common.rename}
                </Button>
              </div>
            )}
            <p className="mt-2 text-sm text-stone-600">
              {copy.header.signedInAs}{" "}
              {portalSessionQuery.data?.user.email ??
                auth.user?.email ??
                auth.user?.name ??
                copy.common.customer}
              {portalSessionQuery.data?.membership.role
                ? ` · ${statusLabel(portalSessionQuery.data.membership.role, copy)}`
                : ""}
            </p>
            {workspaceMutation.error ? (
              <p className="mt-2 text-sm text-red-700">
                {copy.header.updateWorkspaceError}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <LocaleSwitcher copy={copy} locale={locale} onChange={changeLocale} />
            <Button
              variant="outline"
              onClick={() => {
                void auth.logout();
              }}
            >
              {copy.common.signOut}
            </Button>
          </div>
        </header>

        {showHandoffBanner ? (
          <section className="mt-5 rounded-lg border border-teal-200 bg-teal-50 p-4 text-teal-950">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-teal-700" />
              <div>
                <h2 className="text-sm font-semibold">Premium workspace claimed</h2>
                <p className="mt-1 text-sm leading-6 text-teal-800">
                  Your Messenger setup link is secured to this workspace. Finish the
                  AI identity, knowledge, channel, and privacy settings here.
                </p>
              </div>
            </div>
          </section>
        ) : null}

        {isLoading ? (
          <div className="py-12 text-sm text-stone-600">
            {copy.common.loadingWorkspace}
          </div>
        ) : (
          <div className="grid gap-4 py-6 lg:grid-cols-3">
            <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm lg:col-span-3">
              <div className="flex items-center gap-3">
                <ShieldCheck className="h-5 w-5 text-teal-700" />
                <h2 className="text-lg font-semibold text-stone-950">
                  {copy.workspaceAccess.title}
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
                        {member.name ??
                          member.email ??
                          `${copy.common.user} ${member.userId}`}
                      </div>
                      <div className="mt-1 truncate text-xs text-stone-500">
                        {member.email ?? copy.common.noEmail}
                      </div>
                    </div>
                    <StatusPill copy={copy} value={member.role} />
                  </div>
                ))}
              </div>
              {workspaceMembersQuery.error ? (
                <p className="mt-4 text-sm text-red-700">
                  {copy.workspaceAccess.unableToLoad}
                </p>
              ) : (workspaceMembersQuery.data ?? []).length === 0 ? (
                <p className="mt-4 text-sm text-stone-600">
                  {copy.workspaceAccess.empty}
                </p>
              ) : null}
            </section>

            <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm lg:col-span-2">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <Bot className="mt-1 h-5 w-5 text-teal-700" />
                  <div>
                    <h2 className="text-lg font-semibold text-stone-950">
                      {aiIdentityQuery.data?.name ?? copy.identity.fallbackName}
                    </h2>
                    <p className="mt-1 text-sm text-stone-600">
                      {aiIdentityQuery.data?.tone ?? copy.identity.fallbackTone} ·{" "}
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
                    {copy.common.edit}
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
                      {copy.identity.assistantName}
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
                      {copy.identity.tone}
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
                      {copy.identity.language}
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
                      {copy.identity.modelDefault}
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
                    {copy.identity.instructions}
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
                      {copy.common.save}
                    </Button>
                    <Button
                      className="gap-2"
                      disabled={aiIdentityMutation.isPending}
                      type="button"
                      variant="outline"
                      onClick={() => setIsEditingIdentity(false)}
                    >
                      <X className="h-4 w-4" />
                      {copy.common.cancel}
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="mt-5 rounded-lg border border-stone-200 bg-stone-50 p-4 text-sm leading-6 text-stone-700">
                  {aiIdentityQuery.data?.instructions ??
                    copy.identity.noInstructions}
                </div>
              )}
            </section>

            <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm">
              <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-3">
                  <MessageCircle className="h-5 w-5 text-teal-700" />
                  <h2 className="text-lg font-semibold text-stone-950">
                    {copy.messenger.title}
                  </h2>
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
                    {facebookStatus === "disconnected"
                      ? copy.messenger.connectPage
                      : copy.messenger.reconnect}
                  </Button>
                ) : (
                  <Button
                    disabled={!workspaceId || facebookDisconnectMutation.isPending}
                    size="sm"
                    type="button"
                    variant="outline"
                    onClick={disconnectFacebook}
                  >
                    {facebookDisconnectMutation.isPending
                      ? copy.messenger.disconnecting
                      : copy.messenger.disconnect}
                  </Button>
                )}
              </div>
              <div className="mt-5 space-y-3 text-sm">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-stone-600">{copy.common.status}</span>
                  <StatusPill copy={copy} value={facebookStatus} />
                </div>
                <div className="flex items-center justify-between gap-3">
                  <span className="text-stone-600">{copy.common.page}</span>
                  <span className="text-right text-stone-800">
                    {channelStatusQuery.data?.facebook.pageName ??
                      copy.common.notConnected}
                  </span>
                </div>
              </div>
              {facebookConnectState && facebookStatus !== "connected" ? (
                <div className="mt-5 rounded-lg border border-teal-200 bg-teal-50 p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <div className="text-sm font-medium text-teal-900">
                        {copy.messenger.authorizationPending}
                      </div>
                      <div className="mt-1 text-sm text-teal-700">
                        {copy.messenger.authorizationBody}
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
                      {facebookCompleteMutation.isPending
                        ? copy.messenger.checking
                        : copy.messenger.finishSetup}
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
                            {page.grantedScopes.length}{" "}
                            {copy.messenger.permissionsGranted}
                          </span>
                        </span>
                        <span className="text-sm text-teal-700">
                          {isSelecting ? copy.common.connecting : copy.common.select}
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
                  {copy.messenger.unableStart}
                </p>
              ) : facebookCompleteMutation.error ? (
                <p className="mt-4 text-sm text-red-700">
                  {copy.messenger.unableFinish}
                </p>
              ) : facebookSelectPageMutation.error ? (
                <p className="mt-4 text-sm text-red-700">
                  {copy.messenger.unablePage}
                </p>
              ) : facebookSelectPageMutation.isSuccess ? (
                <p className="mt-4 text-sm text-emerald-700">
                  {copy.messenger.connected}
                </p>
              ) : facebookDisconnectMutation.isSuccess ? (
                <p className="mt-4 text-sm text-emerald-700">
                  {copy.messenger.disconnected}
                </p>
              ) : facebookDisconnectMutation.error ? (
                <p className="mt-4 text-sm text-red-700">
                  {copy.messenger.unableDisconnect}
                </p>
              ) : null}
            </section>

            <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm lg:col-span-3">
              <div className="flex items-center gap-3">
                <Info className="h-5 w-5 text-teal-700" />
                <h2 className="text-lg font-semibold text-stone-950">
                  {copy.guidance.title}
                </h2>
              </div>
              <div className="mt-5 grid gap-4 md:grid-cols-3">
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                  <h3 className="text-sm font-medium text-stone-900">
                    {copy.guidance.promptFirstTitle}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-stone-600">
                    {copy.guidance.promptFirstBody}
                  </p>
                </div>
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                  <h3 className="text-sm font-medium text-stone-900">
                    {copy.guidance.contextTitle}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-stone-600">
                    {copy.guidance.contextBody}
                  </p>
                </div>
                <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                  <h3 className="text-sm font-medium text-stone-900">
                    {copy.guidance.dataTitle}
                  </h3>
                  <p className="mt-2 text-sm leading-6 text-stone-600">
                    {copy.guidance.dataBody}
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
                      {copy.usage.title}
                    </h2>
                    <p className="mt-1 text-sm text-stone-600">
                      {formatPlanName(usage?.plan.name, copy)} {copy.usage.plan}
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
                    {upgradeRequestMutation.isPending
                      ? copy.usage.requesting
                      : copy.usage.upgrade}
                  </Button>
                ) : null}
              </div>
              <div className="mt-5 grid gap-4 sm:grid-cols-3">
                <MetricTile
                  label={copy.usage.imagesRemaining}
                  value={imagesRemaining}
                  detail={`${usage?.imageCount ?? 0} ${copy.usage.imagesUsedDetail.replace(
                    "{limit}",
                    String(imageLimit)
                  )}`}
                />
                <MetricTile
                  label={copy.usage.messagesToday}
                  value={usage?.messageCount ?? 0}
                  detail={`${usage?.limits.messagesPerWindow ?? 0} per ${
                    usage?.limits.messageWindowSeconds ?? 0
                  } ${copy.common.seconds}`}
                />
                <MetricTile
                  label={copy.usage.blockedToday}
                  value={usage?.blockedCount ?? 0}
                  detail={
                    usage?.upgrade.reason === "blocked_usage"
                      ? copy.usage.actionNeeded
                      : copy.usage.noBlocks
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
                  {copy.usage.requestRecorded}
                </p>
              ) : upgradeRequestMutation.error ? (
                <p className="mt-4 text-sm text-red-700">
                  {copy.usage.requestError}
                </p>
              ) : null}
              <div className="mt-5 overflow-hidden rounded-lg border border-stone-200">
                {upgradeRequestsQuery.error ? (
                  <div className="bg-red-50 px-4 py-3 text-sm text-red-700">
                    {copy.usage.loadError}
                  </div>
                ) : upgradeRequests.length === 0 ? (
                  <div className="bg-stone-50 px-4 py-3 text-sm text-stone-600">
                    {copy.usage.empty}
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
                            {request.requestedPlanName} {copy.usage.upgradeLabel}
                          </div>
                          <div className="mt-1 text-xs text-stone-500">
                            {upgradeReasonLabel(request.upgradeReason, copy)}
                          </div>
                        </div>
                        <span className="text-stone-600">
                          {formatDate(request.createdAt, locale, copy)}
                        </span>
                        <StatusPill copy={copy} value={request.status} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {latestUpgradeRequest ? (
                <p className="mt-3 text-xs text-stone-500">
                  {copy.usage.latestRequest}:{" "}
                  {statusLabel(latestUpgradeRequest.status, copy)}
                  {" · "}
                  {formatDate(latestUpgradeRequest.createdAt, locale, copy)}
                </p>
              ) : null}
            </section>

            <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm lg:col-span-3">
              <div className="flex items-center gap-3">
                <SlidersHorizontal className="h-5 w-5 text-teal-700" />
                <h2 className="text-lg font-semibold text-stone-950">
                  {copy.privacy.controlsTitle}
                </h2>
              </div>
              <div className="mt-5 grid gap-4 md:grid-cols-3">
                <label className="flex min-h-24 items-start justify-between gap-4 rounded-lg border border-stone-200 bg-stone-50 p-4">
                  <span>
                    <span className="block text-sm font-medium text-stone-900">
                      {copy.privacy.knowledgeIndexing}
                    </span>
                    <span className="mt-1 block text-sm text-stone-600">
                      {copy.privacy.knowledgeIndexingBody}
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
                      {copy.privacy.usageAnalytics}
                    </span>
                    <span className="mt-1 block text-sm text-stone-600">
                      {copy.privacy.usageAnalyticsBody}
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
                      {copy.privacy.imageMemoryRetention}
                    </span>
                    <span className="mt-1 block text-sm text-stone-600">
                      {copy.privacy.daysRetained}:{" "}
                      {privacy?.imageMemoryRetentionDays ?? 0}
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
                    {copy.dataRequests.title}
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
                    {copy.dataRequests.export}
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
                    {copy.dataRequests.deleteData}
                  </Button>
                </div>
              </div>
              <div className="mt-5 grid gap-4 sm:grid-cols-3">
                <MetricTile
                  label={copy.dataRequests.openRequests}
                  value={openPrivacyRequests.length}
                  detail={copy.dataRequests.openRequestsDetail}
                />
                <MetricTile
                  label={copy.dataRequests.latestRequest}
                  value={requestTypeLabel(latestPrivacyRequest?.requestType, copy)}
                  detail={
                    latestPrivacyRequest
                      ? `${statusLabel(latestPrivacyRequest.status, copy)} · ${formatDate(
                          latestPrivacyRequest.createdAt,
                          locale,
                          copy
                        )}`
                      : copy.dataRequests.noRequests
                  }
                />
                <MetricTile
                  label={copy.dataRequests.targetDate}
                  value={
                    latestPrivacyRequest &&
                    isOpenPrivacyRequest(latestPrivacyRequest.status)
                      ? formatDate(addDays(latestPrivacyRequest.createdAt, 30), locale, copy)
                      : copy.common.none
                  }
                  detail={copy.dataRequests.targetDetail}
                />
              </div>
              <div className="mt-5 overflow-hidden rounded-lg border border-stone-200">
                {privacyRequestMutation.error ? (
                  <div className="bg-red-50 px-4 py-3 text-sm text-red-700">
                    {copy.dataRequests.createError}
                  </div>
                ) : privacyRequestsError ? (
                  <div className="bg-red-50 px-4 py-3 text-sm text-red-700">
                    {copy.dataRequests.loadError}
                  </div>
                ) : privacyRequests.length === 0 ? (
                  <div className="bg-stone-50 px-4 py-3 text-sm text-stone-600">
                    {copy.dataRequests.noRequests}
                  </div>
                ) : (
                  <div className="divide-y divide-stone-200">
                    {privacyRequests.slice(0, 4).map(request => (
                      <div
                        className="grid gap-2 bg-stone-50 px-4 py-3 text-sm sm:grid-cols-[1fr_auto_auto]"
                        key={request.id}
                      >
                        <span className="font-medium text-stone-900">
                          {requestTypeLabel(request.requestType, copy)}
                        </span>
                        <span className="text-stone-600">
                          {formatDate(request.createdAt, locale, copy)}
                        </span>
                        <StatusPill copy={copy} value={request.status} />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section className="rounded-lg border border-stone-200 bg-white p-5 shadow-sm lg:col-span-3">
              <div className="flex items-center gap-3">
                <Database className="h-5 w-5 text-teal-700" />
                <h2 className="text-lg font-semibold text-stone-950">
                  {copy.knowledge.title}
                </h2>
              </div>
              <div className="mt-5 grid gap-4 sm:grid-cols-3">
                <MetricTile
                  label={copy.knowledge.sources}
                  value={knowledgeQuery.data?.totalSources ?? 0}
                />
                <MetricTile
                  label={copy.knowledge.active}
                  value={knowledgeQuery.data?.activeSources ?? 0}
                />
                <MetricTile
                  label={copy.knowledge.lastUpdate}
                  value={
                    knowledgeQuery.data?.lastUpdate
                      ? formatDate(knowledgeQuery.data.lastUpdate, locale, copy)
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
                  {copy.common.type}
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
                    <option value="website">{copy.knowledge.website}</option>
                    <option value="manual_text">{copy.knowledge.manualText}</option>
                    <option value="integration">{copy.knowledge.integration}</option>
                  </select>
                </label>
                <label className="grid gap-2 text-sm text-stone-700">
                  {copy.common.name}
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
                  {copy.common.reference}
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
                    {copy.common.add}
                  </Button>
                </div>
              </form>
              {knowledgeMutation.error ? (
                <div className="mt-3 text-sm text-red-700">
                  {copy.knowledge.saveError}
                </div>
              ) : knowledgeDisableMutation.error ? (
                <div className="mt-3 text-sm text-red-700">
                  {copy.knowledge.disableError}
                </div>
              ) : null}
              <div className="mt-5 overflow-hidden rounded-lg border border-stone-200">
                {knowledgeQuery.error ? (
                  <div className="bg-red-50 px-4 py-3 text-sm text-red-700">
                    {copy.knowledge.loadError}
                  </div>
                ) : knowledgeSources.length === 0 ? (
                  <div className="bg-stone-50 px-4 py-3 text-sm text-stone-600">
                    {copy.knowledge.empty}
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
                            {source.sourceReference ||
                              sourceTypeLabel(source.sourceType, copy)}
                          </div>
                        </div>
                        <span className="text-stone-600">
                          {sourceTypeLabel(source.sourceType, copy)}
                        </span>
                        <StatusPill copy={copy} value={source.status} />
                        {source.status === "disabled" ? (
                          <span className="text-xs text-stone-500">
                            {copy.common.disabled}
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            type="button"
                            variant="outline"
                            disabled={knowledgeDisableMutation.isPending}
                            onClick={() => disableKnowledgeSource(source.id)}
                          >
                            {copy.knowledge.disable}
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
        <footer className="flex flex-wrap gap-4 border-t border-stone-200 py-5 text-sm text-stone-600">
          <a className="hover:text-teal-700" href="/privacy">
            {copy.footer.privacy}
          </a>
          <a className="hover:text-teal-700" href="/terms">
            {copy.footer.terms}
          </a>
          <a className="hover:text-teal-700" href="/data-deletion">
            {copy.footer.dataDeletion}
          </a>
        </footer>
      </div>
    </main>
  );
}

export default Home;
