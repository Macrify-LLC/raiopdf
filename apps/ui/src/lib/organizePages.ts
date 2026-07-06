/**
 * Page-reorder math for the Organize grid's drag-and-drop.
 *
 * Kept as a pure function (separate from the component) so the drop-position
 * logic is unit-testable: the bug it fixes was an insert-index that always
 * placed the moved page(s) *before* the target, making an adjacent forward
 * drag ("drop just after the next page") a silent no-op.
 */
export function reorderPagesForDrop(
  pageOrder: readonly number[],
  moving: readonly number[],
  targetPageIndex: number,
  side: "before" | "after",
): number[] {
  const movingSet = new Set(moving);
  const remaining = pageOrder.filter((pageIndex) => !movingSet.has(pageIndex));
  const targetInRemaining = remaining.indexOf(targetPageIndex);
  const insertIndex =
    targetInRemaining === -1
      ? remaining.length
      : targetInRemaining + (side === "after" ? 1 : 0);

  return [
    ...remaining.slice(0, insertIndex),
    ...moving,
    ...remaining.slice(insertIndex),
  ];
}
