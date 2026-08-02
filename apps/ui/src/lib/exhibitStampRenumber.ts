import type { PdfStampSequence } from "@raiopdf/engine-api";
import type { PendingEdit, PendingExhibitStamp } from "./edits";
import { exhibitLabelLines } from "./exhibitLabels";
import type { PDFDocumentProxy } from "./pdfjs";
import { pdfRectToViewportRect } from "./viewportGeometry";

/**
 * Renumbering every stamp of one design across the open document.
 *
 * The order has to be the order a reader sees, not the order the stamps were
 * placed or stored: someone who stamped page 4 before page 2, or dropped a
 * second sticker above the first, still expects Exhibit 1 to be the topmost
 * one on the earliest page. So the sort runs in VISUAL space — the upright
 * page after its rotation and crop box — and only then falls back to raw
 * user-space geometry when a page's measurements can't be read.
 */

/** A placed stamp carrying the provenance a renumber needs. */
export type RenumberableStamp = PendingExhibitStamp & {
  templateId: string;
  sequence: PdfStampSequence;
};

/** Visual (upright, top-left origin) placement of one stamp, in points. */
export interface StampVisualRect {
  left: number;
  top: number;
  height: number;
}

/** Visual placements keyed by pending-edit id. */
export type StampVisualRects = ReadonlyMap<string, StampVisualRect>;

/** One stamp's new position in the set, with its label already rendered. */
export interface ExhibitStampRenumberStep {
  id: string;
  /** Zero-based position in the renumbered set. */
  index: number;
  lines: string[];
}

/**
 * Two stickers count as the same visual line when their tops are within this
 * fraction of the taller one's height — the same "is this the same row" test
 * the text-markup line clustering uses. A sticker nudged a few points up or
 * down still reads left-to-right with its neighbor.
 */
const ROW_TOLERANCE_FRACTION = 0.6;
const ROW_TOLERANCE_FLOOR_PT = 4;

/**
 * Every stamp of one design that a renumber may rewrite, in the order they
 * are held in state — placed drafts AND stamps imported from the file, since
 * both are the same live objects to the user. A stamp whose provenance was
 * stripped is skipped: it can still be moved, just not re-lettered.
 */
export function renumberableStamps(
  edits: readonly PendingEdit[],
  templateId: string,
): RenumberableStamp[] {
  return edits.filter(
    (edit): edit is RenumberableStamp =>
      edit.kind === "stamp" && edit.templateId === templateId && Boolean(edit.sequence),
  );
}

/**
 * Measures each stamp against its page's upright viewport, which is where
 * page rotation and the crop box are already accounted for — the same pdf.js
 * viewport mapping the editing overlay positions stickers with, so what the
 * sort calls "first" is what the user sees first.
 *
 * A page that can't be measured is simply left out; `planExhibitStampRenumber`
 * falls back to user-space geometry for those rather than refusing to run.
 */
export async function readStampVisualRects(
  pdfDocument: PDFDocumentProxy | null,
  stamps: readonly RenumberableStamp[],
): Promise<StampVisualRects> {
  const rects = new Map<string, StampVisualRect>();

  if (!pdfDocument) {
    return rects;
  }

  const pageIndexes = [...new Set(stamps.map((stamp) => stamp.pageIndex))];

  for (const pageIndex of pageIndexes) {
    try {
      const page = await pdfDocument.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: 1 });

      for (const stamp of stamps) {
        if (stamp.pageIndex !== pageIndex) {
          continue;
        }

        const rect = pdfRectToViewportRect(stamp.rect, viewport);

        rects.set(stamp.id, { left: rect.left, top: rect.top, height: rect.height });
      }
    } catch {
      // Unreadable page — the user-space fallback covers its stamps.
    }
  }

  return rects;
}

/**
 * Assigns each stamp its new position in the set: reading order first, then a
 * running index from `startIndex`. Each label is rebuilt from that stamp's own
 * recorded sequence, so a sticker keeps the wording and layout it was placed
 * with and only its number changes.
 */
export function planExhibitStampRenumber(
  stamps: readonly RenumberableStamp[],
  visualRects: StampVisualRects,
  startIndex: number,
): ExhibitStampRenumberStep[] {
  const positioned = stamps.map((stamp, order) => ({
    stamp,
    order,
    ...(visualRects.get(stamp.id) ?? userSpaceVisualRect(stamp)),
  }));

  return readingOrder(positioned).map((entry, position) => {
    const index = startIndex + position;
    const sequence = entry.stamp.sequence;

    return {
      id: entry.stamp.id,
      index,
      lines: exhibitLabelLines(
        sequence.prefix,
        sequence.identifierStyle,
        index,
        sequence.layout,
        sequence.suffix,
      ),
    };
  });
}

/** Applies one planned step to a stamp, leaving everything else alone. */
export function applyExhibitStampRenumberStep(
  edit: PendingEdit,
  step: ExhibitStampRenumberStep,
): PendingEdit {
  if (edit.kind !== "stamp" || !edit.sequence) {
    return edit;
  }

  return {
    ...edit,
    lines: step.lines,
    sequence: { ...edit.sequence, index: step.index },
  };
}

interface PositionedStamp {
  stamp: RenumberableStamp;
  order: number;
  left: number;
  top: number;
  height: number;
}

/**
 * Page by page, top row to bottom row, left to right within a row. Rows are
 * clustered rather than compared with a tolerant comparator, because a
 * "close enough" comparator isn't transitive and can make the sort itself
 * inconsistent. Ties inside a row fall back to the original order so the
 * result is stable.
 */
function readingOrder(entries: readonly PositionedStamp[]): PositionedStamp[] {
  const pageIndexes = [...new Set(entries.map((entry) => entry.stamp.pageIndex))].sort(
    (left, right) => left - right,
  );

  return pageIndexes.flatMap((pageIndex) => {
    const pageEntries = entries
      .filter((entry) => entry.stamp.pageIndex === pageIndex)
      .sort((left, right) =>
        left.top - right.top || left.left - right.left || left.order - right.order,
      );
    const rows: PositionedStamp[][] = [];

    for (const entry of pageEntries) {
      const row = rows.at(-1);
      const rowTop = row?.[0]?.top;
      const rowHeight = row ? Math.max(...row.map((member) => member.height)) : 0;
      const tolerance =
        Math.max(rowHeight, entry.height, ROW_TOLERANCE_FLOOR_PT) * ROW_TOLERANCE_FRACTION;

      if (row && rowTop !== undefined && entry.top - rowTop <= tolerance) {
        row.push(entry);
      } else {
        rows.push([entry]);
      }
    }

    return rows.flatMap((row) =>
      [...row].sort((left, right) => left.left - right.left || left.order - right.order),
    );
  });
}

/**
 * The unrotated stand-in for a stamp whose page couldn't be measured: PDF
 * user space with the y axis flipped, which is exactly the visual box on a
 * page with no rotation and no crop-box offset.
 */
function userSpaceVisualRect(stamp: RenumberableStamp): StampVisualRect {
  return {
    left: stamp.rect.x,
    top: -(stamp.rect.y + stamp.rect.h),
    height: stamp.rect.h,
  };
}
