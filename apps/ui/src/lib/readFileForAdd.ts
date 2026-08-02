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
 * The package add flows (Production Set, Batch Cleanup, Filing Packet) pick
 * and read every file the user selected in one go via `pickFilesForAdd`,
 * which runs each pick through this same per-file logic and never lets one
 * bad file drop the rest of the batch (see its `{ kind: "error" }` case).
 * `pickFileForAdd` is the older single-file wrapper, kept for callers that
 * only ever want the first pick.
 *
 * Folder add (`addFolderFilesForAdd`) reaches the same place by a different
 * road: the shell scans the chosen folder and reports counts with NO grants,
 * the user confirms the scope, and only then does the shell mint grants -- in
 * the exact `pick_pdfs_for_add` shape, so everything after the confirm is the
 * same code the file picker uses.
 *
 * SHELL COMMAND CONTRACTS:
 * - `pick_pdfs_for_add(multiple)` -> `[{ grant, name, sizeBytes }]` multi-select
 *   picker with NO eager byte read [R5-1].
 * - `scan_folder_for_add()` -> `{ token, folderName, counts..., truncated }`;
 *   walks a picked folder for PDFs and issues NO grants.
 * - `claim_folder_scan(token, includeSubfolders)` -> the same `PickedPdfs` shape
 *   as the picker, for the confirmed scope only. The token is one-shot.
 * - `read_pdf_range(grant, offset, length)` -> raw binary response; per-call
 *   length cap is max(4 MB, threshold), so a whole below-threshold file fits in
 *   one call [R6-2].
 * - `page_count(grant)` -> number (qpdf --show-npages) [R2-3].
 */
import {
  claimFolderScan,
  isTauriRuntime,
  pickBrowserFile,
  pickPdfsForAdd as pickPdfsForAddPrimitive,
  readBrowserFile,
  readPdfRange,
  scanFolderForAdd as scanFolderForAddPrimitive,
  type FileGrant,
  type FolderScanSummary,
  type OpenedFile,
  type SkippedPickForAdd,
} from "./filePort";

