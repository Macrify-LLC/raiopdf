/**
 * True when `target` sits inside a form control or a contenteditable
 * region. Global keyboard shortcuts (zoom, Delete/Backspace, etc.) must not
 * fire while the user is typing into one of these.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
}
