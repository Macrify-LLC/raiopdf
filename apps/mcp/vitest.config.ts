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
      "@raiopdf/engine-api": fileURLToPath(
        new URL("../../packages/engine-api/src/index.ts", import.meta.url),
      ),
      "@raiopdf/engine-pdf-lib": fileURLToPath(
        new URL("../../packages/engine-pdf-lib/src/index.ts", import.meta.url),
      ),
    },
  },
});
