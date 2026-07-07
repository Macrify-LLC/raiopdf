/**
 * The single choke point for every NON-main-document file add.
 *
 * Closed-form entry rule [R7-2] (large-PDF-handling plan): `filePort.openFile()`
 * is reserved for opening the MAIN document. Every other file add -- Organize
 * merge/insert, the pages-tab insert, Binder exhibits, Production Set, Batch
 * Cleanup, Filing Packet, and browser drops -- goes through `readFileForAdd`,
 * which size-checks FIRST and never fully materializes an above-threshold file
 * in the WebView:
 *
 * - at or below the threshold -> `{ kind: "bytes" }` with the file fully read
 *   (browser: `File.arrayBuffer` via `readBrowserFile`; Tauri picks: one-shot
 *   whole-file `read_pdf_range(grant, 0, sizeBytes)` [R6-2]).
 * - above the threshold, Tauri pick -> `{ kind: "descriptor" }` carrying
 *   `{ grant, name, sizeBytes, pageCount }` for the path-based flows.
 * - above the threshold, DOM `File` -> `{ kind: "tooLarge" }`; a DOM File can
 *   never yield a shell grant [R3-2], so callers surface an honest
 *   "this file is too large to add here" gate.
 *
 * SHELL COMMAND CONTRACTS:
 * - `pick_pdfs_for_add(multiple)` -> `[{ grant, name, sizeBytes }]` multi-select
 *   picker with NO eager byte read [R5-1].
 * - `read_pdf_range(grant, offset, length)` -> raw binary response; per-call
 *   length cap is max(4 MB, threshold), so a whole below-threshold file fits in
 *   one call [R6-2].
 * - `page_count(grant)` -> number (qpdf --show-npages) [R2-3].
 */
import {
  isTauriRuntime,
  pickBrowserFile,
  pickPdfsForAdd as pickPdfsForAddPrimitive,
  readBrowserFile,
  readPdfRange,
  type FileGrant,
  type OpenedFile,
} from "./filePort";
import {
  getLargeDocThresholdBytes,
  setLargeDocThresholdBytes,
} from "./largeDocThreshold";
import { getWordCapability, type WordCapability } from "./wordCapability";

/** Contract of one entry returned by the shell's `pick_pdfs_for_add` command. */
export interface PickedPdfForAdd {
  grant: string;
  name: string;
  sizeBytes: number;
  source?: "pdf" | "docx";
  markupScan?: DocxMarkupScan | null;
  convertedFromGrant?: string | null;
}

export type DocxMarkupScan = "clean" | "hasMarkup" | "uninspectable";
export type DocxMarkupMode = "final" | "showMarkup";

export interface DocxMarkupGate {
  markupCount: number;
  uninspectableCount: number;
  markupFiles: readonly string[];
  uninspectableFiles: readonly string[];
}

export interface DocxConversionProgressRow {
  id: string;
  name: string;
  status: "queued" | "running" | "done" | "error";
  message: string;
  pageCount: number | null;
}

export interface PickPdfsForAddOptions {
  confirmDocxMarkup?: (gate: DocxMarkupGate) => Promise<DocxMarkupMode>;
  onDocxRowsChange?: (rows: readonly DocxConversionProgressRow[]) => void;
  onWordUnavailable?: (message: string, capability: WordCapability) => void;
  onDocxErrors?: (errors: readonly DocxAddError[]) => void;
}

export interface FileAddDescriptor {
  grant: string;
  name: string;
  sizeBytes: number;
  /**
   * From `page_count(grant)` when the shell op exists; `null` = deferred
   * (not counted yet). Callers must render null honestly, not as 0.
   */
  pageCount: number | null;
}

export type FileAddResult =
  | { kind: "bytes"; file: OpenedFile }
  | { kind: "descriptor"; descriptor: FileAddDescriptor }
  | { kind: "tooLarge"; name: string; sizeBytes: number };

export type FileAddInput = File | PickedPdfForAdd;

