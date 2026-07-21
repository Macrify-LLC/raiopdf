/**
 * Native streaming print pipeline client (large-pdf v1.1, Lane F).
 *
 * Typed wrapper around the shell's print commands: any-size PDFs print
 * without the WebView ever holding the document. The shell drives
 * Ghostscript file→printer (`mswinpr2`), segment by segment, and falls back
 * automatically to a qpdf-split part queue handed to the OS print pipeline
 * when a Ghostscript invocation fails. Progress arrives as
 * `raiopdf-print-progress` events keyed by a client-minted job token;
 * cancellation is cooperative between segments/parts.
 *
 * Tauri-only (grants + spooler); callers gate on `isPathOpsRuntime()` like
 * every other path-based flow.
 */

import { parsePageRanges } from "./pageRanges";
import { invokePathOp } from "./pathOps";

// ---------------------------------------------------------------------------
// Response / event types (mirror apps/shell/src-tauri/src/print.rs)
// ---------------------------------------------------------------------------

export interface PrinterInfo {
  name: string;
  isDefault: boolean;
}

export interface PrintStatus {
  platformSupported: boolean;
  ghostscript: boolean;
  /** The single UI gate: platform + Ghostscript both present. */
  available: boolean;
}

export type PrintProgressPhase = "gs-segment" | "fallback-split" | "fallback-part";

export interface PrintProgressEvent {
  jobToken: string;
  phase: PrintProgressPhase;
  /** 1-based position within `total`. */
  current: number;
  total: number;
  /** 1-based page bounds; 0/0 for a whole-document invocation. */
  firstPage: number;
  lastPage: number;
}

export interface PrintResult {
  /** `ghostscript`/`printto` on Windows; `cups` on macOS (CUPS `lp`). */
  method: "ghostscript" | "printto" | "cups";
  gsInvocations: number;
  fallbackParts: number;
  fallbackReason: string | null;
  /** The file changed on disk mid-print — pages already printed, so this is
   * surfaced as a warning, never an error. */
  inputChanged: boolean;
}

export const PRINT_PROGRESS_EVENT = "raiopdf-print-progress";

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function printStatus(): Promise<PrintStatus> {
  return invokePathOp("print_status", {});
}

export function listPrinters(): Promise<PrinterInfo[]> {
  return invokePathOp("print_list_printers", {});
}

export function printPdf(
  grant: string,
  jobToken: string,
  printer: string,
  pageIndexes: readonly number[] | null,
  copies: number,
): Promise<PrintResult> {
  return invokePathOp("print_pdf", {
    grant,
    jobToken,
    printer,
    pageIndexes: pageIndexes === null ? null : [...pageIndexes],
    copies,
  });
}

export function cancelPrint(jobToken: string): Promise<boolean> {
  return invokePathOp("print_cancel", { jobToken });
}

/** Client-minted job token: the UI must know it before `print_pdf` resolves
 * so Cancel and progress filtering work mid-job. */
export function newPrintJobToken(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `print-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Subscribe to progress for one job. Returns the unlisten function. */
export async function listenPrintProgress(
  jobToken: string,
  onProgress: (event: PrintProgressEvent) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  return listen<PrintProgressEvent>(PRINT_PROGRESS_EVENT, (event) => {
    if (event.payload.jobToken === jobToken) {
      onProgress(event.payload);
    }
  });
}

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested)
// ---------------------------------------------------------------------------

export type PrintSelectionParse =
  | { ok: true; pageIndexes: number[] | null }
  | { ok: false; error: string };

/**
 * Parse the dialog's pages field: empty input means the whole document
 * (`null` — the shell needs no page count for it), anything else goes
 * through the shared `parsePageRanges` validation from #127.
 */
export function parsePrintSelection(
  input: string,
  pageCount: number,
): PrintSelectionParse {
  if (input.trim() === "") {
    return { ok: true, pageIndexes: null };
  }
  const parsed = parsePageRanges(input, pageCount);
  if (parsed.error !== null) {
    return { ok: false, error: parsed.error };
  }
  return { ok: true, pageIndexes: parsed.pageIndexes };
}

/** Copies field validation: whole number, 1–99. */
export function parseCopies(input: string): number | null {
  const trimmed = input.trim();
  if (!/^\d+$/.test(trimmed)) {
    return null;
  }
  const copies = Number(trimmed);
  return copies >= 1 && copies <= 99 ? copies : null;
}

/** Default printer first, then alphabetical — the picker's display order. */
export function sortPrintersForPicker(printers: readonly PrinterInfo[]): PrinterInfo[] {
  return [...printers].sort((a, b) => {
    if (a.isDefault !== b.isDefault) {
      return a.isDefault ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

/** Human-readable progress line ("Printing part 2 of 17"). */
export function describePrintProgress(event: PrintProgressEvent): string {
  const pages = event.firstPage > 0
    ? event.firstPage === event.lastPage
      ? `page ${event.firstPage}`
      : `pages ${event.firstPage}–${event.lastPage}`
    : "all pages";

  switch (event.phase) {
    case "gs-segment":
      return event.total === 1
        ? `Printing ${pages}...`
        : `Printing ${pages} (${event.current} of ${event.total})...`;
    case "fallback-split":
      return `Preparing part ${event.current} of ${event.total} (${pages})...`;
    case "fallback-part":
      return `Printing part ${event.current} of ${event.total} (${pages})...`;
  }
}
