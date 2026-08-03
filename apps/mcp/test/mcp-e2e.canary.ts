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
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  path.join(
    repoRoot,
    "apps",
    "shell",
    "src-tauri",
    "payload",
    isWindows ? "windows-x64" : "macos-arm64",
  );

// The connector we drive is the exact artifact that ships: the esbuild-bundled
// runtime under the assembled payload (produced by `installer/build-mcp-runtime.mjs`
// / `pnpm prepare:shell-bundle`), launched with the payload's bundled Node. This is
// what the `raiopdf-mcp` launcher runs — NOT the raw tsc `apps/mcp/dist/index.js`,
// which relies on extensionless workspace imports esbuild resolves at bundle time.
const bundledConnector = path.join(payloadDir, "mcp", "app", "index.mjs");
const bundledNodeCandidates = isWindows
  ? [path.join(payloadDir, "mcp", "node", "node.exe")]
  : [
      path.join(payloadDir, "mcp", "node", "bin", "node"),
      path.join(payloadDir, "mcp", "node", "node"),
    ];
const nodeBin = bundledNodeCandidates.find((candidate) => existsSync(candidate)) ?? process.execPath;

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

function existingEnvFile(
  key: string,
  payloadRelative: readonly string[],
  fallbackCommand: string,
): Record<string, string> {
  if (process.env[key]?.trim()) return {};
  // Prefer the bundled payload tool so the canary exercises exactly what ships:
  // leaving the override unset lets the engine-host discover the bundled binary
  // (for OCRmyPDF, the wrapper that sets TESSDATA_PREFIX for the source-built
  // tesseract). Fall back to a system tool only when the payload lacks it.
  if (existsSync(path.join(payloadDir, ...payloadRelative))) return {};
  const found = commandPath(fallbackCommand);
  return found ? { [key]: found } : {};
}

function resolveCanaryTool(envKey: string, payloadRelative: readonly string[], fallbackCommand: string): string {
  const explicit = process.env[envKey]?.trim();
  if (explicit) return explicit;

  const bundled = path.join(payloadDir, ...payloadRelative);
  if (existsSync(bundled)) return bundled;

  return commandPath(fallbackCommand) ?? fallbackCommand;
}

const canaryGhostscript = resolveCanaryTool(
  "RAIOPDF_ENGINE_GHOSTSCRIPT",
  ["ocr", "gs", "bin", isWindows ? "gs.exe" : "gs"],
  isWindows ? "gs.exe" : "gs",
);
const canaryQpdf = resolveCanaryTool(
  "RAIOPDF_ENGINE_QPDF",
  ["ocr", "qpdf", "bin", isWindows ? "qpdf.exe" : "qpdf"],
  isWindows ? "qpdf.exe" : "qpdf",
);

const DEV_ENGINE_TOOLCHAIN_ENV: Record<string, string> = isWindows
  ? {}
  : {
      RAIOPDF_ENGINE_JAVA: process.env.RAIOPDF_ENGINE_JAVA?.trim() || "java",
      ...existingEnvFile("RAIOPDF_ENGINE_QPDF", ["ocr", "qpdf", "bin", "qpdf"], "qpdf"),
      ...existingEnvFile("RAIOPDF_ENGINE_GHOSTSCRIPT", ["ocr", "gs", "bin", "gs"], "gs"),
      ...existingEnvFile("RAIOPDF_ENGINE_OCRMYPDF", ["ocr", "ocrmypdf"], "ocrmypdf"),
    };