export async function readFileForAdd(input: FileAddInput): Promise<FileAddResult> {
  const threshold = getLargeDocThresholdBytes();
  const sizeBytes = input instanceof File ? input.size : input.sizeBytes;
  const name = input.name;

  if (sizeBytes > threshold) {
    if (input instanceof File) {
      return { kind: "tooLarge", name, sizeBytes };
    }

    return {
      kind: "descriptor",
      descriptor: {
        grant: input.grant,
        name,
        sizeBytes,
        pageCount: await tryPageCountByGrant(input.grant),
      },
    };
  }

  if (input instanceof File) {
    return { kind: "bytes", file: await readBrowserFile(input) };
  }

  const bytes = await readWholeFileByGrant(input.grant, input.sizeBytes);
  return {
    kind: "bytes",
    file: { bytes, name, path: input.grant },
  };
}

/**
 * Multi-select add picker. Returns picked descriptors (`[]` = user cancelled),
 * or `null` when no grant-returning picker is available -- browser runtime, or
 * a Tauri shell that predates `pick_pdfs_for_add` (Lane A). On `null`, callers
 * fall back to their DOM `<input type=file>` and feed the resulting `File`s
 * back through `readFileForAdd`.
 */
export async function pickPdfsForAdd(
  options: PickPdfsForAddOptions = {},
): Promise<PickedPdfForAdd[] | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  try {
    const picked = await pickPdfsForAddPrimitive();

    if (!picked) {
      // Dialog cancelled.
      return [];
    }

    // The shell echoes its authoritative threshold with every pick — keep
    // the UI-side constant in lockstep so the two can never drift.
    setLargeDocThresholdBytes(picked.thresholdBytes);
    return await normalizePickedFilesForAdd([...picked.files], options);
  } catch (error) {
    if (isMissingCommandError(error, "pick_pdfs_for_add")) {
      // Shell predates the picker command — callers fall back to their DOM
      // input / legacy dialog.
      return null;
    }

    throw error;
  }
}

/**
 * Single-file pick-and-read for the package add flows (Production Set, Batch
 * Cleanup, Filing Packet). Uses `pick_pdfs_for_add` + `readFileForAdd`.
 * Returns `null` when the user cancels.
 *
 * The shell that serves this UI always ships `pick_pdfs_for_add` (UI and shell
 * are one binary), so `pickPdfsForAdd`'s legacy `null` ("no picker available")
 * result is unreachable here — it is treated as a cancel rather than falling
 * back to the main-document dialog.
 */
export async function pickFileForAdd(
  options: PickPdfsForAddOptions = {},
): Promise<FileAddResult | null> {
  if (!isTauriRuntime()) {
    // Browser: pick the DOM File ourselves so the size check runs BEFORE any
    // read [R2-4].
    const file = await pickBrowserFile();
    return file ? readFileForAdd(file) : null;
  }

  const pick = (await pickPdfsForAdd(options))?.[0];
  return pick ? readFileForAdd(pick) : null;
}

/** Shared honest-gate copy for above-threshold adds. */
export function tooLargeToAddMessage(name: string): string {
  return `"${name}" is too large to add here.`;
}

/**
 * One-shot whole-file ranged read [R6-2]: `read_pdf_range(grant, 0, sizeBytes)`.
 * Only ever called for below-threshold picks, which fit the shell's per-call
 * length cap (max(4 MB, threshold)) by definition.
 */
async function readWholeFileByGrant(grant: string, sizeBytes: number): Promise<Uint8Array> {
  return readPdfRange(grant as FileGrant, 0, sizeBytes);
}

async function normalizePickedFilesForAdd(
  files: readonly PickedPdfForAdd[],
  options: PickPdfsForAddOptions,
): Promise<PickedPdfForAdd[]> {
  const pdfFiles = files.filter((file) => file.source !== "docx");
  const docxFiles = files.filter((file) => file.source === "docx");

  if (docxFiles.length === 0) {
    return pdfFiles.map(stripInternalPickFields);
  }

  const capability = await getWordCapability(true);
  if (capability.state !== "available") {
    options.onWordUnavailable?.(wordUnavailableMessage(capability), capability);
    return pdfFiles.map(stripInternalPickFields);
  }

  const gate = buildDocxMarkupGate(docxFiles);
  const markup = gate
    ? await (options.confirmDocxMarkup ?? promptDocxMarkupMode)(gate)
    : "final";

  const rows = createDocxProgressRows(docxFiles);
  options.onDocxRowsChange?.(rows);

  const batch = await convertDocxForAdd(docxFiles, markup, (event) => {
    applyDocxProgress(rows, event);
    options.onDocxRowsChange?.([...rows]);
  });

  options.onDocxErrors?.(batch.errors);

  return mergeConvertedDocxPicks(files, batch.files);
}

