import crypto from "node:crypto";
import http from "node:http";

const DEFAULT_ALLOWED_PATHS = "/facebook/webhook,/messenger/webhook,/healthz";
const ADMIN_COOKIE_NAME = "openclaw_admin";
const ADMIN_LOGIN_PATH = "/admin/login";
const ADMIN_LOGOUT_PATH = "/admin/logout";
const ADMIN_SESSION_LABEL = "openclaw-admin-session";
const DEFAULT_ADMIN_SESSION_SECONDS = 8 * 60 * 60;

function readCliOption(args, name, fallback) {
  const flag = `--${name}`;
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === flag && args[index + 1]) {
      return args[index + 1];
    }
    if (item?.startsWith(`${flag}=`)) {
      return item.slice(flag.length + 1);
    }
  }
  return fallback;
}

function setCliOption(args, name, value) {
  const flag = `--${name}`;
  const next = [...args];
  for (let index = 0; index < next.length; index += 1) {
    const item = next[index];
    if (item === flag) {
      next[index + 1] = String(value);
      return next;
    }
    if (item?.startsWith(`${flag}=`)) {
      next[index] = `${flag}=${value}`;
      return next;
    }
  }
  next.push(flag, String(value));
  return next;
}

export function buildGatewayLaunchPlan(argv = process.argv.slice(2), env = process.env) {
  const requestedPort = Number(readCliOption(argv, "port", env.PORT || "3000"));
  const publicPort = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : 3000;
  const internalPort = Number(env.OPENCLAW_INTERNAL_GATEWAY_PORT || publicPort + 1);
  const guardEnabled = env.OPENCLAW_PUBLIC_GATEWAY_GUARD === "1";

  if (!guardEnabled) {
    return {
      guardEnabled,
      publicPort,
      internalPort: publicPort,
      openclawArgs: argv,
    };
  }

  return {
    guardEnabled,
    publicPort,
    internalPort,
    openclawArgs: setCliOption(setCliOption(argv, "port", internalPort), "bind", "loopback"),
  };
}

function allowedPathsFromEnv(env = process.env) {
  return new Set(
    (env.OPENCLAW_PUBLIC_GATEWAY_PATHS || DEFAULT_ALLOWED_PATHS)
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function setSecurityHeaders(res) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("cache-control", "no-store");
}

function readProxyTimeoutMs(env = process.env) {
  const configured = Number(env.OPENCLAW_PUBLIC_GATEWAY_PROXY_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return 10_000;
}

function readAdminSessionSeconds(env = process.env) {
  const configured = Number(env.OPENCLAW_ADMIN_SESSION_SECONDS);
  if (Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured);
  }
  return DEFAULT_ADMIN_SESSION_SECONDS;
}

function readAdminToken(env = process.env) {
  return String(env.OPENCLAW_ADMIN_TOKEN || "").trim();
}

function adminSessionValue(token) {
  return crypto.createHmac("sha256", token).update(ADMIN_SESSION_LABEL).digest("base64url");
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(cookieHeader = "") {
  const cookies = new Map();
  for (const item of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = item.trim().split("=");
    if (!rawName || rawValue.length === 0) {
      continue;
    }
    cookies.set(rawName, rawValue.join("="));
  }
  return cookies;
}

export function isLocalAdminHost(hostHeader) {
  if (!hostHeader) {
    return false;
  }
  try {
    const { hostname } = new URL(`http://${hostHeader}`);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
  } catch {
    return false;
  }
}

function hasAdminSession(req, env = process.env) {
  const token = readAdminToken(env);
  if (!token || !isLocalAdminHost(req.headers.host)) {
    return false;
  }
  const cookieValue = parseCookies(req.headers.cookie || "").get(ADMIN_COOKIE_NAME) || "";
  return cookieValue !== "" && safeEqual(cookieValue, adminSessionValue(token));
}

function adminCookie(token, env = process.env) {
  const sessionSeconds = readAdminSessionSeconds(env);
  return `${ADMIN_COOKIE_NAME}=${adminSessionValue(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionSeconds}`;
}

function clearedAdminCookie() {
  return `${ADMIN_COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

function isAllowedPublicRequest(method, pathname, allowedPaths) {
  if (!allowedPaths.has(pathname)) {
    return false;
  }
  if (pathname === "/healthz") {
    return method === "GET" || method === "HEAD";
  }
  return method === "GET" || method === "POST";
}

function writeBlocked(res) {
  setSecurityHeaders(res);
  res.statusCode = 404;
  res.end("Not found");
}

function writeAdminLogin(res, statusCode = 200) {
  setSecurityHeaders(res);
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>OpenClaw Admin</title>
    <style>
      :root { color-scheme: dark; font-family: system-ui, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #07090d; color: #f5f7fb; }
      main { width: min(92vw, 360px); }
      h1 { margin: 0 0 20px; font-size: 24px; }
      label { display: grid; gap: 8px; color: #c6ccd7; font-size: 14px; }
      input, button { width: 100%; box-sizing: border-box; border-radius: 8px; border: 1px solid #2f3542; padding: 12px 14px; font: inherit; }
      input { margin: 0 0 14px; background: #0d1118; color: #fff; }
      button { background: #f5f7fb; color: #080a0f; cursor: pointer; font-weight: 700; }
    </style>
  </head>
  <body>
    <main>
      <h1>OpenClaw Admin</h1>
      <form method="post" action="${ADMIN_LOGIN_PATH}">
        <label>Admin token
          <input name="token" type="password" autocomplete="current-password" autofocus required>
        </label>
        <button type="submit">Sign in</button>
      </form>
    </main>
  </body>
</html>`);
}

function readRequestBody(req, maxBytes = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > maxBytes) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function handleAdminRequest(req, res, pathname, env = process.env) {
  const token = readAdminToken(env);
  if (!token || !isLocalAdminHost(req.headers.host)) {
    writeBlocked(res);
    return true;
  }

  if (pathname === ADMIN_LOGOUT_PATH) {
    res.statusCode = 303;
    res.setHeader("set-cookie", clearedAdminCookie());
    res.setHeader("location", ADMIN_LOGIN_PATH);
    res.end();
    return true;
  }

  if (pathname !== ADMIN_LOGIN_PATH) {
    return false;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    writeAdminLogin(res);
    return true;
  }

  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("allow", "GET, HEAD, POST");
    res.end("Method not allowed");
    return true;
  }

  try {
    const form = new URLSearchParams(await readRequestBody(req));
    if (safeEqual(form.get("token") || "", token)) {
      res.statusCode = 303;
      res.setHeader("set-cookie", adminCookie(token, env));
      res.setHeader("location", "/");
      res.end();
      return true;
    }
  } catch {
    res.statusCode = 400;
    res.end("Bad request");
    return true;
  }

  writeAdminLogin(res, 401);
  return true;
}

