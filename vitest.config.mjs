import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    exclude: [
      "apps/**",
      ".worktrees/**",
      ".tmp-npm-pack/**",
      "node_modules/**",
      "dist/**",
      "coverage/**",
    ],
    fileParallelism: false,
    pool: "threads",
    testTimeout: 120000,
  },
});
