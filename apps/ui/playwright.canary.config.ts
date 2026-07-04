import { defineConfig, devices } from "@playwright/test";

// Real-engine canary config. Distinct from playwright.config.ts (the fast,
// mocked breadth smoke): this one boots the REAL payload engine in globalSetup
// and drives the app against it.
//
// The page is served from a `localhost` origin (NOT 127.0.0.1) on purpose — the
// engine's Rust auth-proxy CORS-allowlists `localhost` / `tauri.localhost` only.
// A 127.0.0.1 origin would be rejected at preflight and every engine call would
// fail on CORS rather than on a real defect.
export default defineConfig({
  testDir: "./smoke/real-engine",
  testMatch: "**/*.canary.ts",
  // Engine ops (OCR especially) are slow; the whole run boots one JVM.
  timeout: 240_000,
  expect: { timeout: 20_000 },
  // One worker: a single shared engine, no request contention, deterministic.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  globalSetup: "./smoke/real-engine/global-setup.ts",
  webServer: {
    command: "pnpm build && pnpm exec vite preview --host localhost --port 4180",
    url: "http://localhost:4180",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
  use: {
    ...devices["Desktop Chrome"],
    acceptDownloads: true,
    baseURL: "http://localhost:4180",
    trace: "retain-on-failure",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
});
