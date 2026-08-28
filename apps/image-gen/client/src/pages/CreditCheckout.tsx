import { useEffect, useState } from "react";
import { Link } from "wouter";

import {
  CREDIT_CHECKOUT_BILLING_POLICY_PATH,
  creditCheckoutModeDisclosure,
  creditCheckoutRefundPolicyDisclosure,
  parseCreditCheckoutOffer,
  type CreditCheckoutOffer,
} from "./creditCheckoutOffer";

type CheckoutState =
  | Readonly<{ kind: "loading" }>
  | Readonly<{
      kind: "ready";
      intentId: string;
      offer: CreditCheckoutOffer;
    }>
  | Readonly<{
      kind: "redirecting";
      intentId: string;
      offer: CreditCheckoutOffer;
    }>
  | Readonly<{
      kind: "returned";
      status: "processing" | "paid" | "failed" | "canceled" | "expired";
    }>
  | Readonly<{ kind: "error" }>;

const INTENT_PATH_PATTERN =
  /^\/credits\/checkout\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

async function readJson(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new Error("Unexpected checkout response");
  }
  return await response.json();
}

function parseHostedCheckoutUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid checkout URL");
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !(url.hostname === "mollie.com" || url.hostname.endsWith(".mollie.com"))
  ) {
    throw new Error("Invalid checkout URL");
  }
  return url.toString();
}

async function claimCheckoutSession(
  intentId: string,
  capability: string
): Promise<CreditCheckoutOffer> {
  const response = await fetch(
    `/api/credits/checkout/${encodeURIComponent(intentId)}/claim`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ capability }),
    }
  );
  if (!response.ok) throw new Error("Checkout claim failed");
  const payload = (await readJson(response)) as { offer?: unknown };
  return parseCreditCheckoutOffer(payload.offer);
}

async function readCheckoutSession(
  intentId: string
): Promise<CreditCheckoutOffer> {
  const response = await fetch(
    `/api/credits/checkout/${encodeURIComponent(intentId)}/session`,
    {
      credentials: "include",
      headers: { Accept: "application/json" },
    }
  );
  if (!response.ok) throw new Error("Checkout session is unavailable");
  const payload = (await readJson(response)) as { offer?: unknown };
  return parseCreditCheckoutOffer(payload.offer);
}

