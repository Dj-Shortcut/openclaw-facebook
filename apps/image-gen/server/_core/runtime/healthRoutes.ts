import type express from "express";
import {
  buildRuntimeReadinessChecks,
  createReadinessHandler,
  type ReadinessCheck,
} from "../readiness";
import { getMollieReadinessPhase } from "../billing/config";

export function registerHealthRoutes(
  app: express.Express,
  options: { readinessChecks?: readonly ReadinessCheck[] } = {}
) {
  // Support both /health and /healthz for compatibility with Fly.io and other platforms
  const healthHandler = (_req: express.Request, res: express.Response) => {
    res.status(200).send("ok");
  };

  app.get("/health", healthHandler);
  app.get("/healthz", healthHandler);
  app.get(
    "/readyz",
    createReadinessHandler(
      options.readinessChecks ?? buildRuntimeReadinessChecks(),
      {
        getPhase: getMollieReadinessPhase,
      }
    )
  );
}
