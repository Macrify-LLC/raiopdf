import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENGINE_HOST_BIN_ENV } from "../src/engine.js";
import { diagnosticsInputSchema, handleDiagnostics } from "../src/tools/diagnostics.js";

let tempDir: string;
const originalBin = process.env[ENGINE_HOST_BIN_ENV];

/**
 * Stand in for `raiopdf-engine-host --diagnostics`.
 *
 * The point here is the connector's own contract — argument passing, parsing, and
 * what it does when the host misbehaves. The real binary is covered by the Rust
 * side (crates/diagnostics-core) and by the canary's tool listing.
 */
async function writeFakeHost(body: string): Promise<string> {
  const script = path.join(tempDir, "fake-engine-host.mjs");
  await fs.writeFile(script, body, "utf8");
  const shim = path.join(tempDir, "fake-engine-host");
  await fs.writeFile(shim, `#!/bin/sh\nexec node "${script}" "$@"\n`, "utf8");
  await fs.chmod(shim, 0o755);
  return shim;
}

const VALID_PAYLOAD = {
  appVersion: "0.1.5",
  os: "macos",
  arch: "aarch64",
  reference: "d-1a2b3c4d",
  sanitized: true,
  residualRiskNote: "best-effort",
  telemetryNote: "RaioPDF collects no telemetry.",
  logs: [
    { name: "app.log", present: true, tail: "unix:1 ui ocr.failed id=d-1a2b3c4d opening [path]\n" },
    { name: "engine.log", present: false, tail: "" },
  ],
};

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "raiopdf-mcp-diagnostics-"));
});

afterEach(async () => {
  if (originalBin === undefined) {
    delete process.env[ENGINE_HOST_BIN_ENV];
  } else {
    process.env[ENGINE_HOST_BIN_ENV] = originalBin;
  }
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("raiopdf_diagnostics", () => {
  it("takes no path parameter", () => {
    // Load-bearing: accepting a caller-supplied path would turn a diagnostics
    // reader into an arbitrary-file reader. The only readable location is
    // RaioPDF's own app-data directory, resolved inside the host.
    expect(Object.keys(diagnosticsInputSchema)).toEqual(["reference"]);
  });

  it("rejects a reference that isn't a plain token", () => {
    const { reference } = diagnosticsInputSchema;

    expect(reference.safeParse("d-1a2b3c4d").success).toBe(true);
    expect(reference.safeParse("../../etc/passwd").success).toBe(false);
    expect(reference.safeParse("d-1 --reference other").success).toBe(false);
    expect(reference.safeParse("d-1\nid=forged").success).toBe(false);
  });

  it("returns the scrubbed payload and summarizes which logs were present", async () => {
    process.env[ENGINE_HOST_BIN_ENV] = await writeFakeHost(
      `process.stdout.write(JSON.stringify(${JSON.stringify(VALID_PAYLOAD)}));`,
    );

    const result = await handleDiagnostics("d-1a2b3c4d");

    expect(result.structuredContent).toMatchObject({ ok: true, sanitized: true, appVersion: "0.1.5" });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("app.log") });
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("scrubbed") });
  });

  it("forwards the reference to the host", async () => {
    process.env[ENGINE_HOST_BIN_ENV] = await writeFakeHost(
      `process.stdout.write(JSON.stringify({...${JSON.stringify(VALID_PAYLOAD)}, telemetryNote: process.argv.slice(2).join(" ")}));`,
    );

    const result = await handleDiagnostics("d-1a2b3c4d");

    expect(result.structuredContent).toMatchObject({
      telemetryNote: "--diagnostics --reference d-1a2b3c4d",
    });
  });

  it("omits the reference flag when none was given", async () => {
    process.env[ENGINE_HOST_BIN_ENV] = await writeFakeHost(
      `process.stdout.write(JSON.stringify({...${JSON.stringify(VALID_PAYLOAD)}, telemetryNote: process.argv.slice(2).join(" ")}));`,
    );

    const result = await handleDiagnostics();

    expect(result.structuredContent).toMatchObject({ telemetryNote: "--diagnostics" });
  });

  it("reports a readable error when the host cannot run", async () => {
    process.env[ENGINE_HOST_BIN_ENV] = path.join(tempDir, "does-not-exist");

    const result = await handleDiagnostics();

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false });
  });

  it("reports a readable error when the host emits unparseable output", async () => {
    process.env[ENGINE_HOST_BIN_ENV] = await writeFakeHost(`process.stdout.write("not json");`);

    const result = await handleDiagnostics();

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("unreadable") });
  });

  it("never puts a filesystem path in the error surface", async () => {
    // Node builds execFile's error message as
    // "Command failed: <resolved path> <args>\n<stderr>". Returning that leaked the
    // install path — which on Windows sits under the user's own name — plus raw
    // stderr, the one channel the scrubber never sees.
    const hostPath = path.join(tempDir, "Jane Doe", "raiopdf-engine-host");
    process.env[ENGINE_HOST_BIN_ENV] = hostPath;

    const result = await handleDiagnostics();
    const surfaced = JSON.stringify(result);

    expect(result.isError).toBe(true);
    expect(surfaced).not.toContain("Jane Doe");
    expect(surfaced).not.toContain(tempDir);
  });

  it("does not leak stderr from a host that failed", async () => {
    process.env[ENGINE_HOST_BIN_ENV] = await writeFakeHost(
      `process.stderr.write("panicked reading /Users/Jane Doe/Smith v Acme/complaint.pdf");\nprocess.exit(3);`,
    );

    const result = await handleDiagnostics();
    const surfaced = JSON.stringify(result);

    expect(result.isError).toBe(true);
    expect(surfaced).not.toContain("Smith v Acme");
    expect(surfaced).not.toContain("complaint.pdf");
  });

  it("uses a payload the host printed even if it then exited non-zero", async () => {
    // Discarding a usable answer and reporting a bare failure is strictly worse.
    process.env[ENGINE_HOST_BIN_ENV] = await writeFakeHost(
      `process.stdout.write(JSON.stringify(${JSON.stringify(VALID_PAYLOAD)}));\nprocess.exit(3);`,
    );

    const result = await handleDiagnostics();

    expect(result.structuredContent).toMatchObject({ ok: true, sanitized: true });
  });

  it("rejects a payload missing its provenance fields", async () => {
    // A payload without `sanitized` / the risk note would let a reader treat raw
    // text as filtered, so an unexpected shape is refused rather than passed on.
    process.env[ENGINE_HOST_BIN_ENV] = await writeFakeHost(
      `process.stdout.write(JSON.stringify({ appVersion: "0.1.5", logs: [] }));`,
    );

    const result = await handleDiagnostics();

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("unexpected shape") });
  });
});
