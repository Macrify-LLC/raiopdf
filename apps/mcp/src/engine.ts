import { spawn, type ChildProcessByStdio } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { PdfEngine } from "@raiopdf/engine-api";
import { createLocalPdfEngine } from "@raiopdf/engine-local";
import { SidecarPdfEngine } from "@raiopdf/engine-sidecar";
import { z } from "zod";

export const ENGINE_HOST_BIN_ENV = "RAIOPDF_ENGINE_HOST_BIN";

const ENGINE_HOST_READY_TIMEOUT_MS = 30_000;
const ENGINE_HOST_SHUTDOWN_TIMEOUT_MS = 2_000;

const readyLineSchema = z.object({
  port: z.number().int().min(1).max(65_535),
  token: z.string().regex(/^[a-f0-9]+$/i),
});

type EngineHostReadyLine = z.infer<typeof readyLineSchema>;
type EngineHostProcess = ChildProcessByStdio<Writable, Readable, null>;

type StartedEngine = {
  authToken: string;
  baseUrl: string;
  child: EngineHostProcess;
  engine: SidecarPdfEngine;
};

export type EngineHealth = {
  ok: boolean;
  version?: string;
};

export class EngineHandle {
  private startPromise: Promise<StartedEngine> | null = null;

  async getEngine(): Promise<SidecarPdfEngine> {
    return (await this.start()).engine;
  }

  async healthProbe(): Promise<EngineHealth> {
    const started = await this.start();
    const info = await SidecarPdfEngine.probe(
      started.baseUrl,
      globalThis.fetch,
      started.authToken,
    );

    if (!info) {
      return { ok: false };
    }

    return {
      ok: true,
      ...(info.version ? { version: info.version } : {}),
    };
  }

  async dispose(): Promise<void> {
    const started = await this.startPromise?.catch(() => null);
    this.startPromise = null;

    if (started) {
      await stopEngineHost(started.child);
    }
  }

  private start(): Promise<StartedEngine> {
    if (this.startPromise === null) {
      const pending = startEngineHost();
      this.startPromise = pending;
      // Never cache a dead handle: drop the cache if the start rejects, or once
      // the engine-host child exits (crash, or a future idle shutdown), so the
      // next tool call spawns a fresh host instead of reusing a broken one.
      pending.then(
        (started) => {
          started.child.once("exit", () => {
            if (this.startPromise === pending) {
              this.startPromise = null;
            }
          });
        },
        () => {
          if (this.startPromise === pending) {
            this.startPromise = null;
          }
        },
      );
    }
    return this.startPromise;
  }
}

export const defaultEngineHandle = new EngineHandle();

export function getEngine(): Promise<SidecarPdfEngine> {
  return defaultEngineHandle.getEngine();
}

export async function healthProbe(): Promise<EngineHealth> {
  return await defaultEngineHandle.healthProbe();
}

export async function disposeEngine(): Promise<void> {
  await defaultEngineHandle.dispose();
}

let localEngine: PdfEngine | undefined;

/**
 * The in-process pdf-lib engine for pure-local operations (binder assembly,
 * Bates numbering, page numbers, split, extract). Runs entirely in Node with no
 * engine-host / Stirling sidecar — so these tools work even when the engine
 * payload is unavailable.
 */
export function getLocalEngine(): PdfEngine {
  localEngine ??= createLocalPdfEngine();
  return localEngine;
}

async function startEngineHost(): Promise<StartedEngine> {
  const child = spawn(resolveEngineHostBinary(), [], {
    stdio: ["pipe", "pipe", "inherit"],
    // The MCP owns this engine's lifecycle (disposed on server shutdown), so
    // disable the engine-host's idle self-shutdown — otherwise the proxy could
    // vanish mid-session while a cached handle still points at it.
    env: { ...process.env, RAIOPDF_ENGINE_IDLE_SHUTDOWN_MINUTES: "0" },
  });

  try {
    const ready = await readReadyLine(child);
    const baseUrl = `http://127.0.0.1:${ready.port}`;

    return {
      authToken: ready.token,
      baseUrl,
      child,
      engine: new SidecarPdfEngine({
        authToken: ready.token,
        baseUrl,
      }),
    };
  } catch (error) {
    await stopEngineHost(child);
    throw error;
  }
}

function resolveEngineHostBinary(): string {
  const envPath = process.env[ENGINE_HOST_BIN_ENV];

  if (envPath) {
    return envPath;
  }

  for (const candidate of engineHostCandidates()) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching candidates.
    }
  }

  return executableName();
}

function engineHostCandidates(): string[] {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(moduleDirectory, "..", "..", "..");

  return [
    path.join(repoRoot, "target", "debug", executableName()),
    path.join(repoRoot, "target", "release", executableName()),
    path.resolve(moduleDirectory, "..", "bin", executableName()),
    path.resolve(moduleDirectory, executableName()),
  ];
}

function executableName(): string {
  return process.platform === "win32" ? "raiopdf-engine-host.exe" : "raiopdf-engine-host";
}

async function readReadyLine(child: EngineHostProcess): Promise<EngineHostReadyLine> {
  let output = "";

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for raiopdf-engine-host startup JSON."));
    }, ENGINE_HOST_READY_TIMEOUT_MS);

    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      reject(new Error(`raiopdf-engine-host exited before startup JSON: ${code ?? signal}`));
    };

    const onData = (chunk: Buffer): void => {
      output += chunk.toString("utf8");
      const newlineIndex = output.indexOf("\n");

      if (newlineIndex === -1) {
        return;
      }

      const line = output.slice(0, newlineIndex).trim();
      cleanup();
      child.stdout.resume();

      try {
        resolve(readyLineSchema.parse(JSON.parse(line)));
      } catch (error) {
        reject(new Error("raiopdf-engine-host printed invalid startup JSON.", { cause: error }));
      }
    };

    function cleanup(): void {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stdout.off("data", onData);
    }

    child.once("error", onError);
    child.once("exit", onExit);
    child.stdout.on("data", onData);
  });
}

async function stopEngineHost(child: EngineHostProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  child.stdin.end();

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve();
    }, ENGINE_HOST_SHUTDOWN_TIMEOUT_MS);

    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
