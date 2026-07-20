/**
 * WebdriverIO config for the real-app dialog canary.
 *
 * It drives the packaged RaioPDF shell binary (built with the `e2e-webdriver`
 * Cargo feature) through `@wdio/tauri-service`, which on Windows manages
 * `tauri-driver` and — critically — keeps `msedgedriver` matched to the
 * WebView2 runtime *embedded in the binary* (not the machine's Edge browser
 * version, which can differ and yields a "DevToolsActivePort" session-creation
 * failure). The specs exercise real Tauri IPC and real Rust command bodies; only
 * the native OS pickers are swapped for canned paths via the `e2e_dialog`
 * control file.
 *
 * Env seams (set here, before the app launches, and inherited by
 * tauri-driver -> app):
 *   RAIOPDF_ENGINE_PAYLOAD_DIR  -> the assembled payload (qpdf/Ghostscript)
 *   RAIO_E2E_DIALOG_CONTROL     -> the dialog stub's control file
 *
 * Overridable knobs: RAIO_E2E_APP (exe path), RAIO_E2E_PAYLOAD_DIR, RAIO_E2E_TMP.
 */
import { existsSync, mkdirSync } from "node:fs";
import { appPath, controlFile, fixturesDir, outputsDir, payloadDir, tmpRoot } from "./support/paths";
import { clearDialogControl } from "./support/dialogControl";
import { waitForAppReady } from "./support/app";

// Point the shell at the assembled payload and the dialog control file. The
// config module is evaluated in each worker, so the app the service launches
// there inherits these.
process.env.RAIOPDF_ENGINE_PAYLOAD_DIR ??= payloadDir;
process.env.RAIO_E2E_DIALOG_CONTROL = controlFile;

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./specs/**/*.e2e.ts"],
  // One app at a time. Each spec file is its own session (a fresh app launch),
  // so the flows never share state.
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application: appPath },
    } as WebdriverIO.Capabilities,
  ],
  services: [
    [
      "tauri",
      {
        appBinaryPath: appPath,
        // Windows: drive the WebView2 app via the official tauri-driver route.
        driverProvider: "official",
        // tauri-driver is provided by CI (cached cargo install) and, locally,
        // per the README; the service consumes it from PATH.
        autoInstallTauriDriver: false,
        // The fix for "DevToolsActivePort": match msedgedriver to the binary's
        // WebView2 runtime, downloading it if the versions differ.
        autoDownloadEdgeDriver: true,
      },
    ],
  ],
  logLevel: "info",
  waitforTimeout: 20_000,
  connectionRetryTimeout: 120_000,
  connectionRetryCount: 3,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 180_000,
  },

  onPrepare: () => {
    if (!existsSync(appPath)) {
      throw new Error(
        `Shell binary not found at ${appPath}.\n` +
          "Build it first: `pnpm build:shell:e2e:windows-x64` (or set RAIO_E2E_APP).",
      );
    }
    for (const dir of [tmpRoot, fixturesDir, outputsDir]) {
      mkdirSync(dir, { recursive: true });
    }
    clearDialogControl();
  },

  // Each spec file gets a fresh app session; just wait for it to finish booting.
  beforeTest: async () => {
    await waitForAppReady();
  },
};
