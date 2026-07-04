import type { PdfEditRect } from "@raiopdf/engine-api";
import { extractTextBoxesByPage, type PdfTextBoxItem, type PdfTextBoxPage } from "./pdfjs-node.js";

export type LocatedMatch = {
  pageIndex: number;
  page: number;
  snippet: string;
  rects: PdfEditRect[];
  score: number;
};

export type LocateTextOptions = {
  caseSensitive?: boolean | undefined;
  wholeWord?: boolean | undefined;
  pages?: readonly number[] | undefined;
  fuzzy?: boolean | undefined;
  minScore?: number | undefined;
};

type RawChar = {
  char: string;
  itemIndex?: number;
  offset?: number;
};

type NormalizedPage = {
  text: string;
  map: RawChar[];
};

type SearchMatch = {
  start: number;
  end: number;
  score: number;
};

const LIGATURES: Record<string, string> = {
  "\uFB00": "ff",
  "\uFB01": "fi",
  "\uFB02": "fl",
  "\uFB03": "ffi",
  "\uFB04": "ffl",
};

const PUNCTUATION: Record<string, string> = {
  "\u2018": "'",
  "\u2019": "'",
  "\u201A": "'",
  "\u201B": "'",
  "\u201C": '"',
  "\u201D": '"',
  "\u201E": '"',
  "\u201F": '"',
  "\u2013": "-",
  "\u2014": "-",
  "\u2212": "-",
};

export async function locateText(
  bytes: Uint8Array,
  query: string,
  options: LocateTextOptions = {},
): Promise<LocatedMatch[]> {
  const pages = await extractTextBoxesByPage(bytes);
  return locateTextInPages(pages, query, options);
}

export function locateTextInPages(
  pages: readonly PdfTextBoxPage[],
  query: string,
  options: LocateTextOptions = {},
): LocatedMatch[] {
  const normalizedQuery = normalizeString(query, options);
  if (normalizedQuery.length === 0) {
    return [];
  }

  const pageFilter = options.pages === undefined ? undefined : new Set(options.pages);
  const matches: LocatedMatch[] = [];

  for (const page of pages) {
    if (pageFilter !== undefined && !pageFilter.has(page.pageIndex)) {
      continue;
    }

    const raw = buildRawPage(page.items);
    const normalized = normalizeRaw(raw, options);
    const exactMatches = findExactMatches(normalized.text, normalizedQuery, options.wholeWord ?? false);
    const searchMatches = exactMatches.length > 0 || options.fuzzy !== true
      ? exactMatches
      : findFuzzyMatches(normalized.text, normalizedQuery, options.minScore ?? 0.85, options.wholeWord ?? false);

    if (searchMatches.length === 0 && options.fuzzy !== true) {
      searchMatches.push(...findSpacelessMatches(normalized.text, normalizedQuery, options.wholeWord ?? false));
    }

    for (const match of searchMatches) {
      const rects = rectsForRange(page.items, normalized.map.slice(match.start, match.end));
      if (rects.length === 0) {
        continue;
      }

      matches.push({
        pageIndex: page.pageIndex,
        page: page.pageIndex + 1,
        snippet: snippetFor(normalized.text, match.start, match.end),
        rects,
        score: match.score,
      });
    }
  }

  return matches;
}

function buildRawPage(items: readonly PdfTextBoxItem[]): RawChar[] {
  const chars: RawChar[] = [];
  for (const [itemIndex, item] of items.entries()) {
    for (let offset = 0; offset < item.str.length; offset += 1) {
      chars.push({ char: item.str[offset] ?? "", itemIndex, offset });
    }

    const next = items[itemIndex + 1];
    const separator = inferItemSeparator(item, next);
    if (separator !== "") {
      chars.push({ char: separator });
    }
  }

  return chars;
}

function inferItemSeparator(current: PdfTextBoxItem, next: PdfTextBoxItem | undefined): "" | " " | "\n" {
  if (
    next === undefined ||
    current.str.length === 0 ||
    next.str.length === 0 ||
    /\s$/.test(current.str) ||
    /^\s/.test(next.str)
  ) {
    return "";
  }

  if (current.hasEOL) {
    return "\n";
  }

  const lineThreshold = Math.max(current.rect.h, next.rect.h, 8) * 0.5;
  if (Math.abs(current.rect.y - next.rect.y) > lineThreshold) {
    return "";
  }

  const gap = next.rect.x - (current.rect.x + current.rect.w);
  const spaceThreshold = Math.max(1, Math.max(current.rect.h, next.rect.h, 8) * 0.15);

  return gap > spaceThreshold ? " " : "";
}

function normalizeString(input: string, options: LocateTextOptions): string {
  return normalizeRaw(Array.from(input, (char) => ({ char })), options).text;
}

