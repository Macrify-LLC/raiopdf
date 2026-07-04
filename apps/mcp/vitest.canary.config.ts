import { defineConfig } from "vitest/config";

// Config for the MCP end-to-end canary (test/*.canary.ts). Kept separate from
// vitest.config.ts so the default `pnpm test` (which matches *.test.ts) never runs
// the canary in CI — it needs the assembled engine payload. The canary boots the
// real engine host on the first engine-backed call, so timeouts are generous.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.canary.ts"],
    testTimeout: 240_000,
    hookTimeout: 240_000,
    // One connector/engine at a time — the connector owns a single JVM.
    fileParallelism: false,
  },
});
