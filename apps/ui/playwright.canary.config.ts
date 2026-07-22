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
  // One retry on CI only. This suite drives the REAL payload engine over a
  // localhost HTTP proxy across a JVM + OCR toolchain, so a single request can
  // hit a transient (e.g. an occasional `net::ERR_EMPTY_RESPONSE` from the proxy,
  // or the engine's text map not yet settled after a save) that trips a strict
  // assertion. A retry keeps the canary honest — a genuine regression fails both
  // attempts — while a one-off transient no longer reds the whole run. Locally
  // (no CI) retries stay at 0 so real flakes surface loudly during development.
  retries: process.env.CI ? 1 : 0,
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
