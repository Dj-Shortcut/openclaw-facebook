import {
  BookOpen,
  Bot,
  ChevronRight,
  Gauge,
  KeyRound,
  Link2,
  Lock,
  MessageCircle,
  RefreshCw,
  Settings,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  localeCopies,
  resolveLocale,
  type AppLocale,
  type LocaleCopy,
} from "./locales";
import { mockSnapshot } from "./mockData";
import {
  getPortalSnapshot,
  startFacebookConnect,
  updateAiIdentity,
  type ChannelStatus,
  type PortalSnapshot,
} from "./portalApi";

type View = "dashboard" | "identity" | "channels" | "knowledge" | "usage" | "privacy";
type StatusTone = "good" | "warning" | "danger" | "neutral";

const LOCALE_STORAGE_KEY = "leaderbot.portal.locale";

const navItems: Array<{ view: View; icon: typeof Gauge }> = [
  { view: "dashboard", icon: Gauge },
  { view: "identity", icon: Bot },
  { view: "channels", icon: MessageCircle },
  { view: "knowledge", icon: BookOpen },
  { view: "usage", icon: RefreshCw },
  { view: "privacy", icon: ShieldCheck },
];

function readStoredLocale(): string | null {
  if (typeof window === "undefined") return DEFAULT_LOCALE;
  try {
    return window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeStoredLocale(locale: AppLocale) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    return;
  }
}

function getInitialLocale(): AppLocale {
  return resolveLocale(readStoredLocale());
}

function statusLabel(status: ChannelStatus, copy: LocaleCopy) {
  return copy.status[status];
}

function channelTone(status: ChannelStatus): StatusTone {
  if (status === "connected") return "good";
  if (status === "disconnected" || status === "token_expired") return "danger";
  return "warning";
}

function sourceTypeLabel(
  type: PortalSnapshot["knowledgeStore"]["sources"][number]["sourceType"],
  copy: LocaleCopy
) {
  return copy.sourceTypes[type];
}

function sourceStatusLabel(
  status: PortalSnapshot["knowledgeStore"]["sources"][number]["status"],
  copy: LocaleCopy
) {
  return copy.sourceStatus[status];
}

function sourceStatusTone(
  status: PortalSnapshot["knowledgeStore"]["sources"][number]["status"]
): StatusTone {
  if (status === "active") return "good";
  if (status === "error" || status === "disabled") return "danger";
  return "warning";
}

function formatDate(
  value: string | null | undefined,
  locale: AppLocale,
  copy: LocaleCopy
) {
  if (!value) return copy.date.notAvailable;

  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() === 0) {
    return copy.date.notUpdated;
  }

  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatPlanName(planName: string | null | undefined, copy: LocaleCopy) {
  if (!planName || planName.toLowerCase() === "free") return copy.plan.free;
  return planName;
}

function formatUpgradeReason(reason: string | null | undefined, copy: LocaleCopy) {
  switch (reason) {
    case "image_limit_reached":
      return copy.upgradeReasons.image_limit_reached;
    case "blocked_usage":
      return copy.upgradeReasons.blocked_usage;
    case null:
    case undefined:
      return copy.upgradeReasons.none;
    default:
      return reason.replace(/_/g, " ");
  }
}

function formatConnectedChannels(count: number, copy: LocaleCopy) {
  const label =
    count === 1
      ? copy.dashboard.connectedChannel
      : copy.dashboard.connectedChannels;
  return `${count} ${label}`;
}

function formatActiveSources(count: number, copy: LocaleCopy) {
  const label =
    count === 1
      ? copy.dashboard.setup.activeSingular
      : copy.dashboard.setup.activePlural;
  return `${count} ${label}`;
}

function localeButtonLabel(locale: AppLocale, copy: LocaleCopy) {
  switch (locale) {
    case "nl-BE":
      return copy.locale.nl;
    case "fr-BE":
      return copy.locale.fr;
    case "en":
      return copy.locale.en;
  }
}