function stripInternalPickFields(file: PickedPdfForAdd): PickedPdfForAdd {
  return {
    grant: file.grant,
    name: file.name,
    sizeBytes: file.sizeBytes,
  };
}

export function buildDocxMarkupGate(files: readonly PickedPdfForAdd[]): DocxMarkupGate | null {
  const markupFiles = files
    .filter((file) => file.markupScan === "hasMarkup")
    .map((file) => file.name);
  const uninspectableFiles = files
    .filter((file) => file.markupScan === "uninspectable")
    .map((file) => file.name);

  if (markupFiles.length === 0 && uninspectableFiles.length === 0) {
    return null;
  }

  return {
    markupCount: markupFiles.length,
    uninspectableCount: uninspectableFiles.length,
    markupFiles,
    uninspectableFiles,
  };
}

export function mergeConvertedDocxPicks(
  originalFiles: readonly PickedPdfForAdd[],
  convertedDocxFiles: readonly PickedPdfForAdd[],
): PickedPdfForAdd[] {
  const convertedBySourceGrant = new Map(
    convertedDocxFiles
      .filter((file) => file.convertedFromGrant)
      .map((file) => [file.convertedFromGrant!, file]),
  );
  return originalFiles.flatMap((file) => {
    if (file.source !== "docx") {
      return [{ grant: file.grant, name: file.name, sizeBytes: file.sizeBytes }];
    }

    const next = convertedBySourceGrant.get(file.grant);
    return next ? [{ grant: next.grant, name: next.name, sizeBytes: next.sizeBytes }] : [];
  });
}

function createDocxProgressRows(files: readonly PickedPdfForAdd[]): DocxConversionProgressRow[] {
  return files.map((file) => ({
    id: file.grant,
    name: file.name,
    status: "queued",
    message: "Queued",
    pageCount: null,
  }));
}

interface DocxProgressEvent {
  type: "progress" | "done";
  index: number;
  total: number;
  file: string;
  phase?: "startingWord" | "converting" | string;
  status?: "ok" | "error" | string;
  name?: string | null;
  pageCount?: number | null;
  error?: string | null;
}

function applyDocxProgress(rows: DocxConversionProgressRow[], event: DocxProgressEvent) {
  const row = rows[event.index - 1];
  if (!row) {
    return;
  }

  if (event.type === "done") {
    if (event.status === "ok") {
      row.status = "done";
      row.name = event.name ?? row.name;
      row.pageCount = event.pageCount ?? null;
      row.message = row.pageCount === null
        ? "Converted"
        : `Converted · ${row.pageCount} ${row.pageCount === 1 ? "page" : "pages"}`;
    } else {
      row.status = "error";
      row.message = event.error ?? "Could not convert";
    }
    return;
  }

  row.status = "running";
  row.message = event.phase === "startingWord"
    ? "Starting Word..."
    : `Converting ${event.index} of ${event.total}...`;
}

interface DocxAddBatchResult {
  files: PickedPdfForAdd[];
  errors: DocxAddError[];
}

interface DocxAddError {
  grant: string;
  name: string;
  code: string;
  message: string;
}

async function convertDocxForAdd(
  files: readonly PickedPdfForAdd[],
  markup: DocxMarkupMode,
  onProgress: (event: DocxProgressEvent) => void,
): Promise<DocxAddBatchResult> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");

  const unlistenProgress = await listen<{
    index: number;
    total: number;
    file: string;
    phase: string;
  }>("docx-convert:progress", (event) => {
    onProgress({ type: "progress", ...event.payload });
  });
  const unlistenDone = await listen<{
    index: number;
    total: number;
    file: string;
    status: string;
    name?: string | null;
    pageCount?: number | null;
    error?: string | null;
  }>("docx-convert:file-done", (event) => {
    onProgress({ type: "done", ...event.payload });
  });

  try {
    const result = await invoke<DocxAddBatchResult>("convert_docx_for_add", {
      files: files.map((file) => ({ grant: file.grant, name: file.name })),
      markup,
    });
    return result;
  } finally {
    unlistenProgress();
    unlistenDone();
  }
}

