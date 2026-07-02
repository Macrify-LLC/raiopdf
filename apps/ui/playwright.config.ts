import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./smoke",
  testMatch: "**/*.smoke.ts",
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  webServer: {
    command: "pnpm build && pnpm exec vite preview --host 127.0.0.1 --port 4173",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  use: {
    ...devices["Desktop Chrome"],
    acceptDownloads: true,
    baseURL: "http://127.0.0.1:4173",
    // Override only when explicitly pointed at a system browser; otherwise use
    // Playwright's own managed chromium (installed in CI via `playwright install`).
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
});