function getNextAction(
  snapshot: PortalSnapshot,
  facebookStatus: ChannelStatus,
  copy: LocaleCopy
) {
  if (snapshot.usage.upgrade?.recommended) {
    return {
      title: copy.dashboard.actions.upgradeTitle,
      body: `${formatUpgradeReason(snapshot.usage.upgrade.reason, copy)} - ${formatPlanName(snapshot.usage.plan?.name, copy)}.`,
    };
  }

  if (facebookStatus !== "connected") {
    return {
      title: copy.dashboard.actions.connectTitle,
      body: copy.dashboard.actions.connectBody,
    };
  }

  if (snapshot.knowledgeStore.activeSources === 0) {
    return {
      title: copy.dashboard.actions.knowledgeTitle,
      body: copy.dashboard.actions.knowledgeBody,
    };
  }

  return {
    title: copy.dashboard.actions.identityTitle,
    body: copy.dashboard.actions.identityBody,
  };
}

function App() {
  const [snapshot, setSnapshot] = useState<PortalSnapshot>(mockSnapshot);
  const [view, setView] = useState<View>("dashboard");
  const [locale, setLocale] = useState<AppLocale>(getInitialLocale);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const copy = localeCopies[locale];
  const localeRef = useRef(locale);

  useEffect(() => {
    localeRef.current = locale;
    document.documentElement.lang = locale;
  }, [locale]);

  useEffect(() => {
    let alive = true;

    getPortalSnapshot()
      .then(data => {
        if (alive) setSnapshot(data);
      })
      .catch(error => {
        if (alive) {
          void error;
          setNotice(localeCopies[localeRef.current].notices.previewData);
        }
      })
      .finally(() => {
        if (alive) setLoading(false);
      });

    return () => {
      alive = false;
    };
  }, []);

  const facebook = useMemo(
    () => snapshot.channels.find(channel => channel.channel === "facebook_messenger"),
    [snapshot.channels]
  );

  function changeLocale(nextLocale: AppLocale) {
    setLocale(nextLocale);
    writeStoredLocale(nextLocale);
    if (notice === localeCopies[locale].notices.previewData) {
      setNotice(localeCopies[nextLocale].notices.previewData);
    }
  }

  async function saveIdentity(formData: FormData) {
    setSaving(true);
    setNotice(null);
    try {
      const updated = await updateAiIdentity({
        workspaceId: snapshot.workspace.id,
        name: String(formData.get("name") ?? ""),
        instructions: String(formData.get("instructions") ?? ""),
        tone: String(formData.get("tone") ?? ""),
        language: String(formData.get("language") ?? ""),
        modelDefault: String(formData.get("modelDefault") ?? ""),
      });
      setSnapshot(current => ({ ...current, aiIdentity: updated }));
      setNotice(copy.notices.identitySaved);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : copy.notices.identitySaveError);
    } finally {
      setSaving(false);
    }
  }

  async function connectFacebook() {
    const authWindow = window.open("about:blank", "_blank", "noopener,noreferrer");
    setSaving(true);
    setNotice(null);
    try {
      const response = await startFacebookConnect(snapshot.workspace.id);
      if (!response.authorizationUrl) {
        authWindow?.close();
        setNotice(copy.notices.facebookAppMissing);
        return;
      }
      if (authWindow) {
        authWindow.location.href = response.authorizationUrl;
      } else {
        window.location.href = response.authorizationUrl;
      }
      setNotice(copy.notices.facebookAuthorizationOpened);
    } catch (error) {
      authWindow?.close();
      setNotice(error instanceof Error ? error.message : copy.notices.facebookConnectError);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">L</div>
          <div>
            <strong>Leaderbot</strong>
            <span>{copy.brand.subtitle}</span>
          </div>
        </div>

        <div className="locale-switcher" aria-label={copy.locale.label} role="group">
          {SUPPORTED_LOCALES.map(localeOption => (
            <button
              aria-pressed={localeOption === locale}
              className={localeOption === locale ? "active" : ""}
              key={localeOption}
              onClick={() => changeLocale(localeOption)}
              type="button"
            >
              {localeButtonLabel(localeOption, copy)}
            </button>
          ))}
        </div>

        <nav className="nav-list" aria-label={copy.navAria}>
          {navItems.map(item => {
            const Icon = item.icon;
            return (
              <button
                key={item.view}
                className={view === item.view ? "nav-item active" : "nav-item"}
                onClick={() => setView(item.view)}
                type="button"
              >
                <Icon size={18} />
                <span>{copy.nav[item.view]}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <Lock size={16} />
          <span>{copy.sidebar.dataScoped}</span>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{copy.common.workspace}</p>
            <h1>{snapshot.workspace.name}</h1>
          </div>
          <div className="account">
            <Settings size={16} />
            <span>{snapshot.user.email ?? snapshot.user.name ?? copy.account.signedIn}</span>
          </div>
        </header>

        {notice ? <div className="notice">{notice}</div> : null}
        {loading ? <div className="notice muted">{copy.notices.loading}</div> : null}

        {view === "dashboard" ? (
          <Dashboard
            copy={copy}
            facebookStatus={facebook?.status ?? "disconnected"}
            locale={locale}
            snapshot={snapshot}
          />
        ) : null}
        {view === "identity" ? (
          <IdentityForm
            copy={copy}
            saving={saving}
            snapshot={snapshot}
            onSave={saveIdentity}
          />
        ) : null}
        {view === "channels" ? (
          <Channels
            copy={copy}
            facebook={facebook}
            locale={locale}
            saving={saving}
            onConnectFacebook={connectFacebook}
          />
        ) : null}
        {view === "knowledge" ? (
          <Knowledge copy={copy} locale={locale} snapshot={snapshot} />
        ) : null}
        {view === "usage" ? (
          <Usage copy={copy} locale={locale} snapshot={snapshot} />
        ) : null}
        {view === "privacy" ? <Privacy copy={copy} snapshot={snapshot} /> : null}

        <footer className="portal-footer">
          <a href={snapshot.privacy.privacy}>{copy.privacy.links.privacy}</a>
          <a href={snapshot.privacy.terms}>{copy.privacy.links.terms}</a>
          <a href={snapshot.privacy.dataDeletion}>{copy.privacy.links.dataDeletion}</a>
        </footer>
      </section>
    </main>
  );
}

function Dashboard({
  copy,
  snapshot,
  facebookStatus,
}: {
  copy: LocaleCopy;
  locale: AppLocale;
  snapshot: PortalSnapshot;
  facebookStatus: ChannelStatus;
}) {
  const nextAction = getNextAction(snapshot, facebookStatus, copy);
  const connectedChannels = snapshot.channels.filter(
    channel => channel.status === "connected"
  ).length;
  const setupRows = [
    {
      label: copy.dashboard.setup.facebookLabel,
      detail:
        facebookStatus === "connected"
          ? copy.dashboard.setup.facebookAuthorized
          : copy.dashboard.setup.facebookNeeded,
      status: statusLabel(facebookStatus, copy),
      tone: channelTone(facebookStatus),
    },
    {
      label: copy.dashboard.setup.identityLabel,
      detail: `${snapshot.aiIdentity.tone} ${copy.dashboard.setup.identityDetail}, ${snapshot.aiIdentity.language.toUpperCase()} ${copy.dashboard.setup.languageDetail}`,
      status: snapshot.aiIdentity.name,
      tone: "good" as const,
    },
    {
      label: copy.dashboard.setup.knowledgeLabel,
      detail: `${snapshot.knowledgeStore.totalSources} ${copy.dashboard.setup.totalSources}`,
      status: formatActiveSources(snapshot.knowledgeStore.activeSources, copy),
      tone: snapshot.knowledgeStore.activeSources > 0 ? "good" : "warning",
    },
    {
      label: copy.dashboard.setup.privacyLabel,
      detail: `${snapshot.privacy.controls.imageMemoryRetentionDays} ${copy.dashboard.setup.retention}`,
      status: snapshot.privacy.controls.allowUsageAnalytics
        ? copy.dashboard.setup.analyticsOn
        : copy.dashboard.setup.analyticsOff,
      tone: "neutral" as const,
    },
  ];

  return (
    <div className="content-grid">
      <section className="primary-panel">
        <div className="panel-heading">
          <p className="eyebrow">{copy.common.today}</p>
          <h2>{copy.dashboard.title}</h2>
          <p className="body-copy">{copy.dashboard.body}</p>
        </div>
        <div className="metric-row four">
          <Metric
            label={copy.dashboard.metrics.imagesLeft}
            value={snapshot.usage.remaining?.imagesToday ?? "n/a"}
          />
          <Metric label={copy.dashboard.metrics.messages} value={snapshot.usage.messageCount} />
          <Metric
            label={copy.dashboard.metrics.activeSources}
            value={snapshot.knowledgeStore.activeSources}
          />
          <Metric label={copy.dashboard.metrics.blocked} value={snapshot.usage.blockedCount} />
        </div>
      </section>

      <section className="side-panel">
        <p className="eyebrow">{copy.dashboard.nextAction}</p>
        <h2>{nextAction.title}</h2>
        <p>{nextAction.body}</p>
        <div className="small-summary">
          <span>{formatPlanName(snapshot.usage.plan?.name, copy)}</span>
          <strong>{formatConnectedChannels(connectedChannels, copy)}</strong>
        </div>
      </section>

      <section className="wide-panel">
        {setupRows.map(row => (
          <div className="status-row" key={row.label}>
            <div>
              <strong>{row.label}</strong>
              <span>{row.detail}</span>
            </div>
            <span className={`status-pill ${row.tone}`}>{row.status}</span>
          </div>
        ))}
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function IdentityForm({
  copy,
  snapshot,
  saving,
  onSave,
}: {
  copy: LocaleCopy;
  snapshot: PortalSnapshot;
  saving: boolean;
  onSave: (formData: FormData) => void;
}) {
  return (
    <form
      className="form-panel"
      onSubmit={event => {
        event.preventDefault();
        onSave(new FormData(event.currentTarget));
      }}
    >
      <div className="panel-heading">
        <p className="eyebrow">{copy.identity.eyebrow}</p>
        <h2>{copy.identity.title}</h2>
        <p className="body-copy">{copy.identity.body}</p>
      </div>
      <label>
        {copy.identity.assistantName}
        <input name="name" defaultValue={snapshot.aiIdentity.name} />
      </label>
      <label>
        {copy.identity.instructions}
        <textarea
          name="instructions"
          rows={8}
          defaultValue={snapshot.aiIdentity.instructions ?? ""}
        />
      </label>
      <div className="form-row">
        <label>
          {copy.identity.tone}
          <input name="tone" defaultValue={snapshot.aiIdentity.tone} />
        </label>
        <label>
          {copy.identity.language}
          <input name="language" defaultValue={snapshot.aiIdentity.language} />
        </label>
        <label>
          {copy.identity.modelDefault}
          <input name="modelDefault" defaultValue={snapshot.aiIdentity.modelDefault} />
        </label>
      </div>
      <button className="primary-action" disabled={saving} type="submit">
        <KeyRound size={16} />
        <span>{saving ? copy.common.saving : copy.identity.save}</span>
      </button>
    </form>
  );
}

function Channels({
  copy,
  facebook,
  locale,
  saving,
  onConnectFacebook,
}: {
  copy: LocaleCopy;
  facebook: PortalSnapshot["channels"][number] | undefined;
  locale: AppLocale;
  saving: boolean;
  onConnectFacebook: () => void;
}) {
  const status = facebook?.status ?? "disconnected";
  return (
    <section className="form-panel">
      <div className="panel-heading">
        <p className="eyebrow">{copy.channels.eyebrow}</p>
        <h2>{copy.channels.title}</h2>
        <p className="body-copy">{copy.channels.body}</p>
      </div>

      <div className="channel-line">
        <div>
          <strong>{facebook?.displayName ?? copy.common.noPageConnected}</strong>
          <span>
            {facebook?.externalId
              ? `${copy.common.page} ${facebook.externalId}`
              : copy.common.customerPageRequired}
          </span>
        </div>
        <span className={`status-pill ${channelTone(status)}`}>
          {statusLabel(status, copy)}
        </span>
      </div>

      <div className="detail-grid">
        <div>
          <span>{copy.channels.lastCheck}</span>
          <strong>{formatDate(facebook?.lastCheckedAt, locale, copy)}</strong>
        </div>
        <div>
          <span>{copy.common.transport}</span>
          <strong>{copy.common.messenger}</strong>
        </div>
      </div>

      <button className="primary-action" disabled={saving} type="button" onClick={onConnectFacebook}>
        <Link2 size={16} />
        <span>{saving ? copy.common.opening : copy.channels.connect}</span>
        <ChevronRight size={16} />
      </button>
    </section>
  );
}

function Knowledge({
  copy,
  locale,
  snapshot,
}: {
  copy: LocaleCopy;
  locale: AppLocale;
  snapshot: PortalSnapshot;
}) {
  const sources = snapshot.knowledgeStore.sources;

  return (
    <div className="content-grid">
      <section className="primary-panel">
        <div className="panel-heading">
          <p className="eyebrow">{copy.knowledge.eyebrow}</p>
          <h2>{copy.knowledge.title}</h2>
          <p className="body-copy">{copy.knowledge.body}</p>
        </div>
        <div className="metric-row three">
          <Metric label={copy.knowledge.metrics.totalSources} value={snapshot.knowledgeStore.totalSources} />
          <Metric label={copy.knowledge.metrics.active} value={snapshot.knowledgeStore.activeSources} />
          <Metric
            label={copy.knowledge.metrics.lastUpdate}
            value={formatDate(snapshot.knowledgeStore.lastUpdate, locale, copy)}
          />
        </div>
      </section>

      <section className="side-panel">
        <p className="eyebrow">{copy.knowledge.indexing}</p>
        <h2>
          {snapshot.privacy.controls.allowKnowledgeIndexing
            ? copy.knowledge.indexingEnabled
            : copy.knowledge.indexingPaused}
        </h2>
        <p>
          {snapshot.privacy.controls.allowKnowledgeIndexing
            ? copy.knowledge.indexingEnabledBody
            : copy.knowledge.indexingPausedBody}
        </p>
      </section>

      <section className="wide-panel">
        {sources.length > 0 ? (
          <div className="source-list">
            {sources.map(source => (
              <div className="source-row" key={source.id}>
                <div>
                  <strong>{source.name}</strong>
                  <span>
                    {sourceTypeLabel(source.sourceType, copy)}
                    {source.sourceReference ? ` - ${source.sourceReference}` : ""}
                  </span>
                </div>
                <div className="source-meta">
                  <span>{source.itemCount} {copy.common.items}</span>
                  <span className={`status-pill ${sourceStatusTone(source.status)}`}>
                    {sourceStatusLabel(source.status, copy)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <strong>{copy.knowledge.emptyTitle}</strong>
            <span>{copy.knowledge.emptyBody}</span>
          </div>
        )}
      </section>
    </div>
  );
}

function Usage({
  copy,
  locale,
  snapshot,
}: {
  copy: LocaleCopy;
  locale: AppLocale;
  snapshot: PortalSnapshot;
}) {
  const upgradeRequests = snapshot.usage.upgradeRequests ?? [];

  return (
    <div className="content-grid">
      <section className="primary-panel">
        <div className="panel-heading">
          <p className="eyebrow">{copy.usage.eyebrow}</p>
          <h2>{formatPlanName(snapshot.usage.plan?.name, copy)}</h2>
          <p className="body-copy">{copy.usage.body}</p>
        </div>
        <div className="metric-row four">
          <Metric
            label={copy.usage.metrics.imagesLeft}
            value={snapshot.usage.remaining?.imagesToday ?? "n/a"}
          />
          <Metric label={copy.usage.metrics.imagesUsed} value={snapshot.usage.imageCount} />
          <Metric label={copy.usage.metrics.messages} value={snapshot.usage.messageCount} />
          <Metric label={copy.usage.metrics.blocked} value={snapshot.usage.blockedCount} />
        </div>
      </section>

      <section className="side-panel">
        <p className="eyebrow">{copy.usage.upgrade}</p>
        <h2>{snapshot.usage.upgrade?.recommended ? copy.usage.upgradeRecommended : copy.usage.planHealthy}</h2>
        <p>{formatUpgradeReason(snapshot.usage.upgrade?.reason, copy)}</p>
        <div className="small-summary">
          <span>{copy.usage.imageLimit}</span>
          <strong>{snapshot.usage.limits?.imagesPerDay ?? "n/a"} {copy.usage.perDay}</strong>
        </div>
      </section>

      <section className="wide-panel">
        {upgradeRequests.length > 0 ? (
          <div className="request-list">
            {upgradeRequests.map(request => (
              <div className="status-row" key={request.id}>
                <div>
                  <strong>{request.requestedPlanName} {copy.usage.request}</strong>
                  <span>
                    {formatUpgradeReason(request.upgradeReason, copy)} - {formatDate(request.createdAt, locale, copy)}
                  </span>
                </div>
                <span className="status-pill neutral">
                  {copy.upgradeStatus[request.status]}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <div className="empty-state">
            <strong>{copy.usage.emptyTitle}</strong>
            <span>{copy.usage.emptyBody}</span>
          </div>
        )}
      </section>
    </div>
  );
}

function Privacy({
  copy,
  snapshot,
}: {
  copy: LocaleCopy;
  snapshot: PortalSnapshot;
}) {
  const controls = snapshot.privacy.controls;

  return (
    <section className="form-panel">
      <div className="panel-heading">
        <p className="eyebrow">{copy.privacy.eyebrow}</p>
        <h2>{copy.privacy.title}</h2>
        <p className="body-copy">{copy.privacy.body}</p>
      </div>

      <div className="control-grid">
        <div>
          <span>{copy.privacy.knowledgeIndexing}</span>
          <strong>{controls.allowKnowledgeIndexing ? copy.common.enabled : copy.common.disabled}</strong>
        </div>
        <div>
          <span>{copy.privacy.usageAnalytics}</span>
          <strong>{controls.allowUsageAnalytics ? copy.common.enabled : copy.common.disabled}</strong>
        </div>
        <div>
          <span>{copy.privacy.imageMemoryRetention}</span>
          <strong>{controls.imageMemoryRetentionDays} {copy.privacy.days}</strong>
        </div>
      </div>

      <div className="link-list">
        <a href={snapshot.privacy.privacy}>{copy.privacy.links.privacy}</a>
        <a href={snapshot.privacy.terms}>{copy.privacy.links.terms}</a>
        <a href={snapshot.privacy.dataDeletion}>{copy.privacy.links.dataDeletion}</a>
        <a href={snapshot.privacy.exportRequest}>{copy.privacy.links.exportRequest}</a>
        <a href={snapshot.privacy.deletionRequest}>{copy.privacy.links.deletionRequest}</a>
      </div>
    </section>
  );
}

export default App;
