// RaioPDF MCP end-to-end canary.
//
// The MCP sibling of the UI real-engine canary (docs/RELEASE-CANARY.md). It drives
// the *real, built* `raiopdf-mcp` connector exactly as an AI client does — as a
// child process over stdio (JSON-RPC), with the "Open Raio to AI" gate flipped on —
// and asserts each tool's OUTPUT against a known-correct answer for a known input.
// It is the layer that catches "the connector's tool contract silently drifted or
// broke" before a build ships; the mocked unit suite in `test/*.test.ts` can't see
// the stdio protocol, the access gate, or the connector booting its own real engine.
//
// Fidelity: the connector spawns its OWN engine host (as it does for a real user).
// The harness only points RAIOPDF_ENGINE_HOST_BIN / _PAYLOAD_DIR at the assembled
// payload so it runs from any checkout (incl. a worktree). It defaults those to the
// repo's own release artifacts and honors an env override.
//
// This file is `*.canary.ts`, so the default vitest include ("*.test.ts") skips it
// in CI. Run it deliberately: `pnpm --filter @raiopdf/mcp test:canary` (or the root
// `pnpm canary`, which runs the UI and MCP canaries together).

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENABLE_FLAG_RELATIVE_PATH } from "../src/gate.js";

// apps/mcp/test/ -> repo root
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const isWindows = process.platform === "win32";
const engineHostName = isWindows ? "raiopdf-engine-host.exe" : "raiopdf-engine-host";

const fixturesDir = path.join(repoRoot, "apps", "mcp", "eval", "fixtures");
const engineHostBin =
  process.env.RAIOPDF_ENGINE_HOST_BIN ??
  path.join(repoRoot, "target", "release", engineHostName);
const payloadDir =
  process.env.RAIOPDF_ENGINE_PAYLOAD_DIR ??
  path.join(repoRoot, "apps", "shell", "src-tauri", "payload");

// The connector we drive is the exact artifact that ships: the esbuild-bundled
// runtime under the assembled payload (produced by `installer/build-mcp-runtime.mjs`
// / `pnpm prepare:shell-bundle`), launched with the payload's bundled Node. This is
// what the `raiopdf-mcp` launcher runs — NOT the raw tsc `apps/mcp/dist/index.js`,
// which relies on extensionless workspace imports esbuild resolves at bundle time.
const bundledConnector = path.join(payloadDir, "mcp", "app", "index.mjs");
const bundledNode = path.join(payloadDir, "mcp", "node", isWindows ? "node.exe" : "node");
const nodeBin = existsSync(bundledNode) ? bundledNode : process.execPath;

// process.env is Record<string, string | undefined>; the SDK transport's env wants
// Record<string, string>. Drop undefined values once, at module scope.
const ENV_BASE: Record<string, string> = Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
);

// The tools the connector advertises. Canonical count lives in docs/MCP.md; this set
// is the drift guard for it (and for the README / landing-page counts). Adding a tool
// means updating this list AND docs/MCP.md together.
const EXPECTED_TOOLS = [
  "raiopdf_health",
  "pdf_page_count",
  "ocr_pdf",
  "merge_pdfs",
  "rotate_pages",
  "compress_pdf",
  "remove_encryption",
  "sanitize_pdf",
  "scrub_metadata",
  "build_exhibit_binder",
  "bates_stamp",
  "bates_stamp_folder",
  "build_production_set",
  "batch_cleanup",
  "page_numbers",
  "split_pdf",
  "extract_pages",
  "redact_terms",
  "prepare_for_filing",
  "build_filing_packet",
  // Annotation tools (#125) — pdf.js-backed, so they exercise the worker fix too.
  "locate_text",
  "highlight_text",
  "underline_text",
  "strikethrough_text",
  "add_comment",
].sort();

const fixture = (name: string): string => path.join(fixturesDir, name);

function writeEnableFlag(configDir: string): void {
  const flag = path.join(configDir, ENABLE_FLAG_RELATIVE_PATH);
  mkdirSync(path.dirname(flag), { recursive: true });
  writeFileSync(flag, "enabled\n");
}

/**
 * Spawn the built connector as a child over stdio and connect an MCP client.
 * `configDir` is the connector's config root (its gate flag lives under it), so
 * each spawn gets an isolated enabled/disabled state. Closing the returned client
 * closes the transport, which triggers the connector's shutdown (disposing its
 * engine host / JVM instead of orphaning it).
 */
