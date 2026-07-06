import { useAuth } from "@/_core/hooks/useAuth";
import {
  clearPendingHandoffToken,
  readPendingHandoffToken,
  writeActiveWorkspaceId,
  writePendingHandoffToken,
} from "@/_core/portalWorkspace";
import { Button } from "@/components/ui/button";
import { getLoginUrl, isLoginConfigured } from "@/const";
import { trpc } from "@/lib/trpc";
import { AlertTriangle, CheckCircle2, LogIn, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { useRoute } from "wouter";

function getClaimErrorMessage(message?: string) {
  if (message?.includes("expired")) {
    return "This setup link has expired. Ask for a fresh premium setup link in Messenger.";
  }
  if (message?.includes("already_used")) {
    return "This setup link has already been used. Open the portal or ask for a fresh link.";
  }
  return "This setup link is invalid. Ask for a fresh premium setup link in Messenger.";
}

function isTerminalClaimError(message?: string) {
  return Boolean(
    message &&
      (message.includes("expired") ||
        message.includes("already_used") ||
        message.includes("invalid"))
  );
}

function PortalHandoff() {
  const auth = useAuth();
  const [, params] = useRoute<{ token?: string }>("/handoff/:token");
  const loginConfigured = isLoginConfigured();
  const routeToken = typeof params?.token === "string" ? params.token : null;
  const [storedToken, setStoredToken] = useState(() => routeToken ?? readPendingHandoffToken());
  const [claimAttemptedToken, setClaimAttemptedToken] = useState<string | null>(null);
  const token = routeToken ?? storedToken;

  const claimMutation = trpc.portal.handoff.claim.useMutation({
    onSuccess: data => {
      writeActiveWorkspaceId(data.workspace.id);
      clearPendingHandoffToken();
      window.location.assign(`/?workspaceId=${data.workspace.id}&onboarding=handoff`);
    },
    onError: error => {
      if (!isTerminalClaimError(error.message)) return;
      clearPendingHandoffToken();
      setStoredToken(null);
    },
  });
  const claimHandoff = claimMutation.mutate;

  useEffect(() => {
    if (!routeToken) return;
    writePendingHandoffToken(routeToken);
    setStoredToken(routeToken);
  }, [routeToken]);

  useEffect(() => {
    if (!auth.isAuthenticated || !token || claimAttemptedToken === token) return;
    setClaimAttemptedToken(token);
    claimHandoff({ token });
  }, [auth.isAuthenticated, claimAttemptedToken, claimHandoff, token]);

  const startLogin = () => {
    if (token) {
      writePendingHandoffToken(token);
    }
    const loginUrl = getLoginUrl("/handoff");
    if (!loginUrl) return;
    window.location.href = loginUrl;
  };

  if (!token) {
    return (
      <main className="min-h-full bg-[#f6f2ea] px-6 py-10 text-stone-950">
        <div className="mx-auto flex min-h-[70vh] max-w-3xl items-center">
          <section className="w-full rounded-lg border border-red-200 bg-white p-8 shadow-sm">
            <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-lg bg-red-100 text-red-700">
              <AlertTriangle className="h-6 w-6" />
            </div>
            <h1 className="text-3xl font-semibold text-stone-950">
              Setup link missing
            </h1>
            <p className="mt-4 text-base leading-7 text-stone-600">
              Open the premium setup link from Messenger again.
            </p>
          </section>
        </div>
      </main>
    );
  }

  if (!auth.isAuthenticated) {
    return (
      <main className="min-h-full bg-[#f6f2ea] px-6 py-10 text-stone-950">
        <div className="mx-auto flex min-h-[70vh] max-w-3xl items-center">
          <section className="w-full rounded-lg border border-stone-200 bg-white p-8 shadow-sm">
            <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-lg bg-teal-100 text-teal-700">
              <ShieldCheck className="h-6 w-6" />
            </div>
            <h1 className="text-3xl font-semibold text-stone-950">
              Premium setup ready
            </h1>
            <p className="mt-4 max-w-2xl text-base leading-7 text-stone-600">
              Continue with Facebook to claim your workspace and finish your
              Leaderbot setup.
            </p>
            <Button
              className="mt-8 gap-2"
              disabled={auth.loading || !loginConfigured}
              onClick={startLogin}
            >
              <LogIn className="h-4 w-4" />
              Continue with Facebook
            </Button>
            {!loginConfigured ? (
              <p className="mt-4 text-sm text-amber-700">
                Facebook Login is not configured for this local environment.
              </p>
            ) : null}
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-full bg-[#f6f2ea] px-6 py-10 text-stone-950">
      <div className="mx-auto flex min-h-[70vh] max-w-3xl items-center">
        <section className="w-full rounded-lg border border-stone-200 bg-white p-8 shadow-sm">
          <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-lg bg-teal-100 text-teal-700">
            {claimMutation.isError ? (
              <AlertTriangle className="h-6 w-6" />
            ) : (
              <CheckCircle2 className="h-6 w-6" />
            )}
          </div>
          <h1 className="text-3xl font-semibold text-stone-950">
            {claimMutation.isError ? "Setup link could not be claimed" : "Claiming workspace"}
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-stone-600">
            {claimMutation.isError
              ? getClaimErrorMessage(claimMutation.error.message)
              : "Securing your premium workspace and opening the portal."}
          </p>
          {claimMutation.isError ? (
            <Button
              className="mt-8 gap-2"
              type="button"
              onClick={() => {
                window.location.assign("/");
              }}
            >
              Open portal
            </Button>
          ) : null}
        </section>
      </div>
    </main>
  );
}

export default PortalHandoff;
