import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    alias: {
      "@raiopdf/engine-api": fileURLToPath(
        new URL("../engine-api/src/index.ts", import.meta.url),
      ),
      "@raiopdf/engine-local": fileURLToPath(
        new URL("../engine-local/src/index.ts", import.meta.url),
      ),
      "@raiopdf/engine-pdf-lib": fileURLToPath(
        new URL("../engine-pdf-lib/src/index.ts", import.meta.url),
      ),
      "@raiopdf/package-writer": fileURLToPath(
        new URL("../package-writer/src/index.ts", import.meta.url),
      ),
    },
  },
});