async function connect(configDir: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: nodeBin,
    args: [bundledConnector],
    cwd: repoRoot,
    stderr: "inherit",
    env: {
      ...ENV_BASE,
      // Pin XDG_CONFIG_HOME so the flag we wrote is the one the gate reads (isolated
      // from the real user config). See gate.ts for the full resolution order.
      XDG_CONFIG_HOME: configDir,
      RAIOPDF_ENGINE_HOST_BIN: engineHostBin,
      RAIOPDF_ENGINE_PAYLOAD_DIR: payloadDir,
      // The connector owns its engine's lifecycle; never let it self-shutdown mid-run.
      RAIOPDF_ENGINE_IDLE_SHUTDOWN_MINUTES: "0",
    },
  });

  const client = new Client({ name: "raiopdf-mcp-canary", version: "0.1.0" });
  await client.connect(transport);
  return client;
}

/** Call a tool and return its structured output. Generous timeout: the first
 *  engine-backed call boots the real engine host (JVM + Stirling). */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
  timeoutMs = 180_000,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args }, undefined, {
    timeout: timeoutMs,
  });
  return (result.structuredContent ?? {}) as Record<string, unknown>;
}

async function pageCountOf(file: string): Promise<number> {
  const doc = await PDFDocument.load(await readFile(file));
  return doc.getPageCount();
}

// One writable directory for tool outputs. Every test uses a distinct base name and
// the connector never overwrites, so the fresh mkdtemp dir keeps outputs collision-free.
let workDir: string;
const out = (name: string): string => path.join(workDir, name);

let enabledConfigDir: string;
let enabled: Client;

const missing: string[] = [];
if (!existsSync(bundledConnector)) missing.push(`bundled connector (${bundledConnector}) — run \`pnpm prepare:shell-bundle\``);
if (!existsSync(engineHostBin)) missing.push(`engine-host (${engineHostBin}) — run \`pnpm prepare:shell-bundle\` or set RAIOPDF_ENGINE_HOST_BIN`);
if (!existsSync(path.join(payloadDir, "engine", "stirling.jar"))) missing.push(`payload (${payloadDir}) — run \`pnpm prepare:shell-bundle\` or set RAIOPDF_ENGINE_PAYLOAD_DIR`);

