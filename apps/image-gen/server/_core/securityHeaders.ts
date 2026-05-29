import type { Express, Request, Response, NextFunction } from "express";

function isSecureRequest(req: Request): boolean {
  if (req.protocol === "https") {
    return true;
  }

  const forwardedProto = req.headers["x-forwarded-proto"];
  if (!forwardedProto) {
    return false;
  }

  const values = Array.isArray(forwardedProto)
    ? forwardedProto
    : forwardedProto.split(",");

  return values.some(value => value.trim().toLowerCase() === "https");
}

export function applySecurityHeaders(app: Express): void {
  app.disable("x-powered-by");

  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");

    if (process.env.NODE_ENV === "production" && isSecureRequest(req)) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }

    next();
  });
}
