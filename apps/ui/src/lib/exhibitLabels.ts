/**
 * Exhibit label formatting, shared by the binder builder (which labels a whole
 * set at once from a running index) and exhibit stamp templates (which label
 * one sticker at a time from a stored counter).
 *
 * An exhibit's identity is a zero-based `index`; everything user-visible is
 * derived from it. `formatExhibitIdentifier` renders the index, `parseIdentifier`
 * is its inverse so a user can type where the counter should resume, and
 * `formatExhibitLabel` / `exhibitLabelLines` assemble the displayed text.
 */

/** How an exhibit's position in its set is rendered. `none` omits it entirely. */
export type ExhibitIdentifierStyle = "letters" | "numbers" | "none";

/** Whether prefix and identifier render on one line or stacked on two. */
export type ExhibitLabelLayout = "stacked" | "inline";

/** Used when a caller supplies a blank prefix. */
export const DEFAULT_EXHIBIT_PREFIX = "Exhibit";

/**
 * Largest index `parseIdentifier` will return. Anything beyond it is treated as
 * garbage rather than accepted and silently rendered as a 5-letter label — no
 * real exhibit set runs past a million, and the bound keeps a pasted digit
 * string from becoming an absurd counter.
 */
export const MAX_EXHIBIT_INDEX = 999_999;

/** Renders a zero-based index in the requested style. `none` yields "". */
export function formatExhibitIdentifier(
  identifierStyle: ExhibitIdentifierStyle,
  index: number,
): string {
  switch (identifierStyle) {
    case "letters":
      return toLetters(index);
    case "numbers":
      return String(index + 1);
    case "none":
      return "";
  }
}

/**
 * The single-line label for one exhibit: prefix, identifier, and optional
 * suffix, joined by single spaces with empty parts dropped.
 */
export function formatExhibitLabel(
  prefix: string,
  identifierStyle: ExhibitIdentifierStyle,
  index: number,
  suffix?: string,
): string {
  return exhibitLabelParts(prefix, identifierStyle, index, suffix).join(" ");
}

/**
 * The rendered lines for one exhibit label. `inline` is the single-line form;
 * `stacked` breaks after the prefix so the identifier sits on its own line —
 * the shape of a printed exhibit sticker.
 */
export function exhibitLabelLines(
  prefix: string,
  identifierStyle: ExhibitIdentifierStyle,
  index: number,
  layout: ExhibitLabelLayout,
  suffix?: string,
): string[] {
  const parts = exhibitLabelParts(prefix, identifierStyle, index, suffix);

  if (layout === "inline" || parts.length < 2) {
    return [parts.join(" ")];
  }

  const [head, ...rest] = parts;

  return [head ?? "", rest.join(" ")];
}

/** Spreadsheet-style letters for a zero-based index: 0 → A, 25 → Z, 26 → AA. */
export function toLetters(index: number): string {
  let value = index + 1;
  let label = "";

  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }

  return label;
}

/**
 * Inverse of `formatExhibitIdentifier`: turns what a user typed back into a
 * zero-based index. `"12"` → 11, `"AB"` → 27. Returns null for anything that
 * isn't a clean all-digits or all-letters identifier in range, so a caller can
 * reject the input instead of guessing at it.
 */
export function parseIdentifier(rawText: string): number | null {
  const text = rawText.trim();

  if (text.length === 0) {
    return null;
  }

  if (/^\d+$/.test(text)) {
    const ordinal = Number(text);

    if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
      return null;
    }

    return inRange(ordinal - 1);
  }

  if (!/^[A-Za-z]+$/.test(text)) {
    return null;
  }

  let ordinal = 0;

  for (const character of text.toUpperCase()) {
    ordinal = ordinal * 26 + (character.charCodeAt(0) - 64);

    if (ordinal > MAX_EXHIBIT_INDEX + 1) {
      return null;
    }
  }

  return inRange(ordinal - 1);
}

function inRange(index: number): number | null {
  return index >= 0 && index <= MAX_EXHIBIT_INDEX ? index : null;
}

function exhibitLabelParts(
  prefix: string,
  identifierStyle: ExhibitIdentifierStyle,
  index: number,
  suffix?: string,
): string[] {
  const cleanPrefix = prefix.trim() || DEFAULT_EXHIBIT_PREFIX;
  const identifier = formatExhibitIdentifier(identifierStyle, index);
  const cleanSuffix = suffix?.trim() ?? "";

  return [cleanPrefix, identifier, cleanSuffix].filter((part) => part.length > 0);
}