function proxyRequest(req, res, { targetHost, targetPort, proxyTimeoutMs }) {
  const headers = { ...req.headers };
  delete headers.connection;
  delete headers["keep-alive"];
  delete headers["proxy-authenticate"];
  delete headers["proxy-authorization"];
  delete headers.te;
  delete headers.trailer;
  delete headers["transfer-encoding"];
  delete headers.upgrade;
  headers.host = `${targetHost}:${targetPort}`;
  headers["x-forwarded-host"] = req.headers.host || "";
  headers["x-forwarded-proto"] = "https";

  const proxyReq = http.request(
    {
      host: targetHost,
      port: targetPort,
      method: req.method,
      path: req.url,
      headers,
    },
    (proxyRes) => {
      setSecurityHeaders(res);
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  let proxyFailureWritten = false;
  const writeProxyFailure = (statusCode, message) => {
    if (proxyFailureWritten || res.writableEnded) {
      return;
    }
    proxyFailureWritten = true;
    setSecurityHeaders(res);
    res.statusCode = statusCode;
    res.end(message);
  };

  proxyReq.setTimeout(proxyTimeoutMs, () => {
    req.unpipe(proxyReq);
    proxyReq.destroy();
    writeProxyFailure(504, "Gateway timeout");
  });

  proxyReq.on("error", () => {
    writeProxyFailure(502, "Gateway starting");
  });

  req.pipe(proxyReq);
}

export function startPublicRouteGuard({
  publicPort,
  targetPort,
  targetHost = "127.0.0.1",
  env = process.env,
}) {
  const allowedPaths = allowedPathsFromEnv(env);
  const proxyTimeoutMs = readProxyTimeoutMs(env);
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`).pathname;
    if (pathname === ADMIN_LOGIN_PATH || pathname === ADMIN_LOGOUT_PATH) {
      handleAdminRequest(req, res, pathname, env).catch(() => {
        if (!res.writableEnded) {
          res.statusCode = 500;
          res.end("Internal error");
        }
      });
      return;
    }

    if (hasAdminSession(req, env)) {
      proxyRequest(req, res, { targetHost, targetPort, proxyTimeoutMs });
      return;
    }

    if (!isAllowedPublicRequest(req.method || "GET", pathname, allowedPaths)) {
      writeBlocked(res);
      return;
    }

    proxyRequest(req, res, { targetHost, targetPort, proxyTimeoutMs });
  });

  server.on("upgrade", (_req, socket) => {
    socket.destroy();
  });

  server.listen(publicPort, "0.0.0.0", () => {
    console.warn(
      `public gateway guard listening on 0.0.0.0:${publicPort}; proxying allowed paths to ${targetHost}:${targetPort}`,
    );
  });

  return server;
}