export type { FolderScanSummary, SkippedPickForAdd } from "./filePort";
import {
  getLargeDocThresholdBytes,
  setLargeDocThresholdBytes,
} from "./largeDocThreshold";
import {
  getWordCapability,
  shouldRefuseWord,
  wordOperationGuidance,
  wordUnavailableMessage as wordUnavailableSummary,
  type WordCapability,
} from "./wordCapability";
import {
  getFocusableElements,
  isTopDialogStackEntry,
  registerDialogStackEntry,
} from "../components/FloatingDialog";

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
  /**
   * Files the shell picker itself could not serve (vanished between dialog and
   * stat, unreadable metadata). Reported per-file so one bad path never drops
   * the rest of a multi-select batch.
   */
  onSkippedPicks?: (skipped: readonly SkippedPickForAdd[]) => void;
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
  | { kind: "tooLarge"; name: string; sizeBytes: number }
  /**
   * One picked file failed to read (a range read that hit `FILE_CHANGED`/`IO`,
   * or any other per-file exception) -- the batch keeps going for the rest of
   * the pick rather than losing every file to one bad read. Only ever produced
   * by `pickFilesForAdd`'s per-file try/catch; `readFileForAdd` itself still
   * throws on a read failure for the single-file callers that catch around it.
   */
  | { kind: "error"; name: string; message: string };

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

    if (picked.skipped?.length) {
      options.onSkippedPicks?.(picked.skipped);
    }

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
 * Multi-select pick-and-read for the package add flows (Production Set, Batch
 * Cleanup, Filing Packet). Maps EVERY picked file through `readFileForAdd`,
 * preserving picker order. Returns `null` when the user cancels; an empty `[]`
 * only happens if the picker itself returns zero files (not a normal case --
 * `pick_pdfs_for_add`'s own cancel already surfaces as `null` here).
 *
 * The shell that serves this UI always ships `pick_pdfs_for_add` (UI and shell
 * are one binary), so `pickPdfsForAdd`'s legacy `null` ("no picker available")
 * result is unreachable here — it is treated as a cancel rather than falling
 * back to the main-document dialog.
 *
 * Partial-failure behavior: a per-file read failure (e.g. the file changed on
 * disk between pick and read) does NOT drop the rest of the batch. That file
 * comes back as a `{ kind: "error" }` entry alongside the successful reads --
 * callers use `summarizeFileAddResults` / `fileAddBatchMessage` to report
 * "N of M added; K failed: <names>" instead of losing the whole pick. Picks
 * the shell itself couldn't serve (vanished path, unreadable metadata) are
 * appended as error entries the same way.
 *
 * Memory contract: below-threshold picks materialize their bytes here, and
 * callers retain those same Uint8Array references in workspace state — the
 * batch itself adds no copies, so peak memory equals the steady state after
 * adding the same files one at a time. Above-threshold picks stay descriptors.
 */
export async function pickFilesForAdd(
  options: PickPdfsForAddOptions = {},
): Promise<FileAddResult[] | null> {
  if (!isTauriRuntime()) {
    // Browser: pick the DOM File ourselves so the size check runs BEFORE any
    // read [R2-4]. The browser has no native multi-select surface here (one
    // DOM `<input type=file>`, matching the pre-existing single-pick UX).
    const file = await pickBrowserFile();
    return file ? [await readFileForAdd(file)] : null;
  }

  const skippedByPicker: SkippedPickForAdd[] = [];
  const picks = await pickPdfsForAdd({
    ...options,
    onSkippedPicks: (skipped) => {
      skippedByPicker.push(...skipped);
      options.onSkippedPicks?.(skipped);
    },
  });
  if (picks === null) {
    return null;
  }

  return readPickedFilesForAdd(picks, skippedByPicker);
}

/**
 * Shared tail of every batch add: read each pick through `readFileForAdd`,
 * keeping order, and fold the shell's own per-file skips in as error entries so
 * "N of M added; K failed" covers them too.
 */
async function readPickedFilesForAdd(
  picks: readonly PickedPdfForAdd[],
  skippedByPicker: readonly SkippedPickForAdd[],
): Promise<FileAddResult[]> {
  const results: FileAddResult[] = [];
  for (const pick of picks) {
    try {
      results.push(await readFileForAdd(pick));
    } catch (error) {
      results.push({
        kind: "error",
        name: pick.name,
        message: error instanceof Error ? error.message : "This PDF could not be read.",
      });
    }
  }

  for (const skipped of skippedByPicker) {
    results.push({ kind: "error", name: skipped.name, message: skipped.message });
  }

  return results;
}

/** What the user chose in the folder-add confirm step. */
export interface FolderAddChoice {
  includeSubfolders: boolean;
}

export interface AddFolderFilesOptions {
  /** Overridable for tests; defaults to the built-in confirm dialog. */
  confirmFolderAdd?: (summary: FolderScanSummary) => Promise<FolderAddChoice | null>;
}

/**
 * Folder add, in two stages, so a folder is never turned into file access the
 * user did not confirm:
 *
 * 1. `scan_folder_for_add` walks the chosen folder and returns COUNTS ONLY --
 *    no grants, no bytes. A cancel here (or at the confirm dialog) leaves the
 *    WebView with nothing it could read a file with; the shell drops the scan.
 * 2. `claim_folder_scan` mints grants for the confirmed scope only (top level,
 *    or the whole tree) and returns the same shape the multi-select picker
 *    returns, so the reads, per-file failure handling, and batch summary below
 *    are exactly the ones the file picker already uses.
 *
 * Returns `null` when the user cancels at either stage.
 */
export async function addFolderFilesForAdd(
  options: AddFolderFilesOptions = {},
): Promise<FileAddResult[] | null> {
  if (!isTauriRuntime()) {
    // The browser has no folder picker that yields readable paths; callers hide
    // the entry point rather than offering a broken one.
    return null;
  }

  const summary = await scanFolderForAddPrimitive();
  if (!summary) {
    return null;
  }

  const choice = await (options.confirmFolderAdd ?? confirmFolderAdd)(summary);
  if (!choice) {
    return null;
  }

  const claimed = await claimFolderScan(summary.token, choice.includeSubfolders);
  setLargeDocThresholdBytes(claimed.thresholdBytes);

  return readPickedFilesForAdd(
    claimed.files.map((file) => ({
      grant: file.grant,
      name: file.name,
      sizeBytes: file.sizeBytes,
    })),
    claimed.skipped ?? [],
  );
}

/** "3 PDFs" / "1 PDF" — used by the confirm dialog's counts. */
export function folderAddPdfCountLabel(count: number): string {
  return `${count} PDF${count === 1 ? "" : "s"}`;
}

/**
 * The lines under the folder-add question: what the scan did NOT take. Every
 * one of these is a real omission, so they are stated rather than implied.
 */
export function folderAddNotes(summary: FolderScanSummary): string[] {
  const notes: string[] = [];
  if (summary.truncated) {
    notes.push(
      `This folder holds more than ${summary.totalPdfs} PDFs. Only the first ${folderAddPdfCountLabel(summary.totalPdfs)} were found; add the rest from their own folders.`,
    );
  }
  if (summary.skippedNonPdf > 0) {
    notes.push(`${summary.skippedNonPdf} file${summary.skippedNonPdf === 1 ? "" : "s"} skipped (not a PDF).`);
  }
  if (summary.skippedHidden > 0) {
    notes.push(`${summary.skippedHidden} hidden item${summary.skippedHidden === 1 ? "" : "s"} skipped.`);
  }
  if (summary.skippedLinks > 0) {
    notes.push(
      `${summary.skippedLinks} shortcut${summary.skippedLinks === 1 ? "" : "s"} skipped — RaioPDF does not follow shortcuts out of the folder you chose.`,
    );
  }
  if (summary.permissionFailures > 0) {
    const examples = summary.permissionFailureExamples.join(", ");
    notes.push(
      `${summary.permissionFailures} item${summary.permissionFailures === 1 ? "" : "s"} could not be read${examples ? ` (${examples})` : ""}.`,
    );
  }
  return notes;
}

let modalGateIdCounter = 0;

/**
 * Wires an imperatively-built modal gate (folder-add confirm, Word
 * markup-mode) into the same shared dialog stack `FloatingDialog` uses.
 *
 * These gates are opened from inside a package workspace, which is itself a
 * `FloatingDialog` -- and `FloatingDialog` owns Escape/Tab via a `window`
 * CAPTURE keydown listener gated on "am I the top dialog stack entry."
 * Without joining that same stack, the gate's own listener and the parent's
 * listener both fire independently: Escape closes the *parent* workspace out
 * from under the still-mounted gate, and Tab can walk focus into the now
 * hidden parent. Registering here makes the gate the new top-of-stack entry,
 * so the parent's listener sees `isTopDialogStackEntry(parentId) === false`
 * and no-ops while the gate is up -- Escape only ever cancels the gate, and
 * Tab is trapped inside it, exactly like a native `FloatingDialog`.
 *
 * Returns a `dispose` function the caller MUST invoke when the gate closes
 * (on every exit path -- confirm, cancel, or otherwise) to unregister from
 * the stack and remove the listener.
 */
function attachModalGateKeyboardHandling(host: HTMLElement, onEscape: () => void): () => void {
  const stackId = `modal-gate-${modalGateIdCounter++}`;
  const unregister = registerDialogStackEntry(stackId);

  function onKeyDown(event: KeyboardEvent) {
    if (!isTopDialogStackEntry(stackId)) {
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      onEscape();
      return;
    }

    if (event.key !== "Tab") {
      return;
    }

    event.stopImmediatePropagation();
    const focusable = getFocusableElements(host);

    if (focusable.length === 0) {
      event.preventDefault();
      return;
    }

    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  window.addEventListener("keydown", onKeyDown, true);

  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    unregister();
  };
}

/**
 * Confirm step for folder add. Built imperatively (like the Word markup gate)
 * so all three package workspaces get the identical dialog without any of them
 * carrying dialog state. Resolves `null` on cancel — which is what keeps the
 * scan unclaimed and no grants issued.
 */
export async function confirmFolderAdd(summary: FolderScanSummary): Promise<FolderAddChoice | null> {
  if (typeof document === "undefined") {
    return null;
  }

  return new Promise((resolve) => {
    const host = document.createElement("div");
    host.className = "folder-add-gate";
    const notes = folderAddNotes(summary);
    host.innerHTML = `
      <div class="folder-add-gate__panel" role="dialog" aria-modal="true" aria-labelledby="folder-add-gate-title">
        <h2 id="folder-add-gate-title">${summary.totalPdfs === 0
          ? `No PDFs in "${escapeHtml(summary.folderName)}"`
          : `Add ${folderAddPdfCountLabel(summary.totalPdfs)} from "${escapeHtml(summary.folderName)}"?`}</h2>
        <p class="folder-add-gate__counts">${escapeHtml(
          `${folderAddPdfCountLabel(summary.topLevelPdfs)} in the folder itself, ${summary.subfolderPdfs} in subfolders.`,
        )}</p>
        ${summary.subfolderPdfs > 0
          ? `<label class="folder-add-gate__toggle"><input type="checkbox" data-action="subfolders" checked /> Include subfolders</label>`
          : ""}
        ${notes.length > 0
          ? `<ul class="folder-add-gate__notes">${notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>`
          : ""}
        <div class="folder-add-gate__actions">
          <button type="button" data-action="cancel">Cancel</button>
          <button type="button" data-action="add">Add</button>
        </div>
      </div>
    `;
    ensureFolderAddGateStyles();
    document.body.append(host);

    const subfolders = host.querySelector<HTMLInputElement>("[data-action='subfolders']");
    const addButton = host.querySelector<HTMLButtonElement>("[data-action='add']");
    const cancelButton = host.querySelector<HTMLButtonElement>("[data-action='cancel']");

    const selectedCount = (): number =>
      subfolders && !subfolders.checked ? summary.topLevelPdfs : summary.totalPdfs;
    const syncAddButton = (): void => {
      if (!addButton) {
        return;
      }
      const count = selectedCount();
      addButton.textContent = count === 0 ? "Add" : `Add ${folderAddPdfCountLabel(count)}`;
      addButton.disabled = count === 0;
    };

    const finish = (choice: FolderAddChoice | null): void => {
      dispose();
      host.remove();
      resolve(choice);
    };
    const dispose = attachModalGateKeyboardHandling(host, () => finish(null));

    subfolders?.addEventListener("change", syncAddButton);
    syncAddButton();
    cancelButton?.addEventListener("click", () => finish(null));
    addButton?.addEventListener("click", () => {
      finish({ includeSubfolders: subfolders ? subfolders.checked : false });
    });
    (addButton?.disabled ? cancelButton : addButton)?.focus();
  });
}

function ensureFolderAddGateStyles() {
  if (document.getElementById("folder-add-gate-styles")) {
    return;
  }

  const style = document.createElement("style");
  style.id = "folder-add-gate-styles";
  style.textContent = `
    .folder-add-gate{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;background:rgba(15,23,42,.28)}
    .folder-add-gate__panel{width:min(460px,calc(100vw - 32px));max-height:calc(100vh - 32px);overflow:auto;background:#fff;border:1px solid #d8dee8;border-radius:8px;box-shadow:0 18px 60px rgba(15,23,42,.22);padding:18px;color:#172033;font:14px system-ui,sans-serif}
    .folder-add-gate__panel h2{font-size:16px;line-height:1.35;margin:0 0 10px}
    .folder-add-gate__counts{margin:0 0 12px;color:#4a5568}
    .folder-add-gate__toggle{display:flex;gap:8px;align-items:center;margin:0 0 12px}
    .folder-add-gate__notes{margin:0 0 4px 18px;padding:0;color:#4a5568}
    .folder-add-gate__notes li{margin:4px 0}
    .folder-add-gate__actions{display:flex;justify-content:flex-end;gap:8px;margin-top:16px}
    .folder-add-gate__actions button{border:1px solid #d8dee8;border-radius:6px;background:#fff;color:#172033;padding:8px 12px;font-weight:600}
    .folder-add-gate__actions button[data-action='add']{border-color:#172033;background:#172033;color:#fff}
    .folder-add-gate__actions button[disabled]{opacity:.5}
  `;
  document.head.append(style);
}

/**
 * Single-file pick-and-read for callers not yet migrated to the plural
 * `pickFilesForAdd`. Thin wrapper: picks the whole batch and returns its
 * first entry. Returns `null` when the user cancels.
 */
export async function pickFileForAdd(
  options: PickPdfsForAddOptions = {},
): Promise<FileAddResult | null> {
  const picked = await pickFilesForAdd(options);
  return picked?.[0] ?? null;
}

/** Shared honest-gate copy for above-threshold adds. */
export function tooLargeToAddMessage(name: string): string {
  return `"${name}" is too large to add here.`;
}

/** One entry the batch add flow did NOT add, with a short human reason. */
export interface FileAddFailure {
  name: string;
  reason: string;
}

/** Summary of a `pickFilesForAdd` batch: how many landed vs. why the rest didn't. */
export interface FileAddSummary {
  addedCount: number;
  totalCount: number;
  failures: readonly FileAddFailure[];
}

/**
 * Reduces a `pickFilesForAdd` batch to counts + per-file failure reasons.
 * `bytes` and `descriptor` results count as added; `tooLarge` and `error`
 * results are reported as failures without dropping the successes around them.
 */
export function summarizeFileAddResults(results: readonly FileAddResult[]): FileAddSummary {
  const failures: FileAddFailure[] = results.flatMap((result) => {
    if (result.kind === "tooLarge") {
      return [{ name: result.name, reason: "too large to add here" }];
    }
    if (result.kind === "error") {
      return [{ name: result.name, reason: result.message }];
    }
    return [];
  });

  return {
    addedCount: results.length - failures.length,
    totalCount: results.length,
    failures,
  };
}

/**
 * "N of M added; K failed: name (reason), name (reason)." Returns `null` when
 * there is nothing to report (no failures) so callers can fall back to their
 * normal success copy.
 */
export function fileAddBatchMessage(summary: FileAddSummary, noun = "file"): string | null {
  if (summary.failures.length === 0) {
    return null;
  }

  const plural = summary.failures.length === 1 ? noun : `${noun}s`;
  const names = summary.failures.map((failure) => `${failure.name} (${failure.reason})`).join(", ");

  if (summary.addedCount === 0) {
    return `${summary.failures.length} ${plural} could not be added: ${names}`;
  }

  return `${summary.addedCount} of ${summary.totalCount} added; ${summary.failures.length} failed: ${names}`;
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
  if (shouldRefuseWord(capability)) {
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
  // `preparing` deliberately avoids claiming that this batch launched Word.
  // macOS reuses one Word process for the whole batch and the process may
  // already have been open before RaioPDF started the conversion.
  phase?: "preparing" | "converting" | string;
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
  row.message = docxConversionProgressMessage(event.phase, event.index, event.total);
}

/**
 * Batch conversion state is intentionally neutral until the shell is actually
 * converting. In particular, do not say that RaioPDF is starting Word: Word
 * can already be running and macOS batches deliberately reuse that session.
 */
export function docxConversionProgressMessage(
  phase: string | undefined,
  index: number,
  total: number,
): string {
  return phase === "converting"
    ? `Converting ${index} of ${total}...`
    : `Preparing ${index} of ${total} for conversion in Microsoft Word...`;
}

interface DocxAddBatchResult {
  files: PickedPdfForAdd[];
  errors: DocxAddError[];
}

export interface DocxAddError {
  grant: string;
  name: string;
  code: string;
  message: string;
}

/** The first actionable Word failure for batch-add callers, if any. */
export function wordDocxAddErrorMessage(errors: readonly DocxAddError[]): string | null {
  for (const error of errors) {
    const guidance = wordOperationGuidance(error);
    if (guidance) {
      return guidance;
    }
  }
  return null;
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
  return `${wordUnavailableSummary(capability)} Word documents were not added.`;
}

/**
 * Markup-mode gate for the Word add flow. Built imperatively for the same
 * reason as `confirmFolderAdd` and, before the dialog-stack fix above, had
 * the identical defect: an unmanaged keyboard listener let Escape leak
 * through to close a `FloatingDialog` workspace underneath while this gate
 * stayed mounted. Now joins the shared stack via
 * `attachModalGateKeyboardHandling` too.
 */
export async function promptDocxMarkupMode(gate: DocxMarkupGate): Promise<DocxMarkupMode> {
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

    const finish = (mode: DocxMarkupMode): void => {
      dispose();
      host.remove();
      resolve(mode);
    };
    const currentChoice = (): DocxMarkupMode => {
      const checked = host.querySelector<HTMLInputElement>("input[name='docx-markup-mode']:checked");
      return checked?.value === "showMarkup" ? "showMarkup" : "final";
    };
    // No explicit "cancel" concept here (unlike the folder-add gate) -- the
    // add always proceeds, this gate only ever decides the markup mode. So
    // Escape resolves with whatever's currently selected, same as clicking
    // Continue -- it just also has to stop owning Escape/Tab so it doesn't
    // leak into the FloatingDialog workspace underneath.
    const dispose = attachModalGateKeyboardHandling(host, () => finish(currentChoice()));

    button?.addEventListener("click", () => finish(currentChoice()), { once: true });
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
