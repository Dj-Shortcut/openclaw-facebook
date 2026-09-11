import express, { type Express } from "express";
import rateLimit from "express-rate-limit";
import fs from "node:fs";
import { type Server } from "node:http";
import path from "node:path";
import { nanoid } from "nanoid";
import {
  createGlobalHttpRateLimiter,
  DEFAULT_MAX_REQUESTS,
  DEFAULT_WINDOW_MS,
} from "./httpRateLimit";
import { safeLog } from "./logger";

type ViteCreateServer = (typeof import("vite"))["createServer"];
const PROJECT_ROOT_MARKERS = ["package.json", "vite.config.ts"] as const;

function looksLikeProjectRoot(candidate: string): boolean {
  return PROJECT_ROOT_MARKERS.every(marker =>
    fs.existsSync(path.resolve(candidate, marker))
  );
}

function resolveProjectRoot(): string {
  const cwd = process.cwd();
  if (looksLikeProjectRoot(cwd)) {
    return cwd;
  }

  if (typeof __dirname === "string") {
    const serverDirCandidate = path.resolve(__dirname, "..");
    if (looksLikeProjectRoot(serverDirCandidate)) {
      return serverDirCandidate;
    }

    const distDirCandidate = path.resolve(__dirname, "..", "..");
    if (looksLikeProjectRoot(distDirCandidate)) {
      return distDirCandidate;
    }
  }

  return cwd;
}

function createFrontendRateLimiter() {
  return rateLimit({
    windowMs: DEFAULT_WINDOW_MS,
    limit: DEFAULT_MAX_REQUESTS,
    standardHeaders: true,
    legacyHeaders: false,
  });
}

// fallow-ignore-next-line unused-export
export async function setupVite(
  app: Express,
  server: Server,
  createViteServer: ViteCreateServer
) {
  app.use(createGlobalHttpRateLimiter());

  app.use(createFrontendRateLimiter());

  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: true as const,
  };
  const projectRoot = resolveProjectRoot();

  const vite = await createViteServer({
    configFile: path.resolve(projectRoot, "vite.config.ts"),
    server: serverOptions,
    appType: "custom",
  });

  app.use(vite.middlewares);
  app.use((req, res, next) => {
    const url = req.originalUrl;

    void (async () => {
      try {
        const clientTemplate = path.resolve(
          projectRoot,
          "client",
          "index.html"
        );

        // Reload the template on each request so edits appear without a restart.
        let template = await fs.promises.readFile(clientTemplate, "utf-8");
        template = template.replace(
          `src="/src/main.tsx"`,
          `src="/src/main.tsx?v=${nanoid()}"`
        );
        const page = await vite.transformIndexHtml(url, template);
        res.status(200).set({ "Content-Type": "text/html" }).end(page);
      } catch (e) {
        vite.ssrFixStacktrace(e as Error);
        next(e);
      }
    })();
  });
}

export function serveStatic(app: Express, staticRoot?: string) {
  app.use(createFrontendRateLimiter());
  const projectRoot = resolveProjectRoot();
  const distPathCandidates = staticRoot
    ? [path.resolve(staticRoot)]
    : [
        path.resolve(projectRoot, "dist", "public"),
        path.resolve(projectRoot, "public"),
      ];
  const distPath = distPathCandidates.find(candidate =>
    fs.existsSync(candidate)
  );

  if (!distPath) {
    safeLog("static_build_directory_missing", {
      level: "error",
      candidateCount: distPathCandidates.length,
    });
    return;
  }

  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist
  app.use((_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
