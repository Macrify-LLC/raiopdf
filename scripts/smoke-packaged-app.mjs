#!/usr/bin/env node
// Smoke the PACKAGED app the way a user actually runs it.
//
// Why this exists, separately from `pnpm canary`: the canary boots the engine
// through `scripts/boot-payload-engine.mjs`, which exports RAIOPDF_ENGINE_PAYLOAD_DIR
// and friends, and drives a `vite preview` in a shell that already has a normal
// environment. The packaged app has none of that — it resolves its own payload
// from inside the bundle and spawns its tools with a curated environment. Every
// failure that shipped in the first macOS build lived in exactly that gap and was
// invisible to a fully green canary:
//
//   * payload discovery: a .app keeps executables in Contents/MacOS and resources
//     in Contents/Resources, so the payload is not a sibling of the executable and
//     `discover(None)` found nothing — the toolchain came up empty and OCR failed.
//   * ghostscript resolution: it read only RAIOPDF_ENGINE_* variables, which only
//     the canary's own boot script sets, so /local/pdfa answered 422 in the bundle.
//
// So: boot the bundle's own engine-host with the RAIOPDF_ENGINE_* variables
// stripped, and drive the loopback handlers. No env hints, no dev tree, no mocks —
// if this passes, the packaged binaries can find their own payload and use it.
//
// Usage: node scripts/smoke-packaged-app.mjs [path/to/RaioPDF.app]
//   (defaults to target/release/bundle/macos/RaioPDF.app)

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appPath = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(repoRoot, "target/release/bundle/macos/RaioPDF.app");
const fixture = path.join(repoRoot, "apps/mcp/eval/fixtures/five-pages.pdf");
const BOOT_TIMEOUT_MS = 90_000;
const CALL_TIMEOUT_MS = 240_000;

function fail(message) {
  console.error(`FAIL  ${message}`);
  process.exitCode = 1;
}

function ok(message) {
  console.log(`ok    ${message}`);
}

/** Where the engine-host's stderr is teed so CI can upload it on failure. */
function stderrLogPath() {
  if (process.env.RAIOPDF_SMOKE_STDERR_LOG) {
    return path.resolve(process.env.RAIOPDF_SMOKE_STDERR_LOG);
  }
  const dir = process.env.RAIOPDF_APP_DATA_DIR
    ? path.resolve(process.env.RAIOPDF_APP_DATA_DIR)
    : os.tmpdir();
  return path.join(dir, "engine-host.stderr.log");
}

/**
 * Drain the child's stderr into a file and keep a tail for failure messages.
 * The child's stderr was previously piped but never read: a chatty host would
 * fill the pipe buffer and deadlock before it ever announced a port, and there
 * was nothing to upload when a boot failed. Attach this the instant the child is
 * spawned, before waiting on the announcement.
 */
function teeStderr(child) {
  const logPath = stderrLogPath();
  mkdirSync(path.dirname(logPath), { recursive: true });
  const stream = createWriteStream(logPath);
  let tail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stream.write(chunk);
    tail = (tail + chunk).slice(-4000);
  });
  return {
    logPath,
    tail: () => tail,
    close: () => new Promise((resolve) => stream.end(resolve)),
  };
}

/** The PATH a Finder-launched app inherits from launchd — not a developer shell's. */
const LAUNCHD_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/**
 * The bundle's own engine-host, run in the environment a double-clicked app gets.
 *
 * Stripping RAIOPDF_ENGINE_* is not enough on its own. The OCR runner prepends the
 * payload's bin dirs and then *appends the inherited PATH* as a fallback
 * (`crates/engine-sidecar-core/src/path_ops.rs`), so a developer shell with Homebrew's
 * gs/tesseract on PATH would let a bundle that is missing its own copies still pass —
 * the precise false pass this harness exists to prevent, and the same Homebrew fallback
 * that made the canary's OCR result meaningless. Replace PATH with launchd's, and drop
 * the toolchain hints a shell might be carrying, so the only way to pass is with the
 * tools actually inside the bundle.
 */
