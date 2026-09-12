import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import path from "path";

const templateRoot = path.resolve(import.meta.dirname);

export default defineConfig({
  root: templateRoot,
  // The client tests import real components, and `tsconfig.json` leaves JSX to
  // the bundler. Without this plugin a `.tsx` module reaches Vitest untranslated
  // and fails import analysis.
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(templateRoot, "client", "src"),
      "@shared": path.resolve(templateRoot, "shared"),
      "@assets": path.resolve(templateRoot, "attached_assets"),
    },
  },
  test: {
    environment: "node",
    include: [
      "client/**/*.test.ts",
      "server/**/*.test.ts",
      "server/**/*.spec.ts",
      "scripts/**/*.test.mjs",
    ],
    hookTimeout: 180_000,
    testTimeout: 180_000,
  },
});
