import {
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
import { useEffect, useMemo, useState } from "react";
import { mockSnapshot } from "./mockData";
import {
  getPortalSnapshot,
  startFacebookConnect,
  updateAiIdentity,
  type ChannelStatus,
  type PortalSnapshot,
} from "./portalApi";

type View = "dashboard" | "identity" | "channels" | "usage" | "privacy";

const navItems: Array<{ view: View; label: string; icon: typeof Gauge }> = [
  { view: "dashboard", label: "Dashboard", icon: Gauge },
  { view: "identity", label: "AI identity", icon: Bot },
  { view: "channels", label: "Channels", icon: MessageCircle },
  { view: "usage", label: "Usage", icon: RefreshCw },
  { view: "privacy", label: "Privacy", icon: ShieldCheck },
];

function statusLabel(status: ChannelStatus) {
  switch (status) {
    case "connected":
      return "Connected";
    case "missing_permissions":
      return "Missing permissions";
    case "token_expired":
      return "Token expired";
    case "webhook_unhealthy":
      return "Webhook unhealthy";
    case "disconnected":
      return "Disconnected";
  }
}

function App() {
  const [snapshot, setSnapshot] = useState<PortalSnapshot>(mockSnapshot);
  const [view, setView] = useState<View>("dashboard");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;

    getPortalSnapshot()
      .then(data => {
        if (alive) setSnapshot(data);
      })
      .catch(error => {
        if (alive) {
          setNotice(`Portal API unavailable: ${error.message}`);
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
      setNotice("AI identity saved.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not save AI identity.");
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
        setNotice("Facebook app id is not configured on the portal backend.");
        return;
      }
      if (authWindow) {
        authWindow.location.href = response.authorizationUrl;
      } else {
        window.location.href = response.authorizationUrl;
      }
      setNotice("Facebook authorization opened. Return here after approving the Page.");
    } catch (error) {
      authWindow?.close();
      setNotice(error instanceof Error ? error.message : "Could not start Facebook connect.");
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
            <span>Customer portal</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="Main navigation">
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
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="sidebar-footer">
          <Lock size={16} />
          <span>Gateway access is server-side only.</span>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Workspace</p>
            <h1>{snapshot.workspace.name}</h1>
          </div>
          <div className="account">
            <Settings size={16} />
            <span>{snapshot.user.email ?? snapshot.user.name ?? "Signed in"}</span>
          </div>
        </header>

        {notice ? <div className="notice">{notice}</div> : null}
        {loading ? <div className="notice muted">Loading portal data...</div> : null}

        {view === "dashboard" ? (
          <Dashboard snapshot={snapshot} facebookStatus={facebook?.status ?? "disconnected"} />
        ) : null}
        {view === "identity" ? (
          <IdentityForm snapshot={snapshot} saving={saving} onSave={saveIdentity} />
        ) : null}
        {view === "channels" ? (
          <Channels
            facebook={facebook}
            saving={saving}
            onConnectFacebook={connectFacebook}
          />
        ) : null}
        {view === "usage" ? <Usage snapshot={snapshot} /> : null}
        {view === "privacy" ? <Privacy snapshot={snapshot} /> : null}
      </section>
    </main>
  );
}

function Dashboard({
  snapshot,
  facebookStatus,
}: {
  snapshot: PortalSnapshot;
  facebookStatus: ChannelStatus;
}) {
  return (
    <div className="content-grid">
      <section className="primary-panel">
        <p className="eyebrow">Today</p>
        <h2>Operational status</h2>
        <div className="metric-row">
          <Metric label="Messages" value={snapshot.usage.messageCount} />
          <Metric label="Images" value={snapshot.usage.imageCount} />
          <Metric label="Blocked" value={snapshot.usage.blockedCount} />
        </div>
      </section>

      <section className="side-panel">
        <p className="eyebrow">Next action</p>
        <h2>{facebookStatus === "connected" ? "Review AI identity" : "Connect Facebook Page"}</h2>
        <p>
          {facebookStatus === "connected"
            ? "Keep instructions current before broad customer traffic."
            : "Messenger stays inactive until a customer-owned Page is authorized."}
        </p>
      </section>

      <section className="wide-panel">
        <div className="split-line">
          <span>Facebook Messenger</span>
          <strong>{statusLabel(facebookStatus)}</strong>
        </div>
        <div className="split-line">
          <span>AI identity</span>
          <strong>{snapshot.aiIdentity.name}</strong>
        </div>
        <div className="split-line">
          <span>Privacy controls</span>
          <strong>Available</strong>
        </div>
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function IdentityForm({
  snapshot,
  saving,
  onSave,
}: {
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
      <div>
        <p className="eyebrow">AI identity</p>
        <h2>Customer-facing assistant settings</h2>
      </div>
      <label>
        Name
        <input name="name" defaultValue={snapshot.aiIdentity.name} />
      </label>
      <label>
        Instructions
        <textarea
          name="instructions"
          rows={8}
          defaultValue={snapshot.aiIdentity.instructions ?? ""}
        />
      </label>
      <div className="form-row">
        <label>
          Tone
          <input name="tone" defaultValue={snapshot.aiIdentity.tone} />
        </label>
        <label>
          Language
          <input name="language" defaultValue={snapshot.aiIdentity.language} />
        </label>
        <label>
          Model default
          <input name="modelDefault" defaultValue={snapshot.aiIdentity.modelDefault} />
        </label>
      </div>
      <button className="primary-action" disabled={saving} type="submit">
        <KeyRound size={16} />
        <span>{saving ? "Saving" : "Save identity"}</span>
      </button>
    </form>
  );
}

function Channels({
  facebook,
  saving,
  onConnectFacebook,
}: {
  facebook: PortalSnapshot["channels"][number] | undefined;
  saving: boolean;
  onConnectFacebook: () => void;
}) {
  const status = facebook?.status ?? "disconnected";
  return (
    <section className="form-panel">
      <div>
        <p className="eyebrow">Channels</p>
        <h2>Facebook Messenger</h2>
      </div>
      <div className="channel-line">
        <div>
          <strong>{facebook?.displayName ?? "No Page connected"}</strong>
          <span>{statusLabel(status)}</span>
        </div>
        <span className={`status-pill ${status}`}>{statusLabel(status)}</span>
      </div>
      <p className="body-copy">
        The customer authorizes a Page with Facebook Login. Tokens stay encrypted on
        the portal backend and the OpenClaw gateway remains private.
      </p>
      <button className="primary-action" disabled={saving} type="button" onClick={onConnectFacebook}>
        <Link2 size={16} />
        <span>{saving ? "Opening" : "Connect Facebook Page"}</span>
        <ChevronRight size={16} />
      </button>
    </section>
  );
}

function Usage({ snapshot }: { snapshot: PortalSnapshot }) {
  return (
    <section className="primary-panel">
      <p className="eyebrow">Usage and limits</p>
      <h2>Current period</h2>
      <div className="metric-row">
        <Metric label="Messages" value={snapshot.usage.messageCount} />
        <Metric label="Images" value={snapshot.usage.imageCount} />
        <Metric label="Blocked attempts" value={snapshot.usage.blockedCount} />
      </div>
      <p className="body-copy">
        Tenant-level spend caps and upgrade controls are reserved for the paid rollout.
      </p>
    </section>
  );
}

function Privacy({ snapshot }: { snapshot: PortalSnapshot }) {
  return (
    <section className="form-panel">
      <p className="eyebrow">Privacy</p>
      <h2>Customer data controls</h2>
      <div className="link-list">
        <a href={snapshot.privacy.privacy}>Privacy policy</a>
        <a href={snapshot.privacy.terms}>Terms</a>
        <a href={snapshot.privacy.dataDeletion}>Data deletion</a>
        <a href={snapshot.privacy.exportRequest}>Request data export</a>
        <a href={snapshot.privacy.deletionRequest}>Request workspace deletion</a>
      </div>
    </section>
  );
}

export default App;
