import { useAuth } from "@/_core/hooks/useAuth";
import {
  clearActiveHandoffToken,
  clearActiveWorkspaceId,
  getWorkspaceIdFromLocation,
  readActiveHandoffToken,
  readActiveWorkspaceId,
  writeActiveWorkspaceId,
} from "@/_core/portalWorkspace";
import { Button } from "@/components/ui/button";
import { isLoginConfigured } from "@/const";
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
  MessageCircle,
  Pencil,
  Plus,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import LandingPage from "./LandingPage";
import { PortalDashboardNav } from "@/components/PortalDashboardNav";
import {
  getPortalDashboardSectionIdFromHash,
  PORTAL_DASHBOARD_SECTION_IDS,
} from "@/components/portalDashboardSections";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  portalCopies,
  resolveLocale,
  type AppLocale,
  type PortalCopy,
} from "./portalLocales";

const FACEBOOK_CONNECT_STATE_KEY = "leaderbot.facebookConnectState";
const FACEBOOK_CONNECT_QUERY_KEY = "facebookConnectState";
const LOCALE_STORAGE_KEY = "leaderbot.portal.locale";
const BILLING_RETURN_FAILURE_STATUSES = new Set<string>([
  "failed",
  "canceled",
  "expired",
  "mismatch",
]);
const BILLING_RETURN_TERMINAL_STATUSES = new Set<string>([
  "paid",
  ...BILLING_RETURN_FAILURE_STATUSES,
]);

function isBillingReturnFailureStatus(value: string | undefined) {
  return value ? BILLING_RETURN_FAILURE_STATUSES.has(value) : false;
}

function isTerminalBillingReturnStatus(value: string | undefined) {
  return value ? BILLING_RETURN_TERMINAL_STATUSES.has(value) : false;
}

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
  return (
    copy.status[value as keyof PortalCopy["status"]] ?? value.replace(/_/g, " ")
  );
}

function sourceTypeLabel(value: string, copy: PortalCopy) {
  if (value === "manual_text") return copy.knowledge.manualText;
  if (value === "integration") return copy.knowledge.integration;
  if (value === "website") return copy.knowledge.website;
  return value.replace(/_/g, " ");
}

