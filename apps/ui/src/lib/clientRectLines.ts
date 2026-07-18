export interface ClientRectLine {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Merges a selection's client rects into one box per visual line. The browser
 * reports a rect per text node; pdf.js text layers fragment lines into many
 * (often overlapping) runs, so painting the raw rects double-tints overlaps
 * and looks ragged. Runs are unioned when they overlap vertically by more
 * than half a line AND are horizontally contiguous — a wide horizontal gap is
 * a multi-column gutter, and merging across it would paint the whitespace
 * between the columns (a normal inter-word gap is well under one line height).
 */
export function mergeClientRectsIntoLines(rects: readonly DOMRect[]): ClientRectLine[] {
  const sorted = [...rects].sort((left, right) => left.top - right.top || left.left - right.left);
  const lines: ClientRectLine[] = [];

  for (const rect of sorted) {
    const line = lines.find((candidate) => {
      const lineHeight = Math.min(candidate.bottom - candidate.top, rect.height);
      const verticalOverlap =
        Math.min(candidate.bottom, rect.bottom) - Math.max(candidate.top, rect.top);

      if (verticalOverlap <= lineHeight * 0.5) {
        return false;
      }

      const horizontalGap = Math.max(rect.left - candidate.right, candidate.left - rect.right, 0);
      return horizontalGap <= lineHeight;
    });

    if (line) {
      line.left = Math.min(line.left, rect.left);
      line.right = Math.max(line.right, rect.right);
      line.top = Math.min(line.top, rect.top);
      line.bottom = Math.max(line.bottom, rect.bottom);
    } else {
      lines.push({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom });
    }
  }

  return lines;
}
