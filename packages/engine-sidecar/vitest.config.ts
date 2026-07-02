import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@raiopdf/engine-api": fileURLToPath(
        new URL("../engine-api/src/index.ts", import.meta.url),
      ),
    },
  },
});
