import http from "node:http";

const DEFAULT_ALLOWED_PATHS = "/facebook/webhook,/messenger/webhook,/healthz";

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
    if (!isAllowedPublicRequest(req.method || "GET", pathname, allowedPaths)) {
      writeBlocked(res);
      return;
    }

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