describe("MCP end-to-end canary (real connector + real engine)", () => {
  beforeAll(async () => {
    if (missing.length > 0) {
      throw new Error(`MCP canary prerequisites missing:\n  - ${missing.join("\n  - ")}`);
    }
    workDir = mkdtempSync(path.join(tmpdir(), "raiopdf-mcp-canary-"));
    enabledConfigDir = mkdtempSync(path.join(tmpdir(), "raiopdf-mcp-cfg-on-"));
    writeEnableFlag(enabledConfigDir);
    enabled = await connect(enabledConfigDir);
  }, 60_000);

  afterAll(async () => {
    await enabled?.close().catch(() => undefined);
    for (const dir of [workDir, enabledConfigDir]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gate is a real access wall: every tool refuses when 'Open Raio to AI' is off", async () => {
    const offDir = mkdtempSync(path.join(tmpdir(), "raiopdf-mcp-cfg-off-"));
    const off = await connect(offDir); // no enable flag written
    try {
      // Discovery is not gated (the tool-surface test owns the exact-list check); here
      // we only prove that *calling* a tool is refused while the gate is off. Valid args
      // per tool so the call reaches the gate — the SDK rejects malformed input before
      // the handler, which would mask it. Output paths are never touched (the gate
      // refuses before the handler runs).
      const probes: { name: string; args: Record<string, unknown> }[] = [
        { name: "raiopdf_health", args: {} },
        { name: "pdf_page_count", args: { path: fixture("three-pages.pdf") } },
        { name: "merge_pdfs", args: { inputs: [fixture("three-pages.pdf"), fixture("five-pages.pdf")], output: out("gated-merge.pdf") } },
        { name: "extract_pages", args: { input: fixture("five-pages.pdf"), output: out("gated-extract.pdf"), pages: [0] } },
      ];
      for (const probe of probes) {
        const structured = await call(off, probe.name, probe.args, 30_000);
        expect(structured.ok, `${probe.name} should be gated off`).toBe(false);
        expect((structured.error as { code?: string })?.code).toBe("MCP_DISABLED");
      }
    } finally {
      await off.close().catch(() => undefined);
      rmSync(offDir, { recursive: true, force: true });
    }
  });

  it("advertises exactly the 25 documented tools", async () => {
    const listed = (await enabled.listTools()).tools.map((tool) => tool.name).sort();
    expect(listed).toEqual(EXPECTED_TOOLS);
    expect(listed).toHaveLength(25);
  });

  it("raiopdf_health: the connector's own engine host is reachable", async () => {
    // First engine-backed call — boots the real engine host end to end.
    const structured = await call(enabled, "raiopdf_health");
    expect(structured.ok).toBe(true);
  });

  it("pdf_page_count: counts pages through the real engine", async () => {
    expect(await call(enabled, "pdf_page_count", { path: fixture("three-pages.pdf") })).toMatchObject({
      ok: true,
      pageCount: 3,
    });
  });

  it("merge_pdfs: concatenates in order into a valid 8-page PDF", async () => {
    const output = out("merged.pdf");
    const structured = await call(enabled, "merge_pdfs", {
      inputs: [fixture("three-pages.pdf"), fixture("five-pages.pdf")],
      output,
    });
    expect(structured).toMatchObject({ ok: true, output });
    expect(await pageCountOf(output)).toBe(8);
  });

  it("extract_pages: keeps only the selected pages", async () => {
    const output = out("extracted.pdf");
    const structured = await call(enabled, "extract_pages", {
      input: fixture("five-pages.pdf"),
      output,
      pages: [0, 2],
    });
    expect(structured).toMatchObject({ ok: true, output });
    expect(await pageCountOf(output)).toBe(2);
  });

  it("rotate_pages: rotates every page 90° and preserves the page count", async () => {
    const output = out("rotated.pdf");
    const structured = await call(enabled, "rotate_pages", {
      input: fixture("five-pages.pdf"),
      output,
      degrees: 90,
    });
    expect(structured).toMatchObject({ ok: true, output });
    const doc = await PDFDocument.load(await readFile(output));
    expect(doc.getPageCount()).toBe(5);
    expect(doc.getPage(0).getRotation().angle).toBe(90);
  });

  it("compress_pdf: writes a smaller-or-equal valid PDF via the real engine", async () => {
    const output = out("compressed.pdf");
    const structured = await call(enabled, "compress_pdf", {
      input: fixture("five-pages.pdf"),
      output,
    });
    expect(structured).toMatchObject({ ok: true, output });
    expect(await pageCountOf(output)).toBe(5);
  });

  it("build_exhibit_binder: assembles main + exhibit into one 8-page binder", async () => {
    const output = out("binder.pdf");
    const structured = await call(enabled, "build_exhibit_binder", {
      main: fixture("three-pages.pdf"),
      exhibits: [{ path: fixture("five-pages.pdf"), label: "Exhibit A" }],
      output,
      slipSheets: false,
      index: { enabled: false },
    });
    expect(structured).toMatchObject({ ok: true, output });
    expect(await pageCountOf(output)).toBe(8);
  });

  it("bates_stamp: stamps a sequence and preserves the page count", async () => {
    const output = out("bates.pdf");
    const structured = await call(enabled, "bates_stamp", {
      input: fixture("three-pages.pdf"),
      output,
      prefix: "SMITH",
    });
    expect(structured).toMatchObject({ ok: true, output });
    expect(await pageCountOf(output)).toBe(3);
  });

  it("redact_terms: verified removal — writes only after confirming no term survives", async () => {
    const output = out("redacted.pdf");
    const structured = await call(enabled, "redact_terms", {
      input: fixture("letter-portrait.pdf"),
      output,
      terms: ["Page"],
    });
    expect(structured).toMatchObject({ ok: true, output, survivingTerms: [] });
    expect(existsSync(output)).toBe(true);
  });

  it("prepare_for_filing: read-only preflight returns cited checks and stays honest about readiness", async () => {
    const structured = await call(enabled, "prepare_for_filing", {
      input: fixture("letter-portrait.pdf"),
      pack: "florida",
    });
    expect(structured.ok).toBe(true);
    // Not a green light while any check is unverifiable locally (PDF/A, clerk stamp).
    expect(structured.confirmedReady).toBe(false);
    expect((structured.unverified as string[]).length).toBeGreaterThan(0);
    const checks = structured.checks as { authority: string }[];
    expect(checks.length).toBeGreaterThan(0);
    // Every advertised check carries its rule citation.
    expect(checks.every((check) => typeof check.authority === "string" && check.authority.length > 0)).toBe(true);
  });

  it("locate_text: finds text via pdf.js through the bundled connector", async () => {
    // #125's annotation tools run on pdf.js — the same path the worker fix unblocks.
    // If the worker weren't bundled, this would throw "Setting up fake worker failed".
    const structured = await call(enabled, "locate_text", {
      input: fixture("three-pages.pdf"),
      query: "of",
    });
    expect(structured.ok).toBe(true);
    expect(structured.matchCount as number).toBeGreaterThan(0);
    expect((structured.matches as unknown[]).length).toBeGreaterThan(0);
  });

  it("highlight_text: annotates located text and preserves the page count", async () => {
    const output = out("highlighted.pdf");
    const structured = await call(enabled, "highlight_text", {
      input: fixture("three-pages.pdf"),
      output,
      quote: "of",
    });
    expect(structured).toMatchObject({ ok: true, output });
    expect(structured.occurrences as number).toBeGreaterThan(0);
    expect(await pageCountOf(output)).toBe(3);
  });
});