function upgradeReasonLabel(
  value: string | null | undefined,
  copy: PortalCopy
) {
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
      className="inline-grid grid-cols-3 gap-1 rounded-xl border border-slate-200 bg-slate-100 p-1"
      role="group"
    >
      {SUPPORTED_LOCALES.map(localeOption => (
        <button
          aria-pressed={localeOption === locale}
          className={`min-h-8 rounded-md px-3 text-xs font-semibold transition-colors ${
            localeOption === locale
              ? "bg-white text-[#163b31] shadow-sm"
              : "text-slate-500 hover:bg-white/70 hover:text-slate-800"
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
    value === "connected" ||
    value === "completed" ||
    value === "active" ||
    value === "paid"
      ? "bg-emerald-100 text-emerald-800"
      : value === "rejected" ||
          value === "failed" ||
          value === "expired" ||
          value === "past_due"
        ? "bg-red-100 text-red-800"
        : value === "processing" || value === "provisioning"
          ? "bg-sky-100 text-sky-800"
          : value === "canceled" || value === "suspended"
            ? "bg-stone-200 text-stone-700"
            : "bg-amber-100 text-amber-800";
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-[0.7rem] font-semibold uppercase tracking-wide ${toneClass}`}
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
    <div className="rounded-2xl border border-slate-200/80 bg-slate-50/80 p-4">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
        {value}
      </div>
      {detail ? (
        <div className="mt-1.5 text-xs leading-5 text-slate-500">{detail}</div>
      ) : null}
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

function formatBillingAmount(
  amount: string,
  currency: string,
  locale: AppLocale
) {
  const numericAmount = Number(amount);
  if (!Number.isFinite(numericAmount)) return `${currency} ${amount}`;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
    }).format(numericAmount);
  } catch {
    return `${currency} ${amount}`;
  }
}

function formatBillingInterval(value: string, copy: PortalCopy) {
  if (value === "1 month") return copy.billing.monthly;
  if (value === "30 days") return copy.billing.for30Days;
  return value;
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
  return (
    new URLSearchParams(window.location.search).get("onboarding") === "handoff"
  );
}

function getBillingReturnIntent() {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const intentId = params.get("intent");
  return params.get("billing") === "return" &&
    intentId &&
    /^[0-9a-f-]{36}$/i.test(intentId)
    ? intentId
    : null;
}

function getFacebookConnectStateFromLocation() {
  if (typeof window === "undefined") return null;
  const state = new URLSearchParams(window.location.search).get(
    FACEBOOK_CONNECT_QUERY_KEY
  );
  return state && /^[A-Za-z0-9_-]{32}$/.test(state) ? state : null;
}

function Home() {
  const auth = useAuth();
  const utils = trpc.useUtils();
  const loginConfigured = isLoginConfigured();
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<number | null>(
    () => getWorkspaceIdFromLocation() ?? readActiveWorkspaceId()
  );
  const [showHandoffBanner] = useState(hasHandoffOnboardingFlag);
  const [billingReturnIntent] = useState(getBillingReturnIntent);
  const billingReturnHandled = useRef(false);
  const facebookAutoCompleteState = useRef<string | null>(null);
  const facebookAutoSelectState = useRef<string | null>(null);
  const billingProfileAttestationRequestId = useRef<string | null>(null);
  const [peppolEvidenceReference, setPeppolEvidenceReference] = useState("");
  const [peppolEvidenceConfirmed, setPeppolEvidenceConfirmed] = useState(false);
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
  const [accountingFrom, setAccountingFrom] = useState(() => {
    const now = new Date();
    return `${now.getUTCFullYear()}-01-01`;
  });
  const [accountingUntil, setAccountingUntil] = useState(() => {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    return tomorrow.toISOString().slice(0, 10);
  });
  const [knowledgeForm, setKnowledgeForm] = useState<{
    sourceType: "website" | "manual_text" | "integration";
    name: string;
    sourceReference: string;
  }>({
    sourceType: "website",
    name: "",
    sourceReference: "",
  });
  const [facebookConnectStateFromLogin] = useState(
    getFacebookConnectStateFromLocation
  );
  const [facebookConnectState, setFacebookConnectState] = useState<
    string | null
  >(
    () =>
      facebookConnectStateFromLogin ??
      readBrowserStorage(FACEBOOK_CONNECT_STATE_KEY)
  );
  const [facebookConnectPages, setFacebookConnectPages] = useState<
    FacebookConnectPage[]
  >([]);
  const [facebookConnectIssue, setFacebookConnectIssue] = useState<
    string | null
  >(null);
  const copy = portalCopies[locale];

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    if (!facebookConnectStateFromLogin || typeof window === "undefined") return;
    writeBrowserStorage(
      FACEBOOK_CONNECT_STATE_KEY,
      facebookConnectStateFromLogin
    );
    const url = new URL(window.location.href);
    url.searchParams.delete(FACEBOOK_CONNECT_QUERY_KEY);
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`
    );
  }, [facebookConnectStateFromLogin]);

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
  const currentWorkspaceQuery = trpc.portal.workspace.current.useQuery(
    undefined,
    {
      enabled: auth.isAuthenticated && !activeWorkspaceId,
    }
  );
  const activeWorkspaceQuery = trpc.portal.workspace.get.useQuery(
    { workspaceId: activeWorkspaceId ?? 0 },
    {
      enabled: auth.isAuthenticated && Boolean(activeWorkspaceId),
    }
  );
  const workspace = activeWorkspaceQuery.data ?? currentWorkspaceQuery.data;
  const workspaceId = workspace?.id ?? portalSessionQuery.data?.workspace.id;
  const billingRole = portalSessionQuery.data?.membership.role;
  const canManageBilling = billingRole === "owner" || billingRole === "admin";
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
      window.history.replaceState(
        null,
        "",
        `${url.pathname}${url.search}${url.hash}`
      );
    }
  }, [activeWorkspaceId, activeWorkspaceQuery.error]);

  const workspaceQuery = activeWorkspaceId
    ? activeWorkspaceQuery
    : currentWorkspaceQuery;
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
  const facebookStatus =
    channelStatusQuery.data?.facebook.status ?? "disconnected";
  const usageQuery = trpc.portal.usage.summary.useQuery(
    { workspaceId: workspaceId ?? 0 },
    { enabled: Boolean(workspaceId) }
  );
  const billingPlansQuery = trpc.portal.billing.plans.useQuery(undefined, {
    enabled: auth.isAuthenticated,
  });
  const billingSummaryQuery = trpc.portal.billing.summary.useQuery(
    { workspaceId: workspaceId ?? 0 },
    { enabled: Boolean(workspaceId) }
  );
  const billingProfileStatusQuery = trpc.billingAdmin.profileStatus.useQuery(
    { workspaceId: workspaceId ?? 0 },
    {
      enabled:
        Boolean(workspaceId) && portalSessionQuery.data?.user.role === "admin",
    }
  );
  const billingReturnStatusQuery = trpc.portal.billing.returnStatus.useQuery(
    {
      workspaceId: workspaceId ?? 0,
      intentId: billingReturnIntent ?? "",
    },
    {
      enabled:
        Boolean(workspaceId) &&
        Boolean(billingReturnIntent) &&
        canManageBilling,
      refetchInterval: query => {
        return isTerminalBillingReturnStatus(query.state.data?.status)
          ? false
          : 2_000;
      },
    }
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
  const billingCheckoutMutation = trpc.portal.billing.checkout.useMutation({
    onSuccess: checkout => {
      clearActiveHandoffToken();
      window.location.assign(checkout.checkoutUrl);
    },
  });
  const billingCancelMutation = trpc.portal.billing.cancel.useMutation({
    onSuccess: async () => {
      if (!workspaceId) return;
      await utils.portal.billing.summary.invalidate({ workspaceId });
    },
  });
  const billingProfileAttestationMutation =
    trpc.billingAdmin.attestProfile.useMutation({
      onSuccess: async () => {
        setPeppolEvidenceReference("");
        setPeppolEvidenceConfirmed(false);
        if (!workspaceId) return;
        await utils.billingAdmin.profileStatus.invalidate({ workspaceId });
      },
    });
  const peppolAttestationComplete =
    billingProfileAttestationMutation.isSuccess ||
    billingProfileStatusQuery.data?.peppolAttestationActive === true;

  useEffect(() => {
    if (billingReturnHandled.current || !workspaceId || !billingReturnIntent) {
      return;
    }
    const status = billingReturnStatusQuery.data?.status;
    if (!isTerminalBillingReturnStatus(status)) {
      return;
    }
    billingReturnHandled.current = true;
    void utils.portal.billing.summary.invalidate({ workspaceId });
    const url = new URL(window.location.href);
    url.searchParams.delete("billing");
    url.searchParams.delete("intent");
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`
    );
  }, [
    billingReturnIntent,
    billingReturnStatusQuery.data?.status,
    utils.portal.billing.summary,
    workspaceId,
  ]);
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
  const facebookCompleteMutation =
    trpc.portal.facebook.completeConnect.useMutation({
      onSuccess: data => {
        setFacebookConnectIssue(
          data.pages.length === 0 ? copy.messenger.noManagedPages : null
        );
        setFacebookConnectPages(data.pages);
      },
    });
  const facebookSelectPageMutation =
    trpc.portal.facebook.selectPage.useMutation({
      onSuccess: async () => {
        if (!workspaceId) return;
        setFacebookConnectIssue(null);
        setFacebookConnectState(null);
        setFacebookConnectPages([]);
        removeBrowserStorage(FACEBOOK_CONNECT_STATE_KEY);
        await utils.portal.channels.status.invalidate({ workspaceId });
      },
    });
  const facebookDisconnectMutation =
    trpc.portal.facebook.disconnect.useMutation({
      onSuccess: async () => {
        if (!workspaceId) return;
        setFacebookConnectIssue(null);
        setFacebookConnectState(null);
        setFacebookConnectPages([]);
        removeBrowserStorage(FACEBOOK_CONNECT_STATE_KEY);
        await utils.portal.channels.status.invalidate({ workspaceId });
      },
    });
  const completeFacebookConnect = facebookCompleteMutation.mutate;
  const selectFacebookPageFromAuthorization = facebookSelectPageMutation.mutate;
  const facebookPageSelectionPending = facebookSelectPageMutation.isPending;
  const singleAuthorizedFacebookPageId =
    facebookConnectPages.length === 1 ? facebookConnectPages[0]?.id : null;

  useEffect(() => {
    if (
      !workspaceId ||
      !facebookConnectState ||
      facebookStatus === "connected" ||
      facebookConnectPages.length > 0 ||
      facebookAutoCompleteState.current === facebookConnectState
    ) {
      return;
    }
    facebookAutoCompleteState.current = facebookConnectState;
    completeFacebookConnect({
      workspaceId,
      state: facebookConnectState,
    });
  }, [
    completeFacebookConnect,
    facebookConnectPages.length,
    facebookConnectState,
    facebookStatus,
    workspaceId,
  ]);

  useEffect(() => {
    if (
      !workspaceId ||
      !facebookConnectState ||
      !singleAuthorizedFacebookPageId ||
      facebookPageSelectionPending
    ) {
      return;
    }
    const selectionKey = `${facebookConnectState}:${singleAuthorizedFacebookPageId}`;
    if (facebookAutoSelectState.current === selectionKey) return;
    facebookAutoSelectState.current = selectionKey;
    selectFacebookPageFromAuthorization({
      workspaceId,
      state: facebookConnectState,
      pageId: singleAuthorizedFacebookPageId,
    });
  }, [
    facebookConnectState,
    facebookPageSelectionPending,
    selectFacebookPageFromAuthorization,
    singleAuthorizedFacebookPageId,
    workspaceId,
  ]);
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
  const knowledgeDisableMutation =
    trpc.portal.knowledge.disableSource.useMutation({
      onSuccess: async () => {
        if (!workspaceId) return;
        await utils.portal.knowledge.summary.invalidate({ workspaceId });
      },
    });

  const privacy = privacyQuery.data;
  const usage = usageQuery.data;
  const billingPlans = billingPlansQuery.data ?? [];
  const billingSummary = billingSummaryQuery.data;
  const billingSubscription = billingSummary?.subscription;
  const billingEntitlement = billingSummary?.entitlement;
  const billingPlan = billingSummary?.plan;
  const billingPayments = billingSummary?.payments ?? [];
  const billingNotifications = billingSummary?.notifications ?? [];
  const showBillingSection = Boolean(
    billingPlans.length > 0 ||
    billingSubscription ||
    billingEntitlement ||
    billingPlansQuery.error ||
    billingSummaryQuery.error ||
    (billingReturnIntent && canManageBilling)
  );
  const isLoading =
    auth.loading ||
    portalSessionQuery.isLoading ||
    workspaceQuery.isLoading ||
    workspaceMembersQuery.isLoading ||
    aiIdentityQuery.isLoading ||
    channelStatusQuery.isLoading ||
    usageQuery.isLoading ||
    billingPlansQuery.isLoading ||
    billingSummaryQuery.isLoading ||
    upgradeRequestsQuery.isLoading ||
    knowledgeQuery.isLoading ||
    privacyQuery.isLoading ||
    privacyRequestsQuery.isLoading;

  useEffect(() => {
    if (!auth.isAuthenticated || isLoading || typeof window === "undefined") {
      return;
    }
    const sectionId = getPortalDashboardSectionIdFromHash(
      window.location.hash,
      showBillingSection
    );
    if (!sectionId) return;

    const frame = window.requestAnimationFrame(() => {
      document.getElementById(sectionId)?.scrollIntoView({ block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [auth.isAuthenticated, isLoading, showBillingSection]);
  const upgradeRequests = upgradeRequestsQuery.data ?? [];
  const latestUpgradeRequest = upgradeRequests[0];
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
      allowKnowledgeIndexing:
        updates.allowKnowledgeIndexing ?? privacy.allowKnowledgeIndexing,
      allowUsageAnalytics:
        updates.allowUsageAnalytics ?? privacy.allowUsageAnalytics,
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
  const startBillingCheckout = (
    planCode: string,
    kind: "subscription_start" | "payment_method_change" | "startpilot_purchase"
  ) => {
    if (!workspaceId || !canManageBilling) return;
    if (
      kind === "payment_method_change" &&
      !window.confirm(copy.billing.changePaymentMethodConfirmation)
    ) {
      return;
    }
    billingCheckoutMutation.reset();
    billingCancelMutation.reset();
    billingCheckoutMutation.mutate({
      workspaceId,
      planCode,
      kind,
      businessCheckout: false,
      handoffToken: readActiveHandoffToken() ?? undefined,
    });
  };
  const cancelBillingSubscription = () => {
    if (!workspaceId || !canManageBilling) return;
    if (!window.confirm(copy.billing.cancelConfirmation)) return;
    billingCancelMutation.reset();
    billingCheckoutMutation.reset();
    billingCancelMutation.mutate({ workspaceId });
  };
  const attestPeppolBusinessProfile = () => {
    const evidenceReference = peppolEvidenceReference.trim();
    if (
      !workspaceId ||
      portalSessionQuery.data?.user.role !== "admin" ||
      !peppolEvidenceConfirmed ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,255}$/.test(evidenceReference)
    ) {
      return;
    }
    billingProfileAttestationRequestId.current ??= crypto.randomUUID();
    billingProfileAttestationMutation.mutate({
      requestId: billingProfileAttestationRequestId.current,
      workspaceId,
      expectedVersion: billingProfileStatusQuery.data?.eligibilityVersion ?? 0,
      countryCode: "BE",
      customerType: "business",
      evidenceReference,
      verificationMethod: "provider_attestation",
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000),
      peppolReady: true,
    });
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
      instructions: identityForm.instructions.trim()
        ? identityForm.instructions
        : null,
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

  if (auth.loading) {
    return (
      <main
        aria-busy="true"
        className="grid min-h-screen place-items-center bg-[#10211d] text-white"
      >
        <span className="sr-only">{copy.common.loadingWorkspace}</span>
        <div
          aria-hidden="true"
          className="h-8 w-8 animate-spin rounded-full border-2 border-white/20 border-t-lime-300"
        />
      </main>
    );
  }

  if (!auth.isAuthenticated) {
    return (
      <LandingPage
        locale={locale}
        loginConfigured={loginConfigured}
        onLocaleChange={changeLocale}
      />
    );
  }

  return (
    <main className="min-h-full bg-[#f2f5f3] px-3 py-4 text-slate-950 sm:px-5 lg:px-6 lg:py-6">
      <div className="mx-auto grid max-w-[1500px] items-start gap-x-6 gap-y-4 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <header className="flex flex-col gap-4 rounded-[1.6rem] border border-slate-200/80 bg-white px-5 py-5 shadow-[0_18px_50px_-35px_rgba(15,42,34,0.45)] md:flex-row md:items-center md:justify-between sm:px-6 lg:col-start-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-teal-700">
              {copy.common.workspace}
            </p>
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
                    disabled={
                      !workspaceName.trim() || workspaceMutation.isPending
                    }
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
                <h1 className="text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
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
            <p className="mt-2 text-sm text-slate-500">
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
            <LocaleSwitcher
              copy={copy}
              locale={locale}
              onChange={changeLocale}
            />
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

        <PortalDashboardNav
          ariaLabel={copy.navigation.ariaLabel}
          assistantLabel={copy.navigation.assistant}
          billingLabel={copy.navigation.billing}
          dashboardLabel={copy.navigation.dashboard}
          knowledgeLabel={copy.navigation.knowledge}
          messengerLabel={copy.navigation.messenger}
          overviewLabel={copy.navigation.overview}
          privacyLabel={copy.navigation.privacy}
          showBilling={showBillingSection}
          usageLabel={copy.navigation.usage}
          workspaceLabel={copy.common.workspace}
          workspaceName={workspaceDisplayName}
        />

        {showHandoffBanner ? (
          <section className="rounded-2xl border border-teal-200 bg-teal-50 p-4 text-teal-950 lg:col-start-2">
            <div className="flex items-start gap-3">
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-teal-700" />
              <div>
                <h2 className="text-sm font-semibold">
                  Workspace link secured
                </h2>
                <p className="mt-1 text-sm leading-6 text-teal-800">
                  Your Messenger setup link is secured to this workspace. Finish
                  the AI identity, knowledge, channel, and privacy settings
                  here.
                </p>
              </div>
            </div>
          </section>
        ) : null}

        {workspaceId &&
        portalSessionQuery.data?.user.role === "admin" &&
        billingProfileStatusQuery.isSuccess &&
        !peppolAttestationComplete ? (
          <section className="rounded-2xl border border-amber-300 bg-amber-50 p-4 text-amber-950 lg:col-start-2">
            <div>
              <h2 className="text-sm font-semibold">
                Zakelijk billingprofiel via Peppol attesteren
              </h2>
              <p className="mt-1 text-sm leading-6 text-amber-900">
                Alleen gebruiken nadat de Belgische onderneming publiek als
                actieve Peppol-ontvanger is geverifieerd. De attestatie geldt 30
                dagen en bewaart uitsluitend een HMAC van de bewijsreferentie.
              </p>
            </div>
            <form
              className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto]"
              onSubmit={event => {
                event.preventDefault();
                attestPeppolBusinessProfile();
              }}
            >
              <label className="grid gap-1 text-sm font-medium">
                Externe Peppol-bewijsreferentie
                <input
                  className="min-h-10 rounded-md border border-amber-300 bg-white px-3 text-slate-950 outline-none focus:border-amber-600"
                  disabled={billingProfileAttestationMutation.isSuccess}
                  maxLength={255}
                  pattern="[A-Za-z0-9][A-Za-z0-9._:/-]{7,255}"
                  placeholder="peppol:0208:ondernemingsnummer"
                  required
                  value={peppolEvidenceReference}
                  onChange={event =>
                    setPeppolEvidenceReference(event.target.value)
                  }
                />
              </label>
              <Button
                className="self-end"
                disabled={
                  !peppolEvidenceConfirmed ||
                  !peppolEvidenceReference.trim() ||
                  billingProfileAttestationMutation.isPending ||
                  billingProfileAttestationMutation.isSuccess
                }
                type="submit"
                variant="outline"
              >
                {billingProfileAttestationMutation.isPending
                  ? "Attestatie opslaan…"
                  : billingProfileAttestationMutation.isSuccess
                    ? "Attestatie opgeslagen"
                    : "Zakelijk profiel attesteren"}
              </Button>
              <label className="flex items-start gap-2 text-sm leading-6 sm:col-span-2">
                <input
                  checked={peppolEvidenceConfirmed}
                  className="mt-1"
                  disabled={billingProfileAttestationMutation.isSuccess}
                  type="checkbox"
                  onChange={event =>
                    setPeppolEvidenceConfirmed(event.target.checked)
                  }
                />
                Ik heb gecontroleerd dat deze exacte onderneming actief is op
                Peppol en als Belgische zakelijke klant mag worden verwerkt.
              </label>
              {billingProfileAttestationMutation.error ? (
                <p className="text-sm font-medium text-red-800 sm:col-span-2">
                  Attestatie geweigerd:{" "}
                  {billingProfileAttestationMutation.error.message}
                </p>
              ) : null}
            </form>
          </section>
        ) : null}

        {isLoading ? (
          <div className="py-12 text-sm text-slate-600 lg:col-start-2">
            {copy.common.loadingWorkspace}
          </div>
        ) : (
          <div className="grid gap-5 pb-6 lg:col-start-2 lg:grid-cols-3">
            <section
              className="scroll-mt-8 rounded-[1.4rem] border border-slate-200/80 bg-white p-5 shadow-[0_16px_45px_-35px_rgba(15,42,34,0.4)] sm:p-6 lg:col-span-3"
              id={PORTAL_DASHBOARD_SECTION_IDS.overview}
            >
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

            <section
              className="scroll-mt-8 rounded-[1.4rem] border border-slate-200/80 bg-white p-5 shadow-[0_16px_45px_-35px_rgba(15,42,34,0.4)] sm:p-6 lg:col-span-2"
              id={PORTAL_DASHBOARD_SECTION_IDS.assistant}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3">
                  <Bot className="mt-1 h-5 w-5 text-teal-700" />
                  <div>
                    <h2 className="text-lg font-semibold text-stone-950">
                      {aiIdentityQuery.data?.name ?? copy.identity.fallbackName}
                    </h2>
                    <p className="mt-1 text-sm text-stone-600">
                      {aiIdentityQuery.data?.tone ?? copy.identity.fallbackTone}{" "}
                      · {aiIdentityQuery.data?.language ?? "nl"} ·{" "}
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

            <section
              className="scroll-mt-8 rounded-[1.4rem] border border-slate-200/80 bg-white p-5 shadow-[0_16px_45px_-35px_rgba(15,42,34,0.4)] sm:p-6"
              id={PORTAL_DASHBOARD_SECTION_IDS.messenger}
            >
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
                    disabled={
                      !workspaceId || facebookDisconnectMutation.isPending
                    }
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
                      disabled={
                        !workspaceId || facebookCompleteMutation.isPending
                      }
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
                          {isSelecting
                            ? copy.common.connecting
                            : copy.common.select}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : null}
              {facebookConnectIssue ? (
                <p className="mt-4 text-sm text-red-700">
                  {facebookConnectIssue}
                </p>
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

            <section className="rounded-[1.4rem] border border-slate-200/80 bg-white p-5 shadow-[0_16px_45px_-35px_rgba(15,42,34,0.4)] sm:p-6 lg:col-span-3">
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

            <section
              className="scroll-mt-8 rounded-[1.4rem] border border-slate-200/80 bg-white p-5 shadow-[0_16px_45px_-35px_rgba(15,42,34,0.4)] sm:p-6 lg:col-span-3"
              id={PORTAL_DASHBOARD_SECTION_IDS.usage}
            >
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
                            {request.requestedPlanName}{" "}
                            {copy.usage.upgradeLabel}
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

            {showBillingSection ? (
              <section
                className="scroll-mt-8 rounded-[1.4rem] border border-slate-200/80 bg-white p-5 shadow-[0_16px_45px_-35px_rgba(15,42,34,0.4)] sm:p-6 lg:col-span-3"
                id={PORTAL_DASHBOARD_SECTION_IDS.billing}
              >
                <div className="flex items-start gap-3">
                  <CreditCard className="mt-0.5 h-5 w-5 text-teal-700" />
                  <div>
                    <h2 className="text-lg font-semibold text-stone-950">
                      {copy.billing.title}
                    </h2>
                    <p className="mt-1 text-sm text-stone-600">
                      {copy.billing.subtitle}
                    </p>
                  </div>
                </div>

                {billingNotifications.map(notification => (
                  <p
                    key={notification.id}
                    className="mt-5 rounded-lg bg-amber-50 px-4 py-3 text-sm text-amber-900"
                  >
                    {locale.startsWith("nl")
                      ? "We konden een betaling niet bevestigen. Controleer je facturatie of neem contact op met support."
                      : "We could not confirm a payment. Check your billing details or contact support."}
                  </p>
                ))}

                {billingPlansQuery.error ? (
                  <p className="mt-5 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
                    {copy.billing.planLoadError}
                  </p>
                ) : null}
                {billingSummaryQuery.error ? (
                  <p className="mt-5 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
                    {copy.billing.summaryLoadError}
                  </p>
                ) : null}
                {billingReturnIntent && canManageBilling ? (
                  <p
                    className={`mt-5 rounded-lg px-4 py-3 text-sm ${
                      billingReturnStatusQuery.error ||
                      isBillingReturnFailureStatus(
                        billingReturnStatusQuery.data?.status
                      )
                        ? "bg-red-50 text-red-700"
                        : billingReturnStatusQuery.data?.status === "paid"
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-sky-50 text-sky-800"
                    }`}
                  >
                    {billingReturnStatusQuery.error
                      ? copy.billing.returnError
                      : billingReturnStatusQuery.data?.status === "paid"
                        ? copy.billing.returnPaid
                        : isBillingReturnFailureStatus(
                              billingReturnStatusQuery.data?.status
                            )
                          ? copy.billing.returnFailed
                          : copy.billing.returnProcessing}
                  </p>
                ) : null}

                <div className="mt-5 grid gap-4 xl:grid-cols-2">
                  <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-teal-700">
                      {copy.billing.availablePlan}
                    </p>
                    <div className="mt-3 grid gap-4">
                      {billingPlans.map(plan => {
                        const isOneTime = plan.offerType === "one_time";
                        const entitlementGrantsAccess =
                          billingEntitlement?.planCode === plan.code &&
                          (billingEntitlement.status === "active" ||
                            billingEntitlement.status === "grace") &&
                          (!billingEntitlement.validUntil ||
                            new Date(billingEntitlement.validUntil).getTime() >
                              Date.now());
                        const matchingAccess =
                          billingSubscription?.planCode === plan.code
                            ? billingSubscription
                            : entitlementGrantsAccess
                              ? billingEntitlement
                              : null;

                        return (
                          <div
                            className="rounded-lg border border-stone-200 bg-white p-4"
                            key={plan.code}
                          >
                            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                              <div>
                                <h3 className="font-semibold text-stone-950">
                                  {plan.publicName}
                                </h3>
                                <p className="mt-1 text-2xl font-semibold text-stone-950">
                                  {formatBillingAmount(
                                    plan.amount,
                                    plan.currency,
                                    locale
                                  )}{" "}
                                  <span className="text-sm font-normal text-stone-600">
                                    {formatBillingInterval(plan.interval, copy)}
                                  </span>
                                </p>
                              </div>
                              {matchingAccess ? (
                                <StatusPill
                                  copy={copy}
                                  value={matchingAccess.status}
                                />
                              ) : (
                                <Button
                                  disabled={
                                    !workspaceId ||
                                    !canManageBilling ||
                                    billingCheckoutMutation.isPending
                                  }
                                  type="button"
                                  onClick={() =>
                                    startBillingCheckout(
                                      plan.code,
                                      isOneTime
                                        ? "startpilot_purchase"
                                        : "subscription_start"
                                    )
                                  }
                                >
                                  {billingCheckoutMutation.isPending
                                    ? copy.billing.openingCheckout
                                    : isOneTime
                                      ? copy.billing.buyStartpilot
                                      : copy.billing.startSubscription}
                                </Button>
                              )}
                            </div>
                            {isOneTime ? (
                              <>
                                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                                  <div>
                                    <dt className="text-stone-500">
                                      {copy.billing.oneTimePayment}
                                    </dt>
                                    <dd className="mt-1 font-medium text-stone-900">
                                      {formatBillingAmount(
                                        plan.disclosure.paymentAmount,
                                        plan.currency,
                                        locale
                                      )}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt className="text-stone-500">
                                      {copy.billing.accessPeriod}
                                    </dt>
                                    <dd className="mt-1 font-medium text-stone-900">
                                      {formatBillingInterval(
                                        plan.interval,
                                        copy
                                      )}
                                    </dd>
                                  </div>
                                </dl>
                                <div className="mt-4 grid gap-3 text-sm text-stone-600">
                                  <p className="font-medium text-stone-900">
                                    {copy.billing.pilotIncludes}
                                  </p>
                                  {[
                                    copy.billing.pilotWorkspacePage,
                                    copy.billing.pilotAnswers,
                                    copy.billing.pilotImages,
                                  ].map(item => (
                                    <div
                                      className="flex items-start gap-2"
                                      key={item}
                                    >
                                      <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-teal-700" />
                                      <span>{item}</span>
                                    </div>
                                  ))}
                                  <div className="flex items-start gap-2">
                                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-teal-700" />
                                    <span>
                                      <span className="font-medium text-stone-900">
                                        {copy.billing.noAutomaticRenewal}.{" "}
                                      </span>
                                      {copy.billing.noAutomaticRenewalBody}
                                    </span>
                                  </div>
                                  <div className="flex items-start gap-2">
                                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-teal-700" />
                                    <span>
                                      <span className="font-medium text-stone-900">
                                        {copy.billing.noOverages}.{" "}
                                      </span>
                                      {copy.billing.noOveragesBody}
                                    </span>
                                  </div>
                                </div>
                              </>
                            ) : (
                              <>
                                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                                  <div>
                                    <dt className="text-stone-500">
                                      {copy.billing.firstPayment}
                                    </dt>
                                    <dd className="mt-1 font-medium text-stone-900">
                                      {formatBillingAmount(
                                        plan.disclosure.firstPaymentAmount,
                                        plan.currency,
                                        locale
                                      )}
                                    </dd>
                                  </div>
                                  <div>
                                    <dt className="text-stone-500">
                                      {copy.billing.recurringPayment}
                                    </dt>
                                    <dd className="mt-1 font-medium text-stone-900">
                                      {plan.disclosure.recurringAmount
                                        ? formatBillingAmount(
                                            plan.disclosure.recurringAmount,
                                            plan.currency,
                                            locale
                                          )
                                        : copy.common.none}{" "}
                                      {formatBillingInterval(
                                        plan.interval,
                                        copy
                                      )}
                                    </dd>
                                  </div>
                                </dl>
                                <div className="mt-4 grid gap-3 text-sm text-stone-600">
                                  <div className="flex items-start gap-2">
                                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-teal-700" />
                                    <span>
                                      <span className="font-medium text-stone-900">
                                        {copy.billing.automaticRenewal}.{" "}
                                      </span>
                                      {copy.billing.automaticRenewalBody}
                                    </span>
                                  </div>
                                  <div className="flex items-start gap-2">
                                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-teal-700" />
                                    <span>
                                      <span className="font-medium text-stone-900">
                                        {copy.billing.sepaDebit}.{" "}
                                      </span>
                                      {copy.billing.sepaDebitBody}
                                    </span>
                                  </div>
                                  <p>{copy.billing.cancellationTiming}</p>
                                </div>
                              </>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  <div className="rounded-lg border border-stone-200 bg-stone-50 p-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-teal-700">
                      {copy.billing.currentPlan}
                    </p>
                    {billingSubscription || billingEntitlement ? (
                      <div className="mt-3">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div>
                            <h3 className="font-semibold text-stone-950">
                              {billingPlan?.publicName ??
                                billingSubscription?.planCode ??
                                billingEntitlement?.planCode}
                            </h3>
                            {billingPlan ? (
                              <p className="mt-1 text-sm text-stone-600">
                                {formatBillingAmount(
                                  billingPlan.amount,
                                  billingPlan.currency,
                                  locale
                                )}{" "}
                                {formatBillingInterval(
                                  billingPlan.interval,
                                  copy
                                )}
                              </p>
                            ) : null}
                          </div>
                          <StatusPill
                            copy={copy}
                            value={
                              billingSubscription?.status ??
                              billingEntitlement?.status ??
                              "active"
                            }
                          />
                        </div>
                        {billingSubscription ? (
                          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
                            <div className="rounded-lg border border-stone-200 bg-white p-3">
                              <dt className="text-xs text-stone-500">
                                {copy.billing.paidThrough}
                              </dt>
                              <dd className="mt-1 text-sm font-medium text-stone-900">
                                {formatDate(
                                  billingSubscription.paidThrough,
                                  locale,
                                  copy
                                )}
                              </dd>
                            </div>
                            <div className="rounded-lg border border-stone-200 bg-white p-3">
                              <dt className="text-xs text-stone-500">
                                {copy.billing.nextBillingDate}
                              </dt>
                              <dd className="mt-1 text-sm font-medium text-stone-900">
                                {formatDate(
                                  billingSubscription.nextBillingDate,
                                  locale,
                                  copy
                                )}
                              </dd>
                            </div>
                          </dl>
                        ) : billingEntitlement ? (
                          <dl className="mt-4 grid gap-3">
                            <div className="rounded-lg border border-stone-200 bg-white p-3">
                              <dt className="text-xs text-stone-500">
                                {copy.billing.accessEnds}
                              </dt>
                              <dd className="mt-1 text-sm font-medium text-stone-900">
                                {formatDate(
                                  billingEntitlement.validUntil,
                                  locale,
                                  copy
                                )}
                              </dd>
                            </div>
                          </dl>
                        ) : null}
                        {billingSubscription?.cancelAtPeriodEnd ? (
                          <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                            <div className="font-medium">
                              {copy.billing.cancellationScheduled}
                            </div>
                            <p className="mt-1">
                              {copy.billing.cancellationScheduledBody.replace(
                                "{date}",
                                formatDate(
                                  billingSubscription.paidThrough,
                                  locale,
                                  copy
                                )
                              )}
                            </p>
                          </div>
                        ) : null}
                        {billingSubscription ? (
                          <div className="mt-4 flex flex-wrap gap-3">
                            {billingPlan?.offerType === "subscription" ? (
                              <Button
                                disabled={
                                  !canManageBilling ||
                                  billingCheckoutMutation.isPending
                                }
                                type="button"
                                variant="outline"
                                onClick={() =>
                                  startBillingCheckout(
                                    billingPlan.code,
                                    "payment_method_change"
                                  )
                                }
                              >
                                {billingCheckoutMutation.isPending
                                  ? copy.billing.openingCheckout
                                  : copy.billing.changePaymentMethod}
                              </Button>
                            ) : null}
                            {!billingSubscription.cancelAtPeriodEnd ? (
                              <Button
                                disabled={
                                  !canManageBilling ||
                                  billingCancelMutation.isPending
                                }
                                type="button"
                                variant="outline"
                                onClick={cancelBillingSubscription}
                              >
                                {billingCancelMutation.isPending
                                  ? copy.billing.canceling
                                  : copy.billing.cancelSubscription}
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ) : (
                      <p className="mt-3 text-sm text-stone-600">
                        {copy.billing.noSubscription}
                      </p>
                    )}
                    {!canManageBilling ? (
                      <p className="mt-4 text-xs text-stone-500">
                        {copy.billing.managerOnly}
                      </p>
                    ) : null}
                  </div>
                </div>

                {billingCheckoutMutation.error ? (
                  <p className="mt-4 text-sm text-red-700">
                    {copy.billing.checkoutError}
                  </p>
                ) : billingCancelMutation.error ? (
                  <p className="mt-4 text-sm text-red-700">
                    {copy.billing.cancelError}
                  </p>
                ) : billingCancelMutation.isSuccess ? (
                  <p className="mt-4 text-sm text-emerald-700">
                    {copy.billing.cancelSuccess}
                  </p>
                ) : null}

                <div className="mt-5 rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">
                  <div className="flex items-start gap-3">
                    <Info className="mt-0.5 h-4 w-4 shrink-0 text-sky-700" />
                    <div className="grid gap-1">
                      <p className="font-medium">{copy.billing.belgiumOnly}</p>
                      <p>{copy.billing.belgiumOnlyBody}</p>
                      <p>{copy.billing.b2bUnavailable}</p>
                      <p>{copy.billing.vatExemption}</p>
                    </div>
                  </div>
                </div>

                {canManageBilling ? (
                  <>
                    <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                      <div>
                        <h3 className="font-semibold text-stone-950">
                          {copy.billing.paymentHistory}
                        </h3>
                        <p className="mt-1 text-sm text-stone-600">
                          {copy.billing.accountingExportBody}
                        </p>
                      </div>
                      {workspaceId && billingSummary?.mode ? (
                        <div className="flex flex-wrap items-end gap-2">
                          <label className="grid gap-1 text-xs text-stone-600">
                            {locale === "nl-BE"
                              ? "Van (inclusief)"
                              : locale === "fr-BE"
                                ? "Du (inclus)"
                                : "From (inclusive)"}
                            <input
                              className="rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm"
                              type="date"
                              value={accountingFrom}
                              onChange={event =>
                                setAccountingFrom(event.target.value)
                              }
                            />
                          </label>
                          <label className="grid gap-1 text-xs text-stone-600">
                            {locale === "nl-BE"
                              ? "Tot (exclusief)"
                              : locale === "fr-BE"
                                ? "Au (exclus)"
                                : "Until (exclusive)"}
                            <input
                              className="rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm"
                              type="date"
                              value={accountingUntil}
                              onChange={event =>
                                setAccountingUntil(event.target.value)
                              }
                            />
                          </label>
                          <Button asChild size="sm" variant="outline">
                            <a
                              href={`/api/portal/billing/export.csv?workspaceId=${encodeURIComponent(String(workspaceId))}&from=${encodeURIComponent(accountingFrom)}&until=${encodeURIComponent(accountingUntil)}`}
                            >
                              <FileDown className="h-4 w-4" />
                              {copy.billing.accountingExport}
                            </a>
                          </Button>
                        </div>
                      ) : null}
                    </div>
                    <div className="mt-4 overflow-x-auto rounded-lg border border-stone-200">
                      {billingPayments.length === 0 ? (
                        <div className="bg-stone-50 px-4 py-3 text-sm text-stone-600">
                          {copy.billing.noPayments}
                        </div>
                      ) : (
                        <table className="min-w-full divide-y divide-stone-200 text-left text-sm">
                          <thead className="bg-stone-50 text-xs uppercase tracking-wide text-stone-500">
                            <tr>
                              <th className="px-4 py-3 font-medium">
                                {copy.billing.paymentDate}
                              </th>
                              <th className="px-4 py-3 font-medium">
                                {copy.billing.invoiceNumber}
                              </th>
                              <th className="px-4 py-3 font-medium">
                                {copy.common.status}
                              </th>
                              <th className="px-4 py-3 font-medium">
                                {copy.billing.amount}
                              </th>
                              <th className="px-4 py-3 font-medium">
                                <span className="sr-only">
                                  {copy.billing.receipt}
                                </span>
                              </th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-stone-200 bg-white">
                            {billingPayments.map(payment => (
                              <tr key={payment.molliePaymentId}>
                                <td className="whitespace-nowrap px-4 py-3 text-stone-600">
                                  {formatDate(payment.occurredAt, locale, copy)}
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 font-medium text-stone-900">
                                  {payment.invoiceNumber}
                                </td>
                                <td className="whitespace-nowrap px-4 py-3">
                                  <StatusPill
                                    copy={copy}
                                    value={payment.status}
                                  />
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 text-stone-900">
                                  {formatBillingAmount(
                                    payment.grossAmount,
                                    payment.currency,
                                    locale
                                  )}
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 text-right">
                                  {workspaceId ? (
                                    <a
                                      className="inline-flex items-center gap-1 font-medium text-teal-700 hover:text-teal-800 hover:underline"
                                      href={payment.receiptPath}
                                      rel="noreferrer"
                                      target="_blank"
                                    >
                                      {copy.billing.receipt}
                                      <ExternalLink className="h-3.5 w-3.5" />
                                    </a>
                                  ) : null}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  </>
                ) : null}
              </section>
            ) : null}

            <section
              className="scroll-mt-8 rounded-[1.4rem] border border-slate-200/80 bg-white p-5 shadow-[0_16px_45px_-35px_rgba(15,42,34,0.4)] sm:p-6 lg:col-span-3"
              id={PORTAL_DASHBOARD_SECTION_IDS.privacy}
            >
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
                      updatePrivacy({
                        allowKnowledgeIndexing: event.target.checked,
                      })
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
                      updatePrivacy({
                        allowUsageAnalytics: event.target.checked,
                      })
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

            <section className="rounded-[1.4rem] border border-slate-200/80 bg-white p-5 shadow-[0_16px_45px_-35px_rgba(15,42,34,0.4)] sm:p-6 lg:col-span-3">
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
                  value={requestTypeLabel(
                    latestPrivacyRequest?.requestType,
                    copy
                  )}
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
                      ? formatDate(
                          addDays(latestPrivacyRequest.createdAt, 30),
                          locale,
                          copy
                        )
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

            <section
              className="scroll-mt-8 rounded-[1.4rem] border border-slate-200/80 bg-white p-5 shadow-[0_16px_45px_-35px_rgba(15,42,34,0.4)] sm:p-6 lg:col-span-3"
              id={PORTAL_DASHBOARD_SECTION_IDS.knowledge}
            >
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
                        sourceType: event.target
                          .value as typeof knowledgeForm.sourceType,
                      }))
                    }
                  >
                    <option value="website">{copy.knowledge.website}</option>
                    <option value="manual_text">
                      {copy.knowledge.manualText}
                    </option>
                    <option value="integration">
                      {copy.knowledge.integration}
                    </option>
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
        <footer className="flex flex-wrap gap-4 px-2 py-3 text-sm text-slate-500 lg:col-start-2">
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