function wordUnavailableMessage(capability: WordCapability): string {
  if (capability.state === "notApplicable") {
    return "Word integration is not available on this computer. Word documents were not added.";
  }

  if (capability.reason) {
    return `Word integration not available: ${capability.reason}`;
  }

  return "Word integration not available. Word documents were not added.";
}

async function promptDocxMarkupMode(gate: DocxMarkupGate): Promise<DocxMarkupMode> {
  if (typeof document === "undefined") {
    return "final";
  }

  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.className = "docx-markup-gate";
    host.innerHTML = `
      <div class="docx-markup-gate__panel" role="dialog" aria-modal="true" aria-labelledby="docx-markup-gate-title">
        <h2 id="docx-markup-gate-title">${gate.markupCount} of these Word documents have tracked changes or comments</h2>
        ${gate.uninspectableCount > 0 ? `<p>${gate.uninspectableCount} could not be inspected and will be converted as-is.</p>` : ""}
        <div class="docx-markup-gate__choices" role="radiogroup">
          <label><input type="radio" name="docx-markup-mode" value="final" checked /> Final — hide tracked changes & comments</label>
          <label><input type="radio" name="docx-markup-mode" value="showMarkup" /> Show markup in the PDF</label>
        </div>
        <details>
          <summary>Details</summary>
          ${gate.markupFiles.length > 0 ? `<p>Tracked changes or comments</p><ul>${gate.markupFiles.map((file) => `<li>${escapeHtml(file)}</li>`).join("")}</ul>` : ""}
          ${gate.uninspectableFiles.length > 0 ? `<p>Could not be inspected</p><ul>${gate.uninspectableFiles.map((file) => `<li>${escapeHtml(file)}</li>`).join("")}</ul>` : ""}
        </details>
        <div class="docx-markup-gate__actions">
          <button type="button" data-action="continue">Continue</button>
        </div>
      </div>
    `;
    ensureDocxGateStyles();
    document.body.append(host);
    const button = host.querySelector<HTMLButtonElement>("[data-action='continue']");
    button?.focus();
    button?.addEventListener("click", () => {
      const checked = host.querySelector<HTMLInputElement>("input[name='docx-markup-mode']:checked");
      host.remove();
      resolve(checked?.value === "showMarkup" ? "showMarkup" : "final");
    }, { once: true });
  });
}

function ensureDocxGateStyles() {
  if (document.getElementById("docx-markup-gate-styles")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "docx-markup-gate-styles";
  style.textContent = `
    .docx-markup-gate{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;background:rgba(15,23,42,.28)}
    .docx-markup-gate__panel{width:min(520px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;background:#fff;border:1px solid #d8dee8;border-radius:8px;box-shadow:0 18px 60px rgba(15,23,42,.22);padding:18px;color:#172033;font:14px system-ui,sans-serif}
    .docx-markup-gate__panel h2{font-size:16px;line-height:1.35;margin:0 0 10px}
    .docx-markup-gate__panel p{margin:8px 0;color:#4a5568}
    .docx-markup-gate__choices{display:grid;gap:8px;margin:14px 0}
    .docx-markup-gate__choices label{display:flex;gap:8px;align-items:center}
    .docx-markup-gate__panel details{border-top:1px solid #edf1f7;padding-top:12px}
    .docx-markup-gate__panel ul{margin:6px 0 10px 18px;padding:0}
    .docx-markup-gate__actions{display:flex;justify-content:flex-end;margin-top:16px}
    .docx-markup-gate__actions button{border:0;border-radius:6px;background:#172033;color:#fff;padding:8px 12px;font-weight:600}
  `;
  document.head.append(style);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * `path_op_page_count(grant)` when available; `null` when the command is
 * missing (older shell) or the count fails -- callers treat null as
 * "deferred" and must render it honestly, never as 0.
 */
async function tryPageCountByGrant(grant: string): Promise<number | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const response = await invoke<{ pageCount: number }>("path_op_page_count", { grant });
    const count = response.pageCount;
    return Number.isInteger(count) && count >= 0 ? count : null;
  } catch {
    return null;
  }
}

function isMissingCommandError(error: unknown, command: string): boolean {
  const message = typeof error === "string"
    ? error
    : error instanceof Error
      ? error.message
      : "";

  return message.includes(command) && /not found/i.test(message);
}
