import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@raiopdf/engine-api": fileURLToPath(
        new URL("../../packages/engine-api/src/index.ts", import.meta.url),
      ),
      "@raiopdf/engine-local": fileURLToPath(
        new URL("../../packages/engine-local/src/index.ts", import.meta.url),
      ),
      "@raiopdf/engine-pdf-lib": fileURLToPath(
        new URL("../../packages/engine-pdf-lib/src/index.ts", import.meta.url),
      ),
      "@raiopdf/rules": fileURLToPath(
        new URL("../../packages/rules/src/index.ts", import.meta.url),
      ),
      "@raiopdf/engine-sidecar": fileURLToPath(
        new URL("../../packages/engine-sidecar/src/index.ts", import.meta.url),
      ),
    },
  },
});
