import type { FileGrant } from "./filePort";

/**
 * How an engine operation (OCR, PDF/A, compress, redaction) on the *current*
 * document should reach the engine.
 *
 * - `path-ops`: run file→file through the shell (Tauri IPC + a file grant). The
 *   document bytes never cross into the WebView, so it survives the WebView2
 *   loopback request-body size limit that breaks in-memory engine ops on
 *   Chromium 150. This is how streamed/large docs already run; this module
 *   makes it reachable for clean memory-mode docs opened from a file too.
 * - `save-first`: the document is memory-mode with a file grant but has unsaved
 *   changes, so the on-disk file the grant points at is NOT what the user sees.
 *   The caller must save first (which writes the in-memory bytes to disk and
 *   mints a *fresh* grant) and then run through `path-ops` with that new grant.
 * - `loopback`: no usable grant (browser open / derived-in-app doc). Fall back
 *   to the in-memory byte path. Works below the ~1MB WebView2 body limit; large
 *   docs fail there honestly.
 */
export type EngineOpRoute =
  | { via: "path-ops"; grant: FileGrant }
  | { via: "save-first" }
  | { via: "loopback" };

export interface EngineOpRouteInputs {
  /** True in the packaged/desktop (Tauri) runtime. Grants only exist there. */
  isTauriRuntime: boolean;
  /** `document.source.kind`, or null when no document is open. */
  sourceKind: "memory" | "rangeGrant" | "rangeFile" | null;
  /**
   * The streamed-doc path grant (App's `pathOpsGrant`): non-null only for
   * range-backed (streamed/large) documents. Streamed docs already route
   * through path_ops; passing it through keeps that behavior unchanged.
   */
  streamedGrant: FileGrant | null;
  /**
   * `document.filePath`. For a Tauri memory-mode open this holds the opaque
   * shell file grant (see `filePort.ts` — memory opens set `path: fileGrant`);
   * for a browser open it is null. Typed `string | null` because the document
   * model does not brand it — the runtime + source-kind guard is what makes it
   * safe to treat as a grant.
   */
  memoryFilePath: string | null;
  /**
   * `document.tempBackingGrant`: a temp file on disk holding the current bytes
   * of an in-memory / derived document (extracted range, exhibit binder, OCR
   * output, Word import, …). Distinct from `memoryFilePath` (the user's real
   * saved file) — it gives a derived doc a path-ops grant so it prints/OCRs in
   * full, while the document stays logically unsaved. Null when there is no
   * backing (web build, staging failed, or an opened-from-disk doc that already
   * carries a real grant).
   */
  memoryBackingGrant: FileGrant | null;
  /** `document.dirty`: an in-place mutation is pending (not yet on disk). */
  dirty: boolean;
  /** `editing.hasUnsavedEdits`: overlay annotations/form edits not yet applied. */
  hasUnsavedEdits: boolean;
}

/**
 * Decide how to run an engine op on the current document. Pure and total so it
 * can be exhaustively unit-tested.
 *
 * The dirty/unsaved gate is deliberately separate from the shell's open-time
 * snapshot guard: the snapshot guard catches *external* on-disk changes, but a
 * memory-mode doc's unsaved edits live only in the WebView — the on-disk file
 * still matches its open snapshot — so path_ops would silently process the
 * pre-edit bytes. Only `dirty`/`hasUnsavedEdits` catch that.
 */
export function resolveEngineOpRoute(input: EngineOpRouteInputs): EngineOpRoute {
  // Streamed/range-backed docs already carry a path-ops grant. Unchanged.
  if (input.streamedGrant) {
    return { via: "path-ops", grant: input.streamedGrant };
  }

  // A memory-mode doc reaches path_ops through the user's real file grant
  // (`memoryFilePath`, opened-from-disk) OR, for a derived/in-memory doc, its
  // temp backing (`memoryBackingGrant`). The real file wins when both exist.
  const memoryGrant: FileGrant | null =
    input.isTauriRuntime && input.sourceKind === "memory"
      ? ((input.memoryFilePath as FileGrant | null) ?? input.memoryBackingGrant)
      : null;

  if (!memoryGrant) {
    return { via: "loopback" };
  }

  if (input.dirty || input.hasUnsavedEdits) {
    return { via: "save-first" };
  }

  return { via: "path-ops", grant: memoryGrant };
}
