import { parse as parseCookieHeader } from "cookie";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";

import {
  CREDIT_CHECKOUT_SESSION_COOKIE,
  CREDIT_CHECKOUT_SESSION_MAX_AGE_MS,
  claimCreditCheckoutBrowserSession,
  mapCreditCheckoutReturnStatus,
  readCreditCheckoutBrowserSession,
  type ClaimedCreditCheckoutSession,
} from "./creditCheckoutSession";
import { isCreditPaymentGrantComplete } from "./creditPaymentWebhookStore";

const CREDIT_CHECKOUT_BODY_LIMIT = "2kb";
const INTENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type BrowserSession = Awaited<
  ReturnType<typeof readCreditCheckoutBrowserSession>
>;

export type CreditCheckoutRouteDependencies = Readonly<{
  claim?: typeof claimCreditCheckoutBrowserSession;
  readSession?: typeof readCreditCheckoutBrowserSession;
  grantComplete?: typeof isCreditPaymentGrantComplete;
  confirm: (
    session: BrowserSession
  ) => Promise<Readonly<{ checkoutUrl: string }>>;
}>;

export function registerCreditCheckoutRoutes(
  app: Express,
  dependencies: CreditCheckoutRouteDependencies
): void {
  const claim = dependencies.claim ?? claimCreditCheckoutBrowserSession;
  const readSession =
    dependencies.readSession ?? readCreditCheckoutBrowserSession;
  const grantComplete =
    dependencies.grantComplete ?? isCreditPaymentGrantComplete;
  const json = express.json({
    limit: CREDIT_CHECKOUT_BODY_LIMIT,
    strict: true,
    type: "application/json",
  });

  app.post(
    "/api/credits/checkout/:intentId/claim",
    json,
    asyncRoute(async (req, res) => {
      if (!isSameOriginMutation(req)) {
        unavailable(res);
        return;
      }
      const intentId = singleParam(req.params.intentId);
      const capability = readExactCapabilityBody(req.body);
      if (!intentId || !INTENT_ID_PATTERN.test(intentId) || !capability) {
        unavailable(res);
        return;
      }
      let session: ClaimedCreditCheckoutSession;
      try {
        session = await claim({ intentId, capability });
      } catch {
        unavailable(res);
        return;
      }
      setSessionCookie(req, res, session.cookieValue);
      noStore(res).status(200).json({ offer: session.offer });
    })
  );

  app.get(
    "/api/credits/checkout/session",
    asyncRoute(async (req, res) => {
      const cookieValue = readSessionCookie(req);
      try {
        const session = await readSession(cookieValue, {
          requireUnexpired: true,
        });
        noStore(res).status(200).json({ offer: session.offer });
      } catch {
        unavailable(res);
      }
    })
  );

  app.post(
    "/api/credits/checkout/confirm",
    json,
    asyncRoute(async (req, res) => {
      if (!isSameOriginMutation(req)) {
        unavailable(res);
        return;
      }
      if (!isExactEmptyBody(req.body)) {
        unavailable(res);
        return;
      }
      const cookieValue = readSessionCookie(req);
      try {
        const session = await readSession(cookieValue, {
          requireUnexpired: true,
        });
        const result = await dependencies.confirm(session);
        noStore(res)
          .status(200)
          .json({ checkoutUrl: exactHostedCheckoutUrl(result.checkoutUrl) });
      } catch {
        unavailable(res);
      }
    })
  );

  app.get(
    "/api/credits/checkout/return-status",
    asyncRoute(async (req, res) => {
      const cookieValue = readSessionCookie(req);
      try {
        const session = await readSession(cookieValue, {
          requireUnexpired: false,
        });
        const status = await resolveReturnStatus(session, grantComplete);
        noStore(res).status(200).json({
          status,
        });
      } catch {
        unavailable(res);
      }
    })
  );
}

async function resolveReturnStatus(
  session: BrowserSession,
  grantComplete: typeof isCreditPaymentGrantComplete
) {
  if (session.record.status !== "paid") {
    return mapCreditCheckoutReturnStatus(session.record.status);
  }
  const providerPaymentId = session.record.molliePaymentId;
  const walletId = session.record.creditWalletId;
  const metadataHash = session.record.creditMetadataHash;
  if (!providerPaymentId || !walletId || !metadataHash) return "processing";
  const complete = await grantComplete({
    workspaceId: session.record.workspaceId,
    mode: session.record.mode,
    intentId: session.record.intentId,
    providerPaymentId,
    walletId,
    metadataHash,
  });
  return complete ? "paid" : "processing";
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    void handler(req, res).catch(next);
  };
}

function noStore(res: Response): Response {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Referrer-Policy", "no-referrer");
  return res;
}

function unavailable(res: Response): void {
  noStore(res).status(404).json({ error: "checkout unavailable" });
}

function singleParam(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function readExactCapabilityBody(body: unknown): string | null {
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    Object.getPrototypeOf(body) !== Object.prototype
  ) {
    return null;
  }
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "capability") return null;
  const capability = (body as Record<string, unknown>).capability;
  return typeof capability === "string" ? capability : null;
}

function isExactEmptyBody(body: unknown): boolean {
  return (
    typeof body === "object" &&
    body !== null &&
    !Array.isArray(body) &&
    Object.getPrototypeOf(body) === Object.prototype &&
    Object.keys(body).length === 0
  );
}

function expectedPublicOrigin(): string {
  const raw = process.env.APP_BASE_URL?.trim() ?? "";
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Credit checkout public origin is unavailable");
  }
  const localHttp =
    process.env.NODE_ENV !== "production" &&
    parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  if (
    (parsed.protocol !== "https:" && !localHttp) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Credit checkout public origin is unavailable");
  }
  return parsed.origin;
}

function isSameOriginMutation(req: Request): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string") return false;
  try {
    if (origin !== expectedPublicOrigin()) return false;
  } catch {
    return false;
  }
  const fetchSite = req.headers["sec-fetch-site"];
  if (
    typeof fetchSite === "string" &&
    fetchSite !== "same-origin" &&
    fetchSite !== "none"
  ) {
    return false;
  }
  return true;
}

function isSecureRequest(req: Request): boolean {
  if (req.secure) return true;
  const forwarded = req.headers["x-forwarded-proto"];
  const values = Array.isArray(forwarded)
    ? forwarded
    : typeof forwarded === "string"
      ? forwarded.split(",")
      : [];
  return values.some(value => value.trim().toLowerCase() === "https");
}

function setSessionCookie(
  req: Request,
  res: Response,
  cookieValue: string
): void {
  res.cookie(CREDIT_CHECKOUT_SESSION_COOKIE, cookieValue, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production" || isSecureRequest(req),
    sameSite: "lax",
    path: "/",
    maxAge: CREDIT_CHECKOUT_SESSION_MAX_AGE_MS,
  });
}

function readSessionCookie(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  const cookies = parseCookieHeader(header);
  const value = cookies[CREDIT_CHECKOUT_SESSION_COOKIE];
  return typeof value === "string" ? value : undefined;
}

function exactHostedCheckoutUrl(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Credit checkout provider URL is invalid");
  }
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash ||
    !(
      parsed.hostname === "mollie.com" ||
      parsed.hostname.endsWith(".mollie.com")
    )
  ) {
    throw new Error("Credit checkout provider URL is invalid");
  }
  return parsed.toString();
}