// The tools the connector advertises. Canonical count lives in docs/MCP.md; this set
// is the drift guard for it (and for the README / landing-page counts). Adding a tool
// means updating this list AND docs/MCP.md together.
const EXPECTED_TOOLS = [
  "raiopdf_diagnostics",
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
  "build_cover_page",
  "detect_authorities",
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
  execFileSync(canaryGhostscript, [
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
    execFileSync(canaryQpdf, [
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

/** A parsed header row plus data rows, for the package's tabular artifacts
 *  (`production.dat`, `production-index.csv`, `draft-privilege-log.csv`). */
interface CanaryDelimitedFile {
  header: string[];
  rows: string[][];
}

/** Reads one column of a parsed row by header name, so an assertion names the
 *  column it means instead of a positional index that silently shifts when a
 *  field is added. */
function column(file: CanaryDelimitedFile, row: readonly string[], name: string): string {
  const index = file.header.indexOf(name);
  expect(index, `column "${name}" should exist; header is ${file.header.join(", ")}`).toBeGreaterThanOrEqual(0);
  return row[index] ?? "";
}

/** Byte `0x14` (ASCII DC4) — the DAT field delimiter (docs/PRODUCTION-SETS.md). */
const DAT_FIELD_DELIMITER = String.fromCharCode(0x14);

/**
 * Parses `production.dat` and asserts its envelope on the way through: UTF-8
 * with a BOM, `0x14`-delimited, `þ`-qualified on every field including the
 * header, CRLF-terminated on every line including the last. A load file that
 * a review platform silently mis-imports is exactly the failure a mocked unit
 * test can't see — the bytes have to come off disk.
 */
function readProductionDat(root: string): CanaryDelimitedFile {
  const bytes = readFileSyncBytes(path.join(root, "production.dat"));
  expect([...bytes.subarray(0, 3)], "production.dat should start with a UTF-8 BOM").toEqual([0xef, 0xbb, 0xbf]);
  const text = new TextDecoder().decode(bytes.subarray(3));
  expect(text.endsWith("\r\n"), "every production.dat line ends CRLF, including the last").toBe(true);
  const parsed = text
    .slice(0, -2)
    .split("\r\n")
    .map((line) =>
      line.split(DAT_FIELD_DELIMITER).map((field) => {
        expect(/^þ[\s\S]*þ$/.test(field), `every DAT field should be þ-qualified: ${field}`).toBe(true);
        return field.slice(1, -1);
      })
    );
  return { header: parsed[0] ?? [], rows: parsed.slice(1) };
}

/** Minimal RFC 4180 reader for the package's own CSV artifacts (production
 *  index, draft privilege log) — quoted cells and doubled quotes included, so
 *  a blank column is distinguishable from a missing one. */
function readPackageCsv(root: string, name: string): CanaryDelimitedFile {
  const text = readFileSyncUtf8(path.join(root, name));
  const rows: string[][] = [];
  let row: string[] = [];
  let cellText = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (char !== '"') {
        cellText += char;
      } else if (text[index + 1] === '"') {
        cellText += '"';
        index += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(cellText);
      cellText = "";
    } else if (char === "\n") {
      row.push(cellText);
      rows.push(row);
      row = [];
      cellText = "";
    } else if (char !== "\r") {
      cellText += char;
    }
  }
  if (cellText !== "" || row.length > 0) {
    row.push(cellText);
    rows.push(row);
  }
  return { header: rows[0] ?? [], rows: rows.slice(1) };
}

/** The numeric part of a formatted Bates number ("SLIP000003" -> 3). */
function batesNumber(bates: string): number {
  return Number(bates.replace(/^\D+/, ""));
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

  it("advertises exactly the 28 documented tools", async () => {
    const listed = (await enabled.listTools()).tools.map((tool) => tool.name).sort();
    expect(listed).toEqual(EXPECTED_TOOLS);
    expect(listed).toHaveLength(28);
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

  // Discovery-production coverage (0.1.6). The RULES here — who consumes a
  // Bates number, which rows a privilege log gets, what a slip sheet says —
  // are already proven by the unit suite in `packages/production-set/test`.
  // What only this layer can prove is ARTIFACT FIDELITY: that driving the real
  // connector over stdio actually lands these files on disk, with this
  // content, in this package shape. So it's two consolidated runs carrying
  // many fields each, not one run per rule — the canary suite is serial and
  // every extra production run costs real engine time.
  describe("build_production_set: withheld documents, load files, and continuation", () => {
    const PRIVILEGE = "Attorney-client privilege";
    // Distinctive filename tokens: the "absent everywhere" assertions below are
    // substring searches, so no source name may be a substring of another.
    let produceSource: string;
    let redactedSource: string;
    let omittedWithheldSource: string;
    let duplicateFirst: string;
    let duplicateSecond: string;
    let slipProduceFirst: string;
    let slipWithheldSource: string;
    let slipProduceLast: string;
    let continuationSource: string;

    beforeAll(async () => {
      produceSource = out("produced-agreement.pdf");
      redactedSource = out("redacted-memo.pdf");
      omittedWithheldSource = out("withheld-privileged-memo.pdf");
      duplicateFirst = out("duplicate-exhibit.pdf");
      duplicateSecond = out("duplicate-exhibit-copy.pdf");
      slipProduceFirst = out("first-production-doc.pdf");
      slipWithheldSource = out("withheld-strategy-memo.pdf");
      slipProduceLast = out("last-production-doc.pdf");
      continuationSource = out("continuation-doc.pdf");

      await writeTextPdf(produceSource, ["Produced agreement page one", "Produced agreement page two"]);
      await writeTextPdf(redactedSource, ["Redacted memo page one"]);
      await writeTextPdf(omittedWithheldSource, ["Privileged memo page one"]);
      await writeTextPdf(duplicateFirst, ["Duplicate exhibit page one"]);
      // Copied, not regenerated: pdf-lib stamps creation/modification dates, so
      // only a byte copy reliably hashes identical — which is what duplicate
      // detection keys on.
      copyFileSync(duplicateFirst, duplicateSecond);
      await writeTextPdf(slipProduceFirst, ["First production doc page one", "First production doc page two"]);
      await writeTextPdf(slipWithheldSource, ["Strategy memo page one"]);
      await writeTextPdf(slipProduceLast, ["Last production doc page one"]);
      await writeTextPdf(continuationSource, ["Continuation doc page one", "Continuation doc page two"]);
    }, 60_000);

    it('withheldHandling "omit": the withheld document is absent from upload/, the index, and production.dat', async () => {
      const outputDir = out("production-omit-package");
      const structured = await call(enabled, "build_production_set", {
        sources: [
          { path: produceSource, designation: "CONFIDENTIAL", custodian: "R. Nguyen" },
          {
            path: redactedSource,
            status: "produce-redacted",
            privilegeAsserted: "Attorney work product",
            basis: "Mental impressions of counsel redacted from the produced copy",
          },
          {
            path: omittedWithheldSource,
            // Carried deliberately: a withheld source's own designation must
            // never leak into a package it doesn't appear in.
            designation: "CONFIDENTIAL",
            status: "withhold",
            privilegeAsserted: PRIVILEGE,
            basis: "Legal advice regarding the draft agreement",
          },
          { path: duplicateFirst },
          { path: duplicateSecond },
        ],
        outputDir,
        prefix: "MIXED",
        start: 1,
        digits: 6,
        includeIndex: true,
        combinedPdf: true,
        includeLoadFiles: true,
        duplicateHandling: "produce-once",
        withheldHandling: "omit",
      }, 240_000);
      expectStructuredOk(structured, "build_production_set (omit)");

      // Three documents are produced: the agreement (2pp), the redacted memo
      // (1p), and the FIRST duplicate only. The withheld source and the second
      // duplicate occurrence each consume NO Bates number, so numbering stays
      // contiguous and the run ends at 5 — not the 7 a produce-all run that
      // also produced the withheld document would reach.
      expect(structured).toMatchObject({
        packageRoot: outputDir,
        nextNumber: 5,
        withheldCount: 1,
        redactedCount: 1,
        slipSheetCount: 0,
        duplicateCount: 1,
        loadFileDat: "production.dat",
        privilegeLogLocation: "draft-privilege-log.csv",
        indexCsv: "production-index.csv",
      });
      expect(structured.outputs as string[]).toHaveLength(3);

      // upload/ on disk: 3 produced documents + the combined PDF, and no trace
      // of the withheld document or the omitted duplicate occurrence.
      const uploadNames = readdirSync(path.join(outputDir, "upload"));
      expect(uploadNames).toHaveLength(4);
      expect(uploadNames.some((name) => name.includes("withheld-privileged-memo"))).toBe(false);
      expect(uploadNames.some((name) => name.includes("duplicate-exhibit-copy"))).toBe(false);
      expect(uploadNames.some((name) => name.includes("duplicate-exhibit.pdf"))).toBe(true);

      // The production index never names it either.
      const index = readPackageCsv(outputDir, "production-index.csv");
      expect(index.rows).toHaveLength(3);
      expect(readFileSyncUtf8(path.join(outputDir, "production-index.csv"))).not.toContain(
        "withheld-privileged-memo",
      );

      // production.dat: one row per PRODUCED document — no row for the combined
      // PDF, the withheld document, or the produce-once-skipped duplicate.
      const dat = readProductionDat(outputDir);
      expect(dat.header).toEqual([
        "BEGBATES",
        "ENDBATES",
        "BEGATTACH",
        "ENDATTACH",
        "PAGECOUNT",
        "CONFIDENTIALITY",
        "CUSTODIAN",
        "FILENAME",
        "LINK",
        "SHA256",
      ]);
      expect(dat.rows, "one DAT row per produced document, and nothing else").toHaveLength(3);
      expect(dat.rows.map((row) => [column(dat, row, "BEGBATES"), column(dat, row, "ENDBATES")])).toEqual([
        ["MIXED000001", "MIXED000002"],
        ["MIXED000003", "MIXED000003"],
        ["MIXED000004", "MIXED000004"],
      ]);
      expect(dat.rows.some((row) => column(dat, row, "LINK").includes("withheld-privileged-memo"))).toBe(false);
      expect(dat.rows.some((row) => column(dat, row, "LINK").includes("combined-production"))).toBe(false);
      // Fields that ride the transport for real: designation, custodian, and
      // the backslash-separated LINK every review platform expects.
      expect(column(dat, dat.rows[0]!, "CONFIDENTIALITY")).toBe("CONFIDENTIAL");
      expect(column(dat, dat.rows[0]!, "CUSTODIAN")).toBe("R. Nguyen");
      expect(column(dat, dat.rows[0]!, "LINK")).toBe(
        "upload\\MIXED000001 - MIXED000002 - produced-agreement.pdf",
      );

      // The draft privilege log: one row per non-"produce" source, ordered by
      // source position. Blankness of the four manual columns IS the feature —
      // a wrong autopopulated privilege log is worse than a sparse one
      // (docs/PRODUCTION-SETS.md).
      const log = readPackageCsv(outputDir, "draft-privilege-log.csv");
      expect(log.header).toEqual([
        "RowId",
        "Status",
        "Bates",
        "PrivilegeAsserted",
        "Description",
        "Filename",
        "Pages",
        "Date",
        "DocType",
        "Author",
        "Recipients",
      ]);
      expect(log.rows).toHaveLength(2);
      for (const row of log.rows) {
        for (const manualColumn of ["Date", "DocType", "Author", "Recipients"]) {
          expect(column(log, row, manualColumn), `${manualColumn} is a manual column and must stay blank`).toBe("");
        }
      }
      const redactedRow = log.rows.find((row) => column(log, row, "Status") === "Produced with redactions");
      expect(redactedRow, "the produce-redacted source should have a privilege log row").toBeDefined();
      expect(column(log, redactedRow!, "Bates")).toBe("MIXED000003-MIXED000003");
      const withheldRow = log.rows.find((row) => column(log, row, "Status") === "Withheld");
      expect(withheldRow, "the withheld source should have a privilege log row").toBeDefined();
      expect(column(log, withheldRow!, "PrivilegeAsserted")).toBe(PRIVILEGE);
      // Blank under "omit": this document never consumed a Bates number.
      expect(column(log, withheldRow!, "Bates")).toBe("");
      expect(column(log, withheldRow!, "Filename")).toBe("withheld-privileged-memo.pdf");

      assertManifestChecksums(outputDir);
    });

    it("default slip sheets take the withheld document's place, and a continuation run picks up where it left off", async () => {
      const slipRoot = out("production-slip-package");
      const slip = await call(enabled, "build_production_set", {
        sources: [
          { path: slipProduceFirst, designation: "CONFIDENTIAL" },
          {
            path: slipWithheldSource,
            // Never stamped onto the slip sheet — see the blank CONFIDENTIALITY
            // assertions below.
            designation: "CONFIDENTIAL",
            status: "withhold",
            privilegeAsserted: PRIVILEGE,
            basis: "Litigation strategy prepared in anticipation of trial",
          },
          { path: slipProduceLast },
        ],
        outputDir: slipRoot,
        prefix: "SLIP",
        start: 1,
        digits: 6,
        includeIndex: true,
        includeLoadFiles: true,
        // withheldHandling deliberately omitted: this run proves the DEFAULT.
      }, 240_000);
      expectStructuredOk(slip, "build_production_set (slip-sheet)");
      expect(slip).toMatchObject({
        packageRoot: slipRoot,
        nextNumber: 5,
        slipSheetCount: 1,
        withheldCount: 1,
        redactedCount: 0,
        loadFileDat: "production.dat",
        privilegeLogLocation: "draft-privilege-log.csv",
      });
      expect(slip.outputs as string[]).toHaveLength(3);

      // The placeholder is a real produced document: three files in upload/,
      // and the manifest's production-ordered ranges show it consuming exactly
      // ONE Bates number in the withheld document's own second position, with
      // no gap on either side.
      expect(readdirSync(path.join(slipRoot, "upload"))).toHaveLength(3);
      const slipManifest = packageManifest(slipRoot);
      expect(slipManifest.uploadFiles.map((file) => [file.batesStart, file.batesEnd])).toEqual([
        ["SLIP000001", "SLIP000002"],
        ["SLIP000003", "SLIP000003"],
        ["SLIP000004", "SLIP000004"],
      ]);
      const slipEntry = slipManifest.uploadFiles[1]!;
      expect(slipEntry.pages).toBe(1);
      const slipFile = path.join(slipRoot, slipEntry.relativePath);
      expect(existsSync(slipFile), "the slip sheet should be a real file in upload/").toBe(true);
      expect(await pageCountOf(slipFile)).toBe(1);

      // What the placeholder actually says, read back out of the generated page
      // through the connector's own text extraction.
      const withheldText = await call(enabled, "locate_text", { input: slipFile, query: "DOCUMENT WITHHELD" });
      expect(withheldText.matchCount as number, "the slip sheet should say DOCUMENT WITHHELD").toBeGreaterThan(0);
      const privilegeText = await call(enabled, "locate_text", { input: slipFile, query: PRIVILEGE });
      expect(privilegeText.matchCount as number, "the slip sheet should name the asserted privilege").toBeGreaterThan(0);
      // And it is Bates-stamped like any other produced page.
      await expectPageContentContains(slipFile, 0, "SLIP000003");

      // It appears in the index and the DAT, with a blank designation in both —
      // regardless of the designation its withheld source carried.
      const slipIndex = readPackageCsv(slipRoot, "production-index.csv");
      expect(slipIndex.rows).toHaveLength(3);
      const slipIndexRow = slipIndex.rows.find((row) => column(slipIndex, row, "Bates Start") === "SLIP000003");
      expect(slipIndexRow, "the slip sheet should have a production index row").toBeDefined();
      expect(column(slipIndex, slipIndexRow!, "Designation")).toBe("");
      expect(column(slipIndex, slipIndexRow!, "Pages")).toBe("1");
      expect(column(slipIndex, slipIndexRow!, "Filename")).toBe(
        "SLIP000003 - SLIP000003 - withheld-strategy-memo.pdf",
      );

      const slipDat = readProductionDat(slipRoot);
      expect(slipDat.rows).toHaveLength(3);
      const slipDatRow = slipDat.rows.find((row) => column(slipDat, row, "BEGBATES") === "SLIP000003");
      expect(slipDatRow, "the slip sheet should have a DAT row").toBeDefined();
      expect(column(slipDat, slipDatRow!, "CONFIDENTIALITY")).toBe("");
      expect(column(slipDat, slipDatRow!, "PAGECOUNT")).toBe("1");
      // The blank above is specific to the slip sheet, not a broken designation
      // path — the produced document ahead of it still carries its designation.
      expect(column(slipDat, slipDat.rows[0]!, "CONFIDENTIALITY")).toBe("CONFIDENTIAL");

      // The privilege log's Bates column names the slip sheet's stamped range,
      // while Filename still names the withheld document itself.
      const slipLog = readPackageCsv(slipRoot, "draft-privilege-log.csv");
      expect(slipLog.rows).toHaveLength(1);
      const slipLogRow = slipLog.rows[0]!;
      expect(column(slipLog, slipLogRow, "Status")).toBe("Withheld");
      expect(column(slipLog, slipLogRow, "Bates")).toBe(`${slipEntry.batesStart}-${slipEntry.batesEnd}`);
      expect(column(slipLog, slipLogRow, "Filename")).toBe("withheld-strategy-memo.pdf");
      for (const manualColumn of ["Date", "DocType", "Author", "Recipients"]) {
        expect(column(slipLog, slipLogRow, manualColumn), `${manualColumn} must stay blank`).toBe("");
      }
      assertManifestChecksums(slipRoot);

      // A second production continuing the same series off the first package.
      const continuationRoot = out("production-continuation-package");
      const continued = await call(enabled, "build_production_set", {
        sources: [{ path: continuationSource }],
        outputDir: continuationRoot,
        prefix: "SLIP",
        start: 5,
        digits: 6,
        includeIndex: true,
        continueFrom: slipRoot,
      }, 240_000);
      expectStructuredOk(continued, "build_production_set (continuation)");
      expect(continued).toMatchObject({
        packageRoot: continuationRoot,
        nextNumber: 7,
        continuation: { mode: "strict", priorLastBates: "SLIP000004" },
      });
      assertManifestChecksums(continuationRoot);

      // Across both packages the Bates ranges tile 1..6 exactly: sorted, each
      // range starts one past the previous one's end — no overlap, no gap.
      const ranges = [...slipManifest.uploadFiles, ...packageManifest(continuationRoot).uploadFiles]
        .map((file) => [batesNumber(file.batesStart!), batesNumber(file.batesEnd!)] as const)
        .sort((left, right) => left[0] - right[0]);
      expect(ranges).toHaveLength(4);
      expect(ranges[0]![0], "the combined series still starts at the first production's start").toBe(1);
      ranges.forEach(([start, end], index) => {
        expect(end, "every Bates range runs forward").toBeGreaterThanOrEqual(start);
        if (index > 0) {
          expect(start, "ranges are disjoint and contiguous — no overlap, no gap").toBe(ranges[index - 1]![1] + 1);
        }
      });
      expect(ranges.at(-1)![1]).toBe(6);

      // Negative: continuing from a folder that isn't a production package is a
      // structured refusal, and nothing is written.
      const notAPackage = out("not-a-production-package");
      mkdirSync(notAPackage, { recursive: true });
      writeFileSync(path.join(notAPackage, "notes.txt"), "not a production package\n");
      const rejectedOutputDir = out("production-continuation-rejected");
      const rejected = await call(enabled, "build_production_set", {
        sources: [{ path: continuationSource }],
        outputDir: rejectedOutputDir,
        prefix: "SLIP",
        start: 7,
        digits: 6,
        continueFrom: notAPackage,
      }, 120_000);
      expect(rejected.ok).toBe(false);
      const error = rejected.error as { code?: string; message?: string };
      expect(error.code).toBe("ENGINE_ERROR");
      expect(error.message).toContain("production package");
      expect(existsSync(rejectedOutputDir), "a refused continuation leaves no half-built package").toBe(false);
    });
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
