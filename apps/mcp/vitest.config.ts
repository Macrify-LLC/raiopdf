import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    alias: {
      "@raiopdf/engine-sidecar": fileURLToPath(
        new URL("../../packages/engine-sidecar/src/index.ts", import.meta.url),
      ),
      "@raiopdf/engine-local": fileURLToPath(
        new URL("../../packages/engine-local/src/index.ts", import.meta.url),
      ),
      "@raiopdf/engine-api": fileURLToPath(
        new URL("../../packages/engine-api/src/index.ts", import.meta.url),
      ),
      "@raiopdf/engine-pdf-lib": fileURLToPath(
        new URL("../../packages/engine-pdf-lib/src/index.ts", import.meta.url),
      ),
      "@raiopdf/package-writer": fileURLToPath(
        new URL("../../packages/package-writer/src/index.ts", import.meta.url),
      ),
      "@raiopdf/batch-cleanup": fileURLToPath(
        new URL("../../packages/batch-cleanup/src/index.ts", import.meta.url),
      ),
      "@raiopdf/production-set": fileURLToPath(
        new URL("../../packages/production-set/src/index.ts", import.meta.url),
      ),
      "@raiopdf/rules/node": fileURLToPath(
        new URL("../../packages/rules/src/node.ts", import.meta.url),
      ),
      "@raiopdf/rules": fileURLToPath(
        new URL("../../packages/rules/src/index.ts", import.meta.url),
      ),
    },
  },
});
