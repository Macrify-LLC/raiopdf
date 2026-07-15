#!/usr/bin/env node
// Boots the REAL RaioPDF engine-host against the assembled desktop payload and
// hands back the live proxy port + auth token.
//
// This is the single source of truth for "spin up the exact engine the packaged
// app runs" outside of the Tauri shell. It launches `raiopdf-engine-host`, which
// starts the Rust auth-proxy in front of the bundled Stirling JAR and the offline
// OCR toolchain (OCRmyPDF/Tesseract/Ghostscript) — identical to what the Tauri
// `engine_start` command wraps. Used by:
//   - the Playwright real-engine canary (global-setup boots it, drives the real
//     UI against it),
//   - the release workflow's canary gate,
//   - a human/agent who wants to poke the real engine directly (run this file
//     standalone; it prints the port/token and stays alive until Ctrl-C).
//
// Fidelity note: unlike the release "raw Stirling + curl" OCR smoke, this boots
// the auth-proxy path, so the X-RaioPDF-Auth token check and the CORS handling
// (localhost / tauri.localhost origins only) are exercised for real — that is the
// exact layer the "sidecar fetch illegal invocation" class of packaged-build bug
// lives in.

import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm, access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { getHostPlatformId, platformPath } from "../installer/platforms.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const IS_WINDOWS = process.platform === "win32";

const DEFAULT_PAYLOAD_DIR = platformPath(REPO_ROOT, getHostPlatformId(), "payloadOutputDir");
const ENGINE_HOST_BIN = path.join(
  REPO_ROOT,
  "target",
  "release",
  IS_WINDOWS ? "raiopdf-engine-host.exe" : "raiopdf-engine-host",
);

const READY_TIMEOUT_MS = 180_000;

async function fileExists(target) {
  try {
    await access(target, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function commandPath(command) {
  const result = spawnSync("sh", ["-c", `command -v ${command}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() || null : null;
}

function localDevToolchainEnv() {
  if (IS_WINDOWS) {
    return {};
  }

  return {
    RAIOPDF_ENGINE_JAVA: process.env.RAIOPDF_ENGINE_JAVA?.trim() || "java",
    ...envFileOverride("RAIOPDF_ENGINE_QPDF", "qpdf"),
    ...envFileOverride("RAIOPDF_ENGINE_GHOSTSCRIPT", "gs"),
    ...envFileOverride("RAIOPDF_ENGINE_OCRMYPDF", "ocrmypdf"),
  };
}

function envFileOverride(key, command) {
  if (process.env[key]?.trim()) {
    return {};
  }
  const found = commandPath(command);
  return found ? { [key]: found } : {};
}

/**
 * @typedef {object} EngineHandle
 * @property {number} port   Live auth-proxy port.
 * @property {string} token  X-RaioPDF-Auth token the proxy expects.
 * @property {string} baseUrl `http://127.0.0.1:<port>`.
 * @property {() => Promise<void>} stop Gracefully shut the engine down and clean up.
 */

/**
 * Boot the payload engine-host and resolve once the proxy reports ready.
 *
 * @param {{ payloadDir?: string, hostBin?: string, readyTimeoutMs?: number }} [options]
 * @returns {Promise<EngineHandle>}
 */
export async function bootPayloadEngine(options = {}) {
  const payloadDir = options.payloadDir
    ?? process.env.RAIOPDF_ENGINE_PAYLOAD_DIR
    ?? DEFAULT_PAYLOAD_DIR;
  const hostBin = options.hostBin ?? ENGINE_HOST_BIN;

  if (!(await fileExists(hostBin))) {
    throw new Error(
      `engine-host binary not found at ${hostBin}\n` +
        `Build it first: pnpm build:external-bins (or pnpm prepare:shell-bundle).`,
    );
  }

  const jarPath = path.join(payloadDir, "engine", "stirling.jar");
  if (!(await fileExists(jarPath))) {
    throw new Error(
      `Desktop payload not assembled at ${payloadDir} (missing engine/stirling.jar)\n` +
        `Assemble it first: pnpm prepare:shell-bundle.`,
    );
  }

  const appDataDir = await mkdtemp(path.join(tmpdir(), "raiopdf-canary-"));

  const child = spawn(hostBin, [], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      RAIOPDF_ENGINE_PAYLOAD_DIR: payloadDir,
      ...localDevToolchainEnv(),
      RAIOPDF_APP_DATA_DIR: appDataDir,
    },
  });

  let stderrTail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-4000);
  });

  const stop = createStopper(child, appDataDir);

  try {
    const ready = await waitForReadyLine(child, options.readyTimeoutMs ?? READY_TIMEOUT_MS, () => stderrTail);
    return {
      port: ready.port,
      token: ready.token,
      baseUrl: `http://127.0.0.1:${ready.port}`,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

function waitForReadyLine(child, timeoutMs, getStderr) {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: child.stdout });
    let settled = false;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      fn(arg);
    };

    const timer = setTimeout(() => {
      finish(reject, new Error(
        `engine-host did not report ready within ${timeoutMs}ms.\n--- stderr ---\n${getStderr()}`,
      ));
    }, timeoutMs);

    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) return;
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed.port === "number" && typeof parsed.token === "string") {
          finish(resolve, { port: parsed.port, token: parsed.token });
        } else if (parsed.error) {
          finish(reject, new Error(`engine-host reported an error: ${parsed.error}`));
        }
      } catch {
        // Non-JSON stdout noise before the ready line — ignore.
      }
    });

    child.on("exit", (code) => {
      finish(reject, new Error(
        `engine-host exited (code ${code}) before reporting ready.\n--- stderr ---\n${getStderr()}`,
      ));
    });
    child.on("error", (error) => finish(reject, error));
  });
}

function createStopper(child, appDataDir) {
  let stopped = false;
  return async function stop() {
    if (stopped) return;
    stopped = true;

    if (child.exitCode === null && child.signalCode === null) {
      // engine-host shuts down cleanly when its stdin closes; that lets it tear
      // down the Stirling child instead of orphaning the JVM.
      try {
        child.stdin.end();
      } catch {
        // stdin already gone — fall through to kill.
      }

      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);

      if (child.exitCode === null && child.signalCode === null) {
        forceKillTree(child);
      }
    }

    await rm(appDataDir, { recursive: true, force: true }).catch(() => {});
  };
}

function forceKillTree(child) {
  if (IS_WINDOWS && child.pid) {
    // Kill the JVM grandchild too — a bare child.kill() leaves it running.
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    child.kill("SIGKILL");
  }
}

// --- Standalone mode: boot, print the endpoint, stay alive until Ctrl-C. -------
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const handle = await bootPayloadEngine();
  process.stdout.write(
    `\nRaioPDF engine ready.\n  base URL : ${handle.baseUrl}\n  token    : ${handle.token}\n` +
      `  health   : ${handle.baseUrl}/api/v1/info/status\n\nPress Ctrl-C to stop.\n`,
  );

  const shutdown = async () => {
    process.stdout.write("\nStopping engine…\n");
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
