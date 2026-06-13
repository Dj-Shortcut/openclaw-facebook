import type express from "express";
import {
  buildRuntimeReadinessChecks,
  createReadinessHandler,
} from "../readiness";

export function registerHealthRoutes(app: express.Express) {
  // Support both /health and /healthz for compatibility with Fly.io and other platforms
  const healthHandler = (_req: express.Request, res: express.Response) => {
    res.status(200).send("ok");
  };

  app.get("/health", healthHandler);
  app.get("/healthz", healthHandler);
  app.get("/readyz", createReadinessHandler(buildRuntimeReadinessChecks()));
}
