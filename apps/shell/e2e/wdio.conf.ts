/**
 * WebdriverIO config for the real-app dialog canary.
 *
 * It drives the packaged RaioPDF shell binary (built with the `e2e-webdriver`
 * Cargo feature) through `tauri-driver`, which proxies to `msedgedriver` matched
 * to the runner's WebView2 — no in-app plugin is needed on Windows. The specs
 * exercise the real Tauri IPC and real Rust command bodies; only the native OS
 * pickers are swapped for canned paths via the `e2e_dialog` control file.
 *
 * Env seams (all set here, before the app launches, and inherited by
 * tauri-driver → app):
 *   RAIOPDF_ENGINE_PAYLOAD_DIR  → the assembled payload (qpdf/Ghostscript)
 *   RAIO_E2E_DIALOG_CONTROL     → the dialog stub's control file
 *
 * Overridable knobs:
 *   RAIO_E2E_APP           → path to the shell exe (default target/release)
 *   RAIO_E2E_TAURI_DRIVER  → tauri-driver binary (default `tauri-driver` on PATH)
 *   RAIO_E2E_MSEDGEDRIVER  → msedgedriver.exe (default: download via `edgedriver`)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import net from "node:net";
import { appPath, controlFile, fixturesDir, outputsDir, payloadDir, tmpRoot } from "./support/paths";
import { clearDialogControl } from "./support/dialogControl";
import { resetApp } from "./support/app";

// Point the shell at the assembled payload and the dialog control file. Set
// before tauri-driver spawns so the launched app inherits them.
process.env.RAIOPDF_ENGINE_PAYLOAD_DIR ??= payloadDir;
process.env.RAIO_E2E_DIALOG_CONTROL = controlFile;

const TAURI_DRIVER_PORT = 4444;
let tauriDriver: ChildProcess | undefined;

async function resolveMsedgedriver(): Promise<string> {
  if (process.env.RAIO_E2E_MSEDGEDRIVER) {
    return process.env.RAIO_E2E_MSEDGEDRIVER;
  }
  // `edgedriver` detects the installed Edge/WebView2 version and downloads the
  // matching driver, returning its path. Falls back to a PATH lookup.
  try {
    const { download } = (await import("edgedriver")) as {
      download: (version?: string) => Promise<string>;
    };
    return await download();
  } catch (error) {
    console.warn(
      `edgedriver auto-download failed (${error instanceof Error ? error.message : error}); ` +
        "falling back to `msedgedriver` on PATH.",
    );
    return "msedgedriver";
  }
}

function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline) {
          reject(new Error(`tauri-driver did not open port ${port} in time`));
        } else {
          setTimeout(attempt, 250);
        }
      });
    };
    attempt();
  });
}

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./specs/**/*.e2e.ts"],
  maxInstances: 1,
  // tauri-driver speaks the classic WebDriver protocol on 127.0.0.1:4444.
  hostname: "127.0.0.1",
  port: TAURI_DRIVER_PORT,
  path: "/",
  capabilities: [
    {
      // `wry` is the Tauri webview automation target tauri-driver expects.
      browserName: "wry",
      "tauri:options": { application: appPath },
    } as WebdriverIO.Capabilities,
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

  onPrepare: async () => {
    if (!existsSync(appPath)) {
      throw new Error(
        `Shell binary not found at ${appPath}.\n` +
          "Build it first: `pnpm build:shell:e2e:windows-x64` " +
          "(or set RAIO_E2E_APP).",
      );
    }
    for (const dir of [tmpRoot, fixturesDir, outputsDir]) {
      mkdirSync(dir, { recursive: true });
    }
    clearDialogControl();

    const driverBin = process.env.RAIO_E2E_TAURI_DRIVER ?? "tauri-driver";
    const nativeDriver = await resolveMsedgedriver();
    tauriDriver = spawn(
      driverBin,
      ["--port", String(TAURI_DRIVER_PORT), "--native-driver", nativeDriver],
      { stdio: [null, process.stdout, process.stderr], env: process.env },
    );
    tauriDriver.on("error", (error) => {
      throw new Error(`Failed to launch tauri-driver (${driverBin}): ${error.message}`);
    });
    await waitForPort(TAURI_DRIVER_PORT, 30_000);
  },

  // Reload the webview to a clean React state before every test (the app process
  // and its fixed dialog-control env persist across the session).
  beforeTest: async () => {
    await resetApp();
  },

  onComplete: () => {
    tauriDriver?.kill();
  },
};
