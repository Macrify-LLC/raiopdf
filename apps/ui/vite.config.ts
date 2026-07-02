import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@raiopdf/engine-local": fileURLToPath(
        new URL("../../packages/engine-local/src/index.ts", import.meta.url),
      ),
    },
  },
});
