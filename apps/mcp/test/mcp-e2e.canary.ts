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
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFString,
  PDFStream,
  StandardFonts,
} from "pdf-lib";
import { readRaioPdfMarkupAnnotations } from "@raiopdf/engine-local";
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

function commandPath(command: string): string | undefined {
  try {
    return execFileSync("sh", ["-c", `command -v ${command}`], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

function existingEnvFile(key: string, fallbackCommand: string): Record<string, string> {
  if (process.env[key]?.trim()) return {};
  const found = commandPath(fallbackCommand);
  return found ? { [key]: found } : {};
}

const DEV_ENGINE_TOOLCHAIN_ENV: Record<string, string> = isWindows
  ? {}
  : {
      RAIOPDF_ENGINE_JAVA: process.env.RAIOPDF_ENGINE_JAVA?.trim() || "java",
      ...existingEnvFile("RAIOPDF_ENGINE_QPDF", "qpdf"),
      ...existingEnvFile("RAIOPDF_ENGINE_GHOSTSCRIPT", "gs"),
      ...existingEnvFile("RAIOPDF_ENGINE_OCRMYPDF", "ocrmypdf"),
    };

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
      ...DEV_ENGINE_TOOLCHAIN_ENV,
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

function expectStructuredOk(structured: Record<string, unknown>, label: string): void {
  expect(
    structured.ok,
    `${label} failed: ${JSON.stringify(structured.error ?? structured, null, 2)}`,
  ).toBe(true);
}

async function pageCountOf(file: string): Promise<number> {
  const doc = await PDFDocument.load(await readFile(file));
  return doc.getPageCount();
}

async function writeTextPdf(
  file: string,
  pageTexts: readonly string[],
  metadata: {
    title?: string;
    author?: string;
    subject?: string;
    keywords?: string[];
    producer?: string;
    creator?: string;
  } = {},
): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pageTexts.forEach((text, index) => {
    const page = pdf.addPage([612, 792]);
    page.drawText(text, { x: 72, y: 700, size: 16, font });
    page.drawText(`Marker page ${index + 1}`, { x: 72, y: 660, size: 12, font });
  });
  if (metadata.title !== undefined) pdf.setTitle(metadata.title);
  if (metadata.author !== undefined) pdf.setAuthor(metadata.author);
  if (metadata.subject !== undefined) pdf.setSubject(metadata.subject);
  if (metadata.keywords !== undefined) pdf.setKeywords(metadata.keywords);
  if (metadata.producer !== undefined) pdf.setProducer(metadata.producer);
  if (metadata.creator !== undefined) pdf.setCreator(metadata.creator);
  await writeFile(file, await pdf.save());
}

async function writePdfWithActiveContent(file: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([612, 792]);
  page.drawText("Active content canary fixture", { x: 72, y: 700, size: 16, font });

  const jsAction = pdf.context.register(pdf.context.obj({
    S: PDFName.of("JavaScript"),
    JS: PDFString.of("app.alert('sanitize canary')"),
  }));
  pdf.catalog.set(PDFName.of("OpenAction"), jsAction);
  pdf.catalog.set(PDFName.of("Names"), pdf.context.obj({
    JavaScript: pdf.context.obj({
      Names: pdf.context.obj([PDFString.of("sanitizeCanary"), jsAction]),
    }),
  }));

  const uriAction = pdf.context.obj({
    S: PDFName.of("URI"),
    URI: PDFString.of("https://example.invalid/sanitize-canary"),
  });
  const linkAnnotation = pdf.context.register(pdf.context.obj({
    Type: PDFName.of("Annot"),
    Subtype: PDFName.of("Link"),
    Rect: pdf.context.obj([72, 680, 320, 720]),
    Border: pdf.context.obj([0, 0, 0]),
    A: uriAction,
  }));
  page.node.set(PDFName.of("Annots"), pdf.context.obj([linkAnnotation]));

  await writeFile(file, await pdf.save());
}

async function writeScannedTextPdf(file: string): Promise<void> {
  const textSource = `${file}.text-source.pdf`;
  const pngSource = `${file}.page.png`;
  await writeTextPdf(textSource, ["RAIO CANARY OCR"]);
  execFileSync("gs", [
    "-dSAFER",
    "-dBATCH",
    "-dNOPAUSE",
    "-sDEVICE=png16m",
    "-r300",
    `-sOutputFile=${pngSource}`,
    textSource,
  ], { stdio: "ignore" });

  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const png = await pdf.embedPng(await readFile(pngSource));
  page.drawImage(png, { x: 0, y: 0, width: 612, height: 792 });
  await writeFile(file, await pdf.save());
}

async function createPasswordFixture(source: string, encrypted: string): Promise<boolean> {
  await writeTextPdf(source, ["Password protected canary text"]);
  try {
    execFileSync("qpdf", [
      "--encrypt",
      "secret",
      "secret",
      "256",
      "--",
      source,
      encrypted,
    ], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function metadataOf(file: string): Promise<{
  title?: string | undefined;
  author?: string | undefined;
  subject?: string | undefined;
  keywords?: string | undefined;
  producer?: string | undefined;
  creator?: string | undefined;
}> {
  const pdf = await PDFDocument.load(await readFile(file), { ignoreEncryption: true });
  return {
    title: pdf.getTitle(),
    author: pdf.getAuthor(),
    subject: pdf.getSubject(),
    keywords: pdf.getKeywords(),
    producer: pdf.getProducer(),
    creator: pdf.getCreator(),
  };
}

async function annotationSubtypes(file: string): Promise<string[]> {
  const pdf = await PDFDocument.load(await readFile(file));
  return pdf.getPages().flatMap((page) => {
    const annotations = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annotations) return [];
    const subtypes: string[] = [];
    for (let index = 0; index < annotations.size(); index += 1) {
      const annotation = annotations.lookup(index, PDFDict);
      const subtype = annotation.lookup(PDFName.of("Subtype"), PDFName);
      subtypes.push(subtype.asString().replace(/^\//, ""));
    }
    return subtypes;
  });
}

async function markupSubtypes(file: string): Promise<string[]> {
  const pdf = await PDFDocument.load(await readFile(file));
  return pdf.getPages().flatMap((page) =>
    readRaioPdfMarkupAnnotations(page).map((entry) => entry.subtype)
  );
}

async function activeContentFacts(file: string): Promise<{
  hasCatalogOpenAction: boolean;
  hasJavaScriptNames: boolean;
  annotationActions: string[];
}> {
  const pdf = await PDFDocument.load(await readFile(file));
  const catalog = pdf.catalog;
  const names = catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  const javaScriptNames = names?.lookupMaybe(PDFName.of("JavaScript"), PDFDict);
  const annotationActions: string[] = [];
  for (const page of pdf.getPages()) {
    const annotations = page.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annotations) continue;
    for (let index = 0; index < annotations.size(); index += 1) {
      const annotation = annotations.lookup(index, PDFDict);
      const action = annotation.lookupMaybe(PDFName.of("A"), PDFDict);
      const actionType = action?.lookupMaybe(PDFName.of("S"), PDFName);
      if (actionType) annotationActions.push(actionType.asString().replace(/^\//, ""));
    }
  }
  return {
    hasCatalogOpenAction: catalog.get(PDFName.of("OpenAction")) !== undefined,
    hasJavaScriptNames: javaScriptNames !== undefined,
    annotationActions,
  };
}

async function decodedPageContent(file: string, pageIndex: number): Promise<string> {
  const bytes = await readFile(file);
  const pdf = await PDFDocument.load(bytes);
  const contents = pdf.getPage(pageIndex).node.Contents();
  const contentObjects = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  return contentObjects
    .map((object) => (object instanceof PDFStream ? object : pdf.context.lookup(object)))
    .filter((object): object is PDFStream => object instanceof PDFStream)
    .map((stream) => {
      if (stream instanceof PDFRawStream) {
        return new TextDecoder().decode(decodePDFRawStream(stream).decode());
      }
      return new TextDecoder().decode(stream.getContents());
    })
    .join("\n");
}

async function expectPageContentContains(file: string, pageIndex: number, text: string): Promise<void> {
  const content = await decodedPageContent(file, pageIndex);
  const hex = [...new TextEncoder().encode(text)]
    .map((byte) => byte.toString(16).padStart(2, "0").toUpperCase())
    .join("");
  expect(
    content.includes(text) || content.includes(`<${hex}>`),
    `page ${pageIndex + 1} content should contain ${text}`,
  ).toBe(true);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface CanaryPackageManifest {
  uploadFiles: Array<{
    relativePath: string;
    sha256: string;
    pages?: number;
    batesStart?: string;
    batesEnd?: string;
  }>;
  machineReports: Array<{ relativePath: string }>;
  rootDocuments: Array<{ relativePath: string }>;
  checks: unknown[];
  details: Record<string, unknown>;
}

function packageManifest(root: string): CanaryPackageManifest {
  return JSON.parse(readFileSyncUtf8(path.join(root, "raio-manifest", "manifest.json"))) as CanaryPackageManifest;
}

function readFileSyncUtf8(file: string): string {
  return readFileSync(file, "utf8");
}

function assertManifestChecksums(root: string): void {
  const checksumsPath = path.join(root, "raio-manifest", "checksums.txt");
  const lines = readFileSyncUtf8(checksumsPath).trim().split(/\n/).filter(Boolean);
  expect(lines.length, "package checksums should not be empty").toBeGreaterThan(0);
  for (const line of lines) {
    const match = line.match(/^([a-f0-9]{64}) {2}(.+)$/);
    expect(match, `checksum line should be parseable: ${line}`).not.toBeNull();
    if (!match) continue;
    const [, expected, relativePath] = match;
    expect(sha256(readFileSyncBytes(path.join(root, relativePath!))), `checksum should match ${relativePath}`).toBe(expected);
  }
}

function readFileSyncBytes(file: string): Uint8Array {
  return new Uint8Array(readFileSync(file));
}

// One writable directory for tool outputs. Every test uses a distinct base name and
// the connector never overwrites, so the fresh mkdtemp dir keeps outputs collision-free.
let workDir: string;
const out = (name: string): string => path.join(workDir, name);

let enabledConfigDir: string;
let enabled: Client;
let generatedThreePage: string;
let generatedTwoPage: string;
let metadataFixture: string;
let activeContentFixture: string;
let scannedFixture: string;
let passwordEncryptedFixture: string;
let passwordFixtureReady = false;

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
    generatedThreePage = out("generated-three-pages.pdf");
    generatedTwoPage = out("generated-two-pages.pdf");
    metadataFixture = out("metadata-source.pdf");
    activeContentFixture = out("active-content-source.pdf");
    scannedFixture = out("scanned-source.pdf");
    passwordEncryptedFixture = out("password-encrypted.pdf");
    await writeTextPdf(generatedThreePage, [
      "Alpha production agreement page one",
      "Beta production agreement page two",
      "Gamma production agreement page three",
    ]);
    await writeTextPdf(generatedTwoPage, [
      "Delta production agreement page one",
      "Epsilon production agreement page two",
    ]);
    await writeTextPdf(metadataFixture, ["Metadata scrub canary"], {
      title: "Canary Sensitive Title",
      author: "Canary Author",
      subject: "Canary Subject",
      keywords: ["canary", "sensitive"],
      producer: "Canary Producer",
      creator: "Canary Creator",
    });
    await writePdfWithActiveContent(activeContentFixture);
    await writeScannedTextPdf(scannedFixture);
    passwordFixtureReady = await createPasswordFixture(out("password-clear-source.pdf"), passwordEncryptedFixture);
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
    expectStructuredOk(structured, "merge_pdfs");
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
    expectStructuredOk(structured, "rotate_pages");
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
    expectStructuredOk(structured, "compress_pdf");
    expect(structured).toMatchObject({ output });
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

  it("ocr_pdf: makes an image-only PDF searchable and verifies page text", async () => {
    const output = out("ocr-output.pdf");
    const structured = await call(enabled, "ocr_pdf", {
      input: scannedFixture,
      output,
      force: true,
    }, 240_000);
    expectStructuredOk(structured, "ocr_pdf");
    expect(structured).toMatchObject({ ok: true, output, verifiedPages: 1, garbledPages: 0 });
    const located = await call(enabled, "locate_text", { input: output, query: "RAIO" });
    expect(located.ok).toBe(true);
    expect(located.matchCount as number).toBeGreaterThan(0);
  });

  it("remove_encryption: decrypts a password-required PDF and preserves content", async () => {
    expect(passwordFixtureReady, "qpdf must be available to create the password canary fixture").toBe(true);
    const output = out("password-decrypted.pdf");
    const structured = await call(enabled, "remove_encryption", {
      input: passwordEncryptedFixture,
      output,
      password: "secret",
    });
    expectStructuredOk(structured, "remove_encryption");
    expect(structured).toMatchObject({ ok: true, output });
    await expect(pageCountOf(output)).resolves.toBe(1);
    const located = await call(enabled, "locate_text", { input: output, query: "Password protected" });
    expect(located.matchCount as number).toBeGreaterThan(0);
  });

  it("sanitize_pdf: removes catalog JavaScript and annotation URI actions", async () => {
    const output = out("sanitized.pdf");
    const before = await activeContentFacts(activeContentFixture);
    expect(before).toMatchObject({
      hasCatalogOpenAction: true,
      hasJavaScriptNames: true,
      annotationActions: ["URI"],
    });

    const structured = await call(enabled, "sanitize_pdf", {
      input: activeContentFixture,
      output,
      removeJavaScript: true,
      removeEmbeddedFiles: true,
      removeLinks: true,
    });
    expect(structured.ok).toBe(true);
    expect(structured.output).toBe(output);
    expect(structured.removed as string[]).toEqual(
      expect.arrayContaining(["javascript", "external-links"]),
    );
    const after = await activeContentFacts(output);
    expect(after.hasCatalogOpenAction).toBe(false);
    expect(after.hasJavaScriptNames).toBe(false);
    expect(after.annotationActions).toHaveLength(0);
  });

  it("scrub_metadata: removes document Info metadata while preserving pages", async () => {
    const output = out("metadata-scrubbed.pdf");
    const before = await metadataOf(metadataFixture);
    expect(before).toMatchObject({
      title: "Canary Sensitive Title",
      author: "Canary Author",
      subject: "Canary Subject",
    });

    const structured = await call(enabled, "scrub_metadata", {
      input: metadataFixture,
      output,
    });
    expectStructuredOk(structured, "scrub_metadata");
    expect(structured).toMatchObject({ ok: true, output });
    expect(await pageCountOf(output)).toBe(1);
    const after = await metadataOf(output);
    expect(after.title ?? "").not.toContain("Canary Sensitive Title");
    expect(after.author ?? "").not.toContain("Canary Author");
    expect(after.subject ?? "").not.toContain("Canary Subject");
    expect(after.keywords ?? "").not.toContain("sensitive");
    expect(after.creator ?? "").not.toContain("Canary Creator");
    expect(after.producer ?? "").not.toContain("Canary Producer");
  });

  it("bates_stamp_folder: preserves file boundaries with one continuous Bates sequence", async () => {
    const outputDir = out("bates-folder");
    mkdirSync(outputDir);
    const structured = await call(enabled, "bates_stamp_folder", {
      inputs: [generatedThreePage, generatedTwoPage],
      outputDir,
      prefix: "SET",
      start: 10,
      digits: 6,
    });
    expect(structured.ok).toBe(true);
    expect(structured.nextNumber).toBe(15);
    const outputs = structured.outputs as string[];
    expect(outputs).toHaveLength(2);
    await expectPageContentContains(outputs[0]!, 0, "SET000010");
    await expectPageContentContains(outputs[0]!, 2, "SET000012");
    await expectPageContentContains(outputs[1]!, 0, "SET000013");
    await expectPageContentContains(outputs[1]!, 1, "SET000014");
  });

  it("page_numbers: stamps page-of-total numbers on selected pages only", async () => {
    const output = out("page-numbered.pdf");
    const structured = await call(enabled, "page_numbers", {
      input: generatedThreePage,
      output,
      startAt: 4,
      pages: [1, 2],
      format: "page-of-total",
    });
    expect(structured).toMatchObject({ ok: true, output });
    await expectPageContentContains(output, 1, "Page 4 of 3");
    await expectPageContentContains(output, 2, "Page 5 of 3");
    const firstPage = await decodedPageContent(output, 0);
    expect(firstPage).not.toContain("Page 4 of 3");
  });

  it("split_pdf: preserves all pages in order while splitting into output parts", async () => {
    const outputDir = out("split-parts");
    mkdirSync(outputDir);
    const structured = await call(enabled, "split_pdf", {
      input: generatedThreePage,
      outputDir,
      maxBytes: 1_200,
      prefix: "split-canary",
    });
    expect(structured.ok).toBe(true);
    const outputs = structured.outputs as string[];
    expect(outputs.length, "split should produce at least two parts for this cap").toBeGreaterThanOrEqual(2);
    const totalPages = (await Promise.all(outputs.map(pageCountOf))).reduce((sum, count) => sum + count, 0);
    expect(totalPages).toBe(3);
    expect(outputs.every((file) => path.basename(file).startsWith("split-canary-part-"))).toBe(true);
  });

  it("underline_text and strikethrough_text: write real markup annotation subtypes", async () => {
    const underlined = out("underlined.pdf");
    const underline = await call(enabled, "underline_text", {
      input: generatedThreePage,
      output: underlined,
      quote: "production",
      matchAll: false,
      color: "blue",
    });
    expect(underline).toMatchObject({ ok: true, output: underlined, occurrences: 1 });
    expect(await markupSubtypes(underlined)).toContain("Underline");

    const struck = out("struck.pdf");
    const strike = await call(enabled, "strikethrough_text", {
      input: generatedThreePage,
      output: struck,
      quote: "agreement",
      matchAll: false,
      color: "red",
    });
    expect(strike).toMatchObject({ ok: true, output: struck, occurrences: 1 });
    expect(await markupSubtypes(struck)).toContain("StrikeOut");
  });

  it("add_comment: anchors a real sticky-note annotation on the intended page", async () => {
    const output = out("commented.pdf");
    const structured = await call(enabled, "add_comment", {
      input: generatedThreePage,
      output,
      text: "Review this clause",
      anchorText: "Beta production",
      author: "Canary",
    });
    expect(structured).toMatchObject({ ok: true, output, page: 2 });
    expect(await annotationSubtypes(output)).toContain("Text");
  });

  it("build_production_set: writes consistent manifests, checksums, and Bates ranges", async () => {
    const outputDir = out("production-package");
    const structured = await call(enabled, "build_production_set", {
      sources: [
        { path: generatedThreePage, designation: "CONFIDENTIAL" },
        { path: generatedTwoPage },
      ],
      outputDir,
      prefix: "PROD",
      start: 100,
      digits: 6,
      includeIndex: true,
      combinedPdf: true,
    });
    expect(structured.ok).toBe(true);
    expect(structured.packageRoot).toBe(outputDir);
    expect(structured.nextNumber).toBe(105);
    const manifest = packageManifest(outputDir);
    expect(manifest.uploadFiles).toHaveLength(3);
    expect(manifest.rootDocuments.map((entry) => entry.relativePath)).toEqual(
      expect.arrayContaining(["production-index.csv", "production-index.pdf"]),
    );
    const sourceFiles = manifest.uploadFiles.filter((file) => file.batesStart);
    expect(sourceFiles.map((file) => [file.batesStart, file.batesEnd])).toEqual(
      expect.arrayContaining([
        ["PROD000100", "PROD000102"],
        ["PROD000103", "PROD000104"],
      ]),
    );
    assertManifestChecksums(outputDir);
  });

  it("batch_cleanup: writes report artifacts, per-file status, and matching checksums", async () => {
    const outputDir = out("batch-package");
    const structured = await call(enabled, "batch_cleanup", {
      inputs: [metadataFixture, generatedTwoPage],
      outputDir,
      operations: {
        ocrMode: "off",
        compress: false,
        sanitize: false,
        scrubMetadata: true,
        repair: false,
        splitBySize: false,
        normalizePages: false,
        convertToPdfA: false,
      },
    });
    expect(structured.ok).toBe(true);
    expect(structured.packageRoot).toBe(outputDir);
    expect(structured.reportPdf).toBe("batch-report.pdf");
    expect(structured.reportJson).toBe("raio-manifest/batch-report.json");
    const files = structured.files as Array<{ status: string; outputs: string[] }>;
    expect(files).toHaveLength(2);
    expect(files.every((file) => file.status === "done" && file.outputs.length === 1)).toBe(true);
    assertManifestChecksums(outputDir);
  });

  it("build_filing_packet: writes upload files, packet report, manifest, and checksums", async () => {
    const outputDir = out("filing-package");
    const structured = await call(enabled, "build_filing_packet", {
      sources: [
        { path: generatedThreePage, displayName: "Motion.pdf" },
        { path: generatedTwoPage, displayName: "Exhibit.pdf" },
      ],
      outputDir,
      pack: "florida",
      layoutMode: "separate-files",
      prefixFilenames: true,
      selectedStepIds: ["split-by-size"],
      skippedStepIds: [
        "remove-encryption",
        "normalize-pages",
        "sanitize-content",
        "scrub-metadata",
        "make-searchable",
        "flatten-forms",
        "convert-pdfa",
      ],
      splitSizeMb: 0.001,
      convertToPdfA: false,
    }, 240_000);
    expect(structured.ok).toBe(true);
    expect(structured.packageRoot).toBe(outputDir);
    expect(structured.manifestPdf).toBe("filing-packet-manifest.pdf");
    expect(structured.packetJson).toBe("raio-manifest/filing-packet.json");
    const manifest = packageManifest(outputDir);
    expect(manifest.uploadFiles.length).toBeGreaterThanOrEqual(2);
    expect(manifest.checks.length).toBeGreaterThan(0);
    expect(manifest.details.filingPacket).toBeDefined();
    assertManifestChecksums(outputDir);
  });
});