function normalizeRaw(raw: readonly RawChar[], options: LocateTextOptions): NormalizedPage {
  const text: string[] = [];
  const map: RawChar[] = [];
  let pendingSpace: RawChar | undefined;

  for (let index = 0; index < raw.length; index += 1) {
    const source = raw[index];
    if (source === undefined) {
      continue;
    }

    if (isSoftHyphen(source.char)) {
      continue;
    }

    if (source.char === "-" && isHyphenatedLineBreak(raw, index)) {
      index = skipLineBreak(raw, index + 1) - 1;
      continue;
    }

    const folded = foldChar(source.char, options);
    if (folded.length === 0) {
      continue;
    }

    if (/^\s+$/.test(folded)) {
      pendingSpace ??= source;
      continue;
    }

    if (pendingSpace !== undefined && text.length > 0) {
      text.push(" ");
      map.push(pendingSpace);
    }
    pendingSpace = undefined;

    for (const char of folded) {
      text.push(char);
      map.push(source);
    }
  }

  while (text.at(-1) === " ") {
    text.pop();
    map.pop();
  }

  return { text: text.join(""), map };
}

function foldChar(char: string, options: LocateTextOptions): string {
  const normalized = (LIGATURES[char] ?? PUNCTUATION[char] ?? char).normalize("NFC");
  return options.caseSensitive === true ? normalized : normalized.toLocaleLowerCase();
}

function isSoftHyphen(char: string): boolean {
  return char === "\u00AD";
}

function isHyphenatedLineBreak(raw: readonly RawChar[], hyphenIndex: number): boolean {
  const previous = previousNonWhitespace(raw, hyphenIndex - 1);
  const nextLineBreak = skipHorizontalWhitespace(raw, hyphenIndex + 1);
  if (!isLineBreak(raw[nextLineBreak]?.char)) {
    return false;
  }
  const next = nextNonWhitespace(raw, nextLineBreak + 1);
  return isWordChar(previous?.char) && isWordChar(next?.char);
}

function skipHorizontalWhitespace(raw: readonly RawChar[], index: number): number {
  let cursor = index;
  while (cursor < raw.length) {
    const char = raw[cursor]?.char;
    if (char !== " " && char !== "\t") {
      break;
    }
    cursor += 1;
  }
  return cursor;
}

function skipLineBreak(raw: readonly RawChar[], index: number): number {
  let cursor = skipHorizontalWhitespace(raw, index);
  if (raw[cursor]?.char === "\r" && raw[cursor + 1]?.char === "\n") {
    cursor += 2;
  } else if (isLineBreak(raw[cursor]?.char)) {
    cursor += 1;
  }
  return skipHorizontalWhitespace(raw, cursor);
}

function previousNonWhitespace(raw: readonly RawChar[], index: number): RawChar | undefined {
  for (let cursor = index; cursor >= 0; cursor -= 1) {
    const char = raw[cursor]?.char;
    if (char !== undefined && !/\s/.test(char)) {
      return raw[cursor];
    }
  }
  return undefined;
}

function nextNonWhitespace(raw: readonly RawChar[], index: number): RawChar | undefined {
  for (let cursor = index; cursor < raw.length; cursor += 1) {
    const char = raw[cursor]?.char;
    if (char !== undefined && !/\s/.test(char)) {
      return raw[cursor];
    }
  }
  return undefined;
}

function isLineBreak(char: string | undefined): boolean {
  return char === "\n" || char === "\r";
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

function findExactMatches(
  haystack: string,
  needle: string,
  wholeWord: boolean,
): SearchMatch[] {
  const matches: SearchMatch[] = [];
  let start = 0;
  while (start <= haystack.length) {
    const index = haystack.indexOf(needle, start);
    if (index === -1) {
      break;
    }
    const end = index + needle.length;
    if (!wholeWord || hasWordBoundaries(haystack, index, end)) {
      matches.push({ start: index, end, score: 1 });
    }
    start = Math.max(index + 1, end);
  }
  return matches;
}

function findSpacelessMatches(
  haystack: string,
  needle: string,
  wholeWord: boolean,
): SearchMatch[] {
  const compactHaystack = compactSpaces(haystack);
  const compactNeedle = compactSpaces(needle);
  if (compactNeedle.text.length === 0) {
    return [];
  }

  const matches: SearchMatch[] = [];
  for (const match of findExactMatches(compactHaystack.text, compactNeedle.text, false)) {
    const start = compactHaystack.map[match.start];
    const end = compactHaystack.map[match.end - 1];
    if (start === undefined || end === undefined) {
      continue;
    }
    const normalizedEnd = end + 1;
    if (!wholeWord || hasWordBoundaries(haystack, start, normalizedEnd)) {
      matches.push({ start, end: normalizedEnd, score: 1 });
    }
  }
  return matches;
}

function compactSpaces(text: string): { text: string; map: number[] } {
  const chars: string[] = [];
  const map: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === " ") {
      continue;
    }
    chars.push(char ?? "");
    map.push(index);
  }
  return { text: chars.join(""), map };
}

