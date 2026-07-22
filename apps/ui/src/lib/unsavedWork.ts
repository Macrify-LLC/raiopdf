/**
 * The dirty aggregate behind the window-close and tab-close guards. Three
 * kinds of work can be lost when a document goes away:
 *
 * - `document.dirty` — committed-but-unsaved mutations (page ops, applied
 *   edits, applied text replacements). Tracked per tab.
 * - Pending annotation/form edits (`useEditing.hasUnsavedEdits`) — app-level
 *   state that only describes the ACTIVE tab.
 * - Drawn-but-unapplied redaction marks (`pendingRedactions`) — also
 *   active-tab-only app state.
 *
 * Background tabs park the last two in a switch-away snapshot
 * (`TabEditingSnapshot`, stored only when it holds restorable work), so "a
 * stashed snapshot exists" is the background-tab equivalent of "pending
 * edits or redaction marks". Pending edits also mark the document dirty via
 * the overlay-dirty effect, but redaction-only state never does — the
 * snapshot/redaction inputs here are what keep that case honest.
 */

export interface UnsavedWorkInput {
  /** `document.dirty` per open tab — every tab, not just the active one. */
  tabDirtyFlags: readonly boolean[];
  /**
   * Per tab: the document is backed only by a temp file (a derived/imported
   * doc staged to disk so it can print/OCR in full) and was never saved to a
   * real user file — closing loses it, even when it is otherwise clean. Per
   * tab, since a background tab holding such a doc must still block window
   * close.
   */
  tabTempBackedUnsavedFlags: readonly boolean[];
  /** Active tab's pending annotation/form edits (`useEditing.hasUnsavedEdits`). */
  activeTabHasPendingEdits: boolean;
  /** Active tab's drawn-but-unapplied redaction marks. */
  activeTabPendingRedactionCount: number;
  /**
   * Background tabs whose pending edits/redactions were stashed on
   * switch-away for restore on switch-back.
   */
  stashedBackgroundTabCount: number;
}

/** Whether closing the window right now would discard work. */
export function hasUnsavedWork(input: UnsavedWorkInput): boolean {
  return (
    input.tabDirtyFlags.some(Boolean) ||
    input.tabTempBackedUnsavedFlags.some(Boolean) ||
    input.activeTabHasPendingEdits ||
    input.activeTabPendingRedactionCount > 0 ||
    input.stashedBackgroundTabCount > 0
  );
}

export interface TabCloseConfirmInput {
  /** The closing tab's `document.dirty`. */
  tabDirty: boolean;
  /** Whether the closing tab is the visible (active) one. */
  isActiveTab: boolean;
  /** Active tab's pending annotation/form edits — only meaningful when `isActiveTab`. */
  activeTabHasPendingEdits: boolean;
  /** Active tab's unapplied redaction marks — only meaningful when `isActiveTab`. */
  activeTabPendingRedactionCount: number;
  /** Whether a switch-away snapshot holds this tab's pending work (background tabs). */
  tabHasStashedWork: boolean;
  /**
   * The closing tab is backed only by a temp file and was never saved to a real
   * user file — closing loses it even when it is otherwise clean.
   */
  tabTempBackedUnsaved: boolean;
}

/** Whether closing one tab needs a discard confirmation first. */
export function tabCloseNeedsConfirm(input: TabCloseConfirmInput): boolean {
  if (input.tabDirty || input.tabHasStashedWork || input.tabTempBackedUnsaved) {
    return true;
  }

  return (
    input.isActiveTab &&
    (input.activeTabHasPendingEdits || input.activeTabPendingRedactionCount > 0)
  );
}

/**
 * Confirm copy for the window-close guard. Mirrors the per-tab close
 * confirm's plain "discard unsaved changes?" voice.
 */
export const WINDOW_CLOSE_CONFIRM_MESSAGE =
  "Close RaioPDF and discard unsaved changes?";