async function readReturnStatus(): Promise<CheckoutState> {
  const response = await fetch("/api/credits/checkout/return-status", {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw new Error("Checkout return is unavailable");
  const payload = (await readJson(response)) as { status?: unknown };
  if (
    payload.status !== "processing" &&
    payload.status !== "paid" &&
    payload.status !== "failed" &&
    payload.status !== "canceled" &&
    payload.status !== "expired"
  ) {
    throw new Error("Invalid checkout return status");
  }
  return { kind: "returned", status: payload.status };
}

function ReturnMessage({ status }: { status: string }) {
  if (status === "paid") {
    return (
      <>
        <h1 className="text-3xl font-semibold text-slate-950">
          Je betaling is ontvangen
        </h1>
        <p className="mt-4 text-slate-700">
          Je 8 premium beeldcredits staan klaar. Ga terug naar Messenger om ze
          te gebruiken.
        </p>
      </>
    );
  }
  if (status === "processing") {
    return (
      <>
        <h1 className="text-3xl font-semibold text-slate-950">
          We controleren je betaling
        </h1>
        <p className="mt-4 text-slate-700">
          De terugkeerpagina is geen betaalbewijs. De credits verschijnen pas
          nadat Mollie de betaling server-side heeft bevestigd.
        </p>
      </>
    );
  }
  return (
    <>
      <h1 className="text-3xl font-semibold text-slate-950">
        De betaling is niet voltooid
      </h1>
      <p className="mt-4 text-slate-700">
        Er zijn geen credits toegevoegd. Je kunt veilig teruggaan naar
        Messenger.
      </p>
    </>
  );
}

export default function CreditCheckout() {
  const [state, setState] = useState<CheckoutState>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        if (window.location.pathname === "/credits/checkout/return") {
          while (active) {
            const returned = await readReturnStatus();
            if (!active) return;
            setState(returned);
            if (
              returned.kind !== "returned" ||
              returned.status !== "processing"
            ) {
              return;
            }
            await new Promise(resolve => window.setTimeout(resolve, 2_000));
          }
          return;
        }
        const match = INTENT_PATH_PATTERN.exec(window.location.pathname);
        const capability = window.location.hash.slice(1);
        // Remove the single-use fragment immediately. URL fragments are never
        // sent to the server, analytics, or Mollie.
        window.history.replaceState(null, "", window.location.pathname);
        if (!match?.[1]) {
          throw new Error("Invalid checkout link");
        }
        let offer: CreditCheckoutOffer;
        if (!capability) {
          offer = await readCheckoutSession(match[1]);
        } else {
          if (!CAPABILITY_PATTERN.test(capability)) {
            throw new Error("Invalid checkout link");
          }
          offer = await claimCheckoutSession(match[1], capability);
        }
        if (active) setState({ kind: "ready", intentId: match[1], offer });
      } catch {
        if (active) setState({ kind: "error" });
      }
    };
    void load();
    return () => {
      active = false;
    };
  }, []);

  const confirm = async (intentId: string, offer: CreditCheckoutOffer) => {
    setState({ kind: "redirecting", intentId, offer });
    try {
      const response = await fetch(
        `/api/credits/checkout/${encodeURIComponent(intentId)}/confirm`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }
      );
      if (!response.ok) throw new Error("Checkout confirmation failed");
      const payload = (await readJson(response)) as { checkoutUrl?: unknown };
      window.location.assign(parseHostedCheckoutUrl(payload.checkoutUrl));
    } catch {
      setState({ kind: "error" });
    }
  };

  return (
    <main className="mx-auto flex min-h-[75vh] w-full max-w-2xl items-center px-5 py-12">
      <section className="w-full rounded-3xl border border-slate-200 bg-white p-7 shadow-sm sm:p-10">
        {state.kind === "loading" ? (
          <>
            <h1 className="text-3xl font-semibold text-slate-950">
              Veilige betaallink controleren
            </h1>
            <p className="mt-4 text-slate-700">Even geduld.</p>
          </>
        ) : null}

        {state.kind === "ready" || state.kind === "redirecting" ? (
          <>
            <p className="text-sm font-semibold uppercase tracking-wide text-blue-700">
              {state.offer.mode === "test"
                ? "Mollie Test Mode"
                : "Leaderbot premiumcredits"}
            </p>
            <h1 className="mt-2 text-3xl font-semibold text-slate-950">
              8 premium beeldcredits
            </h1>
            <p className="mt-3 text-4xl font-bold text-slate-950">€ 4,99</p>
            <div
              className={`mt-5 rounded-2xl p-4 text-sm ${
                state.offer.mode === "test"
                  ? "bg-amber-50 text-amber-950"
                  : "bg-blue-50 text-blue-950"
              }`}
            >
              {creditCheckoutModeDisclosure(state.offer)}
            </div>
            <ul className="mt-6 space-y-2 text-slate-700">
              <li>8 afbeeldingen in medium kwaliteit</li>
              <li>Je credits vervallen niet</li>
              <li>Eén betaling, zonder abonnement</li>
              <li>Geen automatische verlenging of extra kosten</li>
            </ul>
            <div className="mt-5 rounded-2xl border border-slate-200 p-4 text-sm leading-6 text-slate-700">
              <p>{creditCheckoutRefundPolicyDisclosure(state.offer)}</p>
              <p className="mt-2">
                Een terugboeking (chargeback) kan premiumgebruik eveneens
                pauzeren voor controle. Vermoed je een dubbele of technische
                aanrekening? Neem dan contact op via de gegevens in het{" "}
                <Link
                  href={CREDIT_CHECKOUT_BILLING_POLICY_PATH}
                  className="font-medium text-blue-700 hover:underline"
                >
                  betaal- en terugbetalingsbeleid
                </Link>
                .
              </p>
            </div>
            <p className="mt-4 text-sm text-slate-600">
              Lees vóór je bevestigt het volledige{" "}
              <Link
                href={CREDIT_CHECKOUT_BILLING_POLICY_PATH}
                className="font-medium text-blue-700 hover:underline"
              >
                betaal- en terugbetalingsbeleid
              </Link>
              . Je wettelijke rechten als Belgische consument blijven gelden.
            </p>
            <div className="mt-8 rounded-2xl bg-blue-50 p-4 text-sm text-blue-950">
              Alleen de knop hieronder start de beveiligde Mollie-checkout. Het
              openen van deze pagina heeft nog niets aangerekend.
            </div>
            <button
              type="button"
              disabled={state.kind === "redirecting"}
              onClick={() => void confirm(state.intentId, state.offer)}
              className="mt-7 w-full rounded-xl bg-blue-700 px-5 py-3 font-semibold text-white transition hover:bg-blue-800 disabled:cursor-wait disabled:opacity-60"
            >
              {state.kind === "redirecting"
                ? "Mollie wordt geopend…"
                : state.offer.mode === "test"
                  ? "Testbetaling starten"
                  : "Veilig verder naar Mollie"}
            </button>
          </>
        ) : null}

        {state.kind === "returned" ? (
          <ReturnMessage status={state.status} />
        ) : null}

        {state.kind === "error" ? (
          <>
            <h1 className="text-3xl font-semibold text-slate-950">
              Deze betaallink kan niet worden gebruikt
            </h1>
            <p className="mt-4 text-slate-700">
              Er is niets aangerekend. Ga terug naar Messenger en vraag daar een
              nieuwe link.
            </p>
          </>
        ) : null}

        <Link
          href="/"
          className="mt-8 inline-flex text-sm font-medium text-blue-700 hover:underline"
        >
          Terug naar Leaderbot
        </Link>
      </section>
    </main>
  );
}