function spawnEngineHost() {
  const bin = path.join(appPath, "Contents/MacOS/raiopdf-engine-host");
  if (!existsSync(bin)) {
    throw new Error(`no engine-host in the bundle: ${bin}`);
  }
  const stripped = new Set(["TESSDATA_PREFIX", "PYTHONHOME", "PYTHONPATH", "GS_LIB"]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith("RAIOPDF_ENGINE_") && !stripped.has(key),
    ),
  );
  env.PATH = LAUNCHD_PATH;
  // TMPDIR is deliberately left alone: launchd gives a real app one, so removing it
  // would test a situation the product never sees.
  // stdin stays piped: the host treats EOF as a shutdown signal.
  return spawn(bin, [], { env, stdio: ["pipe", "pipe", "pipe"] });
}

/** Resolve the {port, token} the host announces on stdout, or reject. */
function announcement(child) {
  return new Promise((resolve, reject) => {
    let buffered = "";
    const timer = setTimeout(
      () => reject(new Error(`engine-host never announced a port within ${BOOT_TIMEOUT_MS}ms`)),
      BOOT_TIMEOUT_MS,
    );
    const settle = (error, value) => {
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    child.stdout.on("data", (chunk) => {
      buffered += chunk;
      const line = buffered.split("\n").find((candidate) => candidate.trim().startsWith("{"));
      if (!line) return;
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        return; // a partial line; wait for the rest
      }
      if (parsed.error) {
        // The exact shape of the shipped bug: "payload is disabled or missing".
        settle(new Error(`engine-host refused to boot: ${parsed.error}`));
      } else if (parsed.port && parsed.token) {
        settle(null, parsed);
      }
    });
    child.on("exit", (code) => settle(new Error(`engine-host exited early (code ${code})`)));
  });
}

async function post(endpoint, { port, token }, body, headers = {}) {
  const response = await fetch(`http://localhost:${port}${endpoint}`, {
    method: "POST",
    headers: {
      "X-RaioPDF-Auth": token,
      // The auth proxy CORS-allowlists localhost only; 127.0.0.1 fails preflight.
      Origin: "http://localhost:4180",
      "Content-Type": "application/pdf",
      ...headers,
    },
    body,
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  return { status: response.status, bytes: Buffer.from(await response.arrayBuffer()) };
}

async function main() {
  if (process.platform !== "darwin") {
    console.log("skip  packaged-app smoke targets the macOS bundle");
    return;
  }
  if (!existsSync(appPath)) {
    throw new Error(`no bundle at ${appPath} — run: pnpm build:shell:macos-arm64`);
  }
  const pdf = readFileSync(fixture);
  const child = spawnEngineHost();
  const stderr = teeStderr(child);
  console.log(`engine-host stderr → ${stderr.logPath}`);
  try {
    // Boots at all ⇒ it located its payload inside Contents/Resources.
    const engine = await announcement(child).catch((error) => {
      // Surface the host's own diagnostics inline — a boot failure is exactly
      // the case where the stderr tee earns its keep.
      throw new Error(`${error.message}\n--- engine-host stderr (tail) ---\n${stderr.tail()}`);
    });
    ok(`engine-host booted from the bundle and found its payload (port ${engine.port})`);

    const status = await fetch(`http://localhost:${engine.port}/api/v1/info/status`, {
      headers: { "X-RaioPDF-Auth": engine.token, Origin: "http://localhost:4180" },
      signal: AbortSignal.timeout(30_000),
    });
    status.ok ? ok("bundled engine reports healthy") : fail(`engine status HTTP ${status.status}`);

    const ocr = await post("/local/ocr", engine, pdf);
    if (ocr.status === 200 && ocr.bytes.subarray(0, 4).toString() === "%PDF") {
      ok(`/local/ocr returned a PDF (${ocr.bytes.length} bytes)`);
    } else {
      fail(`/local/ocr HTTP ${ocr.status}: ${ocr.bytes.subarray(0, 120)}`);
    }

    const pdfa = await post("/local/pdfa", engine, pdf, { "X-RaioPDF-PdfA-Level": "2" });
    const marked = /pdfaid|OutputIntent/.test(pdfa.bytes.toString("latin1"));
    if (pdfa.status === 200 && marked) {
      ok(`/local/pdfa returned a real PDF/A (${pdfa.bytes.length} bytes)`);
    } else {
      fail(`/local/pdfa HTTP ${pdfa.status}${marked ? "" : " (no PDF/A markers)"}: ${pdfa.bytes.subarray(0, 120)}`);
    }
  } finally {
    child.stdin.end();
    child.kill();
    await stderr.close();
  }
}

main().catch((error) => {
  fail(error.message);
  process.exit(1);
});
