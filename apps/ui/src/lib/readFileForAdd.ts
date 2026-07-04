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
 * SHELL COMMAND CONTRACTS (Lane A -- graceful fallbacks below until they land):
 * - `pick_pdfs_for_add(multiple)` -> `[{ grant, name, sizeBytes }]` multi-select
 *   picker with NO eager byte read [R5-1].
 * - `read_pdf_range(grant, offset, length)` -> raw binary response; per-call
 *   length cap is max(4 MB, threshold), so a whole below-threshold file fits in
 *   one call [R6-2].
 * - `page_count(grant)` -> number (qpdf --show-npages) [R2-3].
 */
import {
  filePort,
  isTauriRuntime,
  pickBrowserFile,
  readBrowserFile,
  toUint8Array,
  type BinaryInvokeResponse,
  type OpenedFile,
} from "./filePort";
import { getLargeDocThresholdBytes } from "./largeDocThreshold";

/** Contract of one entry returned by the shell's `pick_pdfs_for_add` command. */
export interface PickedPdfForAdd {
  grant: string;
  name: string;
  sizeBytes: number;
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
  options: { multiple?: boolean } = {},
): Promise<PickedPdfForAdd[] | null> {
  if (!isTauriRuntime()) {
    return null;
  }

  const { invoke } = await import("@tauri-apps/api/core");

  try {
    const picked = await invoke<PickedPdfForAdd[] | null>("pick_pdfs_for_add", {
      multiple: options.multiple ?? false,
    });
    return picked ?? [];
  } catch (error) {
    if (isMissingCommandError(error, "pick_pdfs_for_add")) {
      // FALLBACK (pre-Lane-A): the command isn't registered yet.
      return null;
    }

    throw error;
  }
}

/**
 * Single-file pick-and-read for the package add flows (Production Set, Batch
 * Cleanup, Filing Packet). Uses `pick_pdfs_for_add` + `readFileForAdd` when the
 * shell command exists. Returns `null` when the user cancels.
 *
 * FALLBACK (pre-Lane-A, clearly scoped): until `pick_pdfs_for_add` lands, the
 * Tauri branch has no other grant-returning picker than the legacy
 * main-document dialog, so it calls `filePort.openFile()` (eager byte read --
 * today's behavior) and size-gates AFTER the read: above-threshold results are
 * demoted to a grant descriptor (bytes discarded, so no pdf-lib load ever runs
 * on them). Delete this branch when Lane A ships the picker command.
 */
export async function pickFileForAdd(): Promise<FileAddResult | null> {
  if (!isTauriRuntime()) {
    // Browser: pick the DOM File ourselves so the size check runs BEFORE any
    // read [R2-4].
    const file = await pickBrowserFile();
    return file ? readFileForAdd(file) : null;
  }

  const picks = await pickPdfsForAdd({ multiple: false });

  if (picks !== null) {
    const pick = picks[0];
    return pick ? readFileForAdd(pick) : null;
  }

  const opened = await filePort.openFile();

  if (!opened) {
    return null;
  }

  const sizeBytes = opened.bytes.byteLength;

  if (sizeBytes <= getLargeDocThresholdBytes()) {
    return { kind: "bytes", file: opened };
  }

  if (opened.path !== null) {
    return {
      kind: "descriptor",
      descriptor: {
        grant: opened.path,
        name: opened.name,
        sizeBytes,
        pageCount: await tryPageCountByGrant(opened.path),
      },
    };
  }

  return { kind: "tooLarge", name: opened.name, sizeBytes };
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
  const { invoke } = await import("@tauri-apps/api/core");
  const bytes = await invoke<BinaryInvokeResponse>("read_pdf_range", {
    grant,
    offset: 0,
    length: sizeBytes,
  });

  return toUint8Array(bytes);
}

/**
 * `page_count(grant)` when available; `null` when the command is missing
 * (pre-Lane-A shell) or the count fails -- callers treat null as "deferred".
 */
async function tryPageCountByGrant(grant: string): Promise<number | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const count = await invoke<number>("page_count", { grant });
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