function hasWordBoundaries(text: string, start: number, end: number): boolean {
  return !isWordChar(text[start - 1]) && !isWordChar(text[end]);
}

function findFuzzyMatches(
  haystack: string,
  needle: string,
  minScore: number,
  wholeWord: boolean,
): SearchMatch[] {
  const matches: SearchMatch[] = [];
  const needleLength = needle.length;
  const minLength = Math.max(1, Math.floor(needleLength * 0.85));
  const maxLength = Math.max(minLength, Math.ceil(needleLength * 1.15));

  for (let start = 0; start < haystack.length; start += 1) {
    for (let length = minLength; length <= maxLength && start + length <= haystack.length; length += 1) {
      const end = start + length;
      if (wholeWord && !hasWordBoundaries(haystack, start, end)) {
        continue;
      }
      const candidate = haystack.slice(start, end);
      const score = levenshteinRatio(candidate, needle);
      if (score >= minScore) {
        matches.push({ start, end, score });
      }
    }
  }

  return pruneOverlapping(matches);
}

function levenshteinRatio(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) {
    return 1;
  }

  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let row = 1; row <= a.length; row += 1) {
    current[0] = row;
    for (let column = 1; column <= b.length; column += 1) {
      const cost = a[row - 1] === b[column - 1] ? 0 : 1;
      current[column] = Math.min(
        previous[column]! + 1,
        current[column - 1]! + 1,
        previous[column - 1]! + cost,
      );
    }
    for (let index = 0; index < previous.length; index += 1) {
      previous[index] = current[index] ?? 0;
    }
  }

  const distance = previous[b.length] ?? 0;
  return 1 - distance / Math.max(a.length, b.length);
}

function pruneOverlapping(matches: readonly SearchMatch[]): SearchMatch[] {
  const selected: SearchMatch[] = [];
  const sorted = [...matches].sort((a, b) => b.score - a.score || a.start - b.start);

  for (const match of sorted) {
    if (selected.some((existing) => rangesOverlap(match, existing))) {
      continue;
    }
    selected.push(match);
  }

  return selected.sort((a, b) => a.start - b.start);
}

function rangesOverlap(a: SearchMatch, b: SearchMatch): boolean {
  return a.start < b.end && b.start < a.end;
}

function rectsForRange(items: readonly PdfTextBoxItem[], chars: readonly RawChar[]): PdfEditRect[] {
  const spans = new Map<number, { start: number; end: number }>();

  for (const char of chars) {
    if (char.itemIndex === undefined || char.offset === undefined) {
      continue;
    }
    const current = spans.get(char.itemIndex);
    const end = char.offset + 1;
    if (current === undefined) {
      spans.set(char.itemIndex, { start: char.offset, end });
    } else {
      current.start = Math.min(current.start, char.offset);
      current.end = Math.max(current.end, end);
    }
  }

  const rects = [...spans.entries()]
    .map(([itemIndex, span]) => partialRect(items[itemIndex], span))
    .filter((rect): rect is PdfEditRect => rect !== undefined)
    .sort((a, b) => b.y - a.y || a.x - b.x);

  return unionByLine(rects);
}

function partialRect(
  item: PdfTextBoxItem | undefined,
  span: { start: number; end: number },
): PdfEditRect | undefined {
  if (item === undefined || item.str.length === 0) {
    return undefined;
  }

  const start = Math.max(0, Math.min(item.str.length, span.start));
  const end = Math.max(start, Math.min(item.str.length, span.end));
  const widthPerChar = item.rect.w / item.str.length;
  const x = item.rect.x + start * widthPerChar;
  const w = Math.max(0.01, (end - start) * widthPerChar);
  return { x, y: item.rect.y, w, h: item.rect.h };
}

function unionByLine(rects: readonly PdfEditRect[]): PdfEditRect[] {
  const lines: PdfEditRect[][] = [];
  for (const rect of rects) {
    const centerY = rect.y + rect.h / 2;
    const line = lines.find((candidate) => {
      const first = candidate[0];
      if (first === undefined) {
        return false;
      }
      const candidateCenterY = first.y + first.h / 2;
      const tolerance = Math.max(first.h, rect.h) * 0.75;
      return Math.abs(candidateCenterY - centerY) <= tolerance;
    });

    if (line === undefined) {
      lines.push([rect]);
    } else {
      line.push(rect);
    }
  }

  return lines
    .map((line) => unionRects(line))
    .sort((a, b) => b.y - a.y || a.x - b.x);
}

function unionRects(rects: readonly PdfEditRect[]): PdfEditRect {
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.w));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function snippetFor(text: string, start: number, end: number): string {
  const context = 40;
  const prefixStart = Math.max(0, start - context);
  const suffixEnd = Math.min(text.length, end + context);
  const prefix = prefixStart > 0 ? "\u2026" : "";
  const suffix = suffixEnd < text.length ? "\u2026" : "";
  return `${prefix}${text.slice(prefixStart, suffixEnd)}${suffix}`;
}
