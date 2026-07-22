import type {
  PdfRedactionArea,
  PdfReplaceTextWarning,
  PdfSelectedTextTarget,
} from "@raiopdf/engine-api";
import type { TextLayerCoverage } from "@raiopdf/rules";
import { matchAreaForTextRange, type ExtractedPageText } from "./pageTextCache";

export interface PendingTextReplacement {
  id: string;
  find: string;
  replace: string;
  wholeWord: boolean;
  pageIndexes: readonly number[] | "all";
  target?: PdfSelectedTextTarget;
  selectedArea?: PdfRedactionArea;
}

export interface TextEditMatch {
  id: string;
  operationId: string;
  pageIndex: number;
  area: PdfRedactionArea;
  excerpt: string;
}

export interface TextEditGate {
  blocked: boolean;
  message: string | null;
  notes: readonly string[];
}

export interface TextEditOperationReport {
  operationId: string;
  find: string;
  replace: string;
  selected: boolean;
  foundBefore: readonly number[];
  foundAfter: readonly number[];
  replacedEstimate: number;
  status: "changed" | "not-found" | "unchanged";
}

export interface TextEditReviewReport {
  operations: readonly TextEditOperationReport[];
  changedPageIndexes: readonly number[];
  zeroChange: boolean;
  advisory: string | null;
  /**
   * Selected edits are verified against the engine text-map offsets, not a
   * document-wide search. Keeping this excerpt in the report lets the review
   * show the exact anchored location without pretending it is a page preview.
   */
  selectedExcerpt: SelectedTextReviewExcerpt | null;
}

export interface SelectedTextReviewExcerpt {
  pageIndex: number;
  before: string;
  selected: string;
  replacement: string;
  after: string;
}

export const TEXT_EDIT_ADVISORY =
  "Replacements never reflow the page. Longer or shorter text may shift, overlap, or leave extra space.";
export const TEXT_EDIT_WHOLE_DOCUMENT_DISCLOSURE =
  "The whole document is rewritten by this operation. Pages not shown here may shift slightly.";
export const TEXT_EDIT_ZERO_CHANGE_MESSAGE =
  "Nothing was replaced — the document was not modified.";
export const TEXT_EDIT_SELECTED_ZERO_CHANGE_MESSAGE =
  "The selected text was not replaced — the document was not modified.";
export const TEXT_EDIT_STREAMED_GATE_MESSAGE =
  "This document is too large for in-app text editing. Save a smaller copy or split the file first.";
export const TEXT_EDIT_SCANNED_GATE_MESSAGE =
  "Text editing isn't available for scanned documents.";
export const TEXT_EDIT_IMAGE_PAGE_NOTE =
  "Image-only pages are skipped; matches on those pages are excluded.";
export const TEXT_EDIT_MULTI_WORD_CAUTION =
  "Multi-word finds can miss PDFs that place words with positional spacing. Try a single distinctive word if the review shows no replacements.";

export function buildEngineParityPattern(find: string, wholeWord: boolean): RegExp {
  const literal = escapeRegExp(find);
  return new RegExp(wholeWord ? String.raw`(?<!\w)(?:${literal})(?!\w)` : literal, "g");
}

export function findTextMatchesInPages(
  pages: readonly ExtractedPageText[],
  operation: PendingTextReplacement,
  options: { excludedPageIndexes?: ReadonlySet<number> } = {},
): TextEditMatch[] {
  const find = operation.find.trim();
  if (!find) {
    return [];
  }

  const selectedPages = operation.pageIndexes === "all"
    ? null
    : new Set(operation.pageIndexes);
  const matches: TextEditMatch[] = [];
  const pattern = buildEngineParityPattern(find, operation.wholeWord);

  for (const page of pages) {
    if (selectedPages && !selectedPages.has(page.pageIndex)) {
      continue;
    }
    if (options.excludedPageIndexes?.has(page.pageIndex)) {
      continue;
    }

    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(page.text)) !== null) {
      const matchedText = match[0] ?? "";
      if (!matchedText) {
        pattern.lastIndex += 1;
        continue;
      }

      const area = matchAreaForTextRange(page, match.index, match.index + matchedText.length);
      if (!area) {
        continue;
      }

      matches.push({
        id: `${operation.id}-${page.pageIndex}-${match.index}`,
        operationId: operation.id,
        pageIndex: page.pageIndex,
        area,
        excerpt: excerpt(page.text, match.index, matchedText.length),
      });
    }
  }

  return matches;
}

export function detectsPositionalSpaceRisk(
  pages: readonly ExtractedPageText[],
  find: string,
): boolean {
  const normalizedFind = find.trim();
  if (!/\S\s+\S/.test(normalizedFind)) {
    return false;
  }

  const compactFind = normalizedFind.replace(/\s+/g, "");
  if (!compactFind) {
    return false;
  }

  return pages.some((page) => {
    const compactPageText = page.text.replace(/\s+/g, "");
    return compactPageText.includes(compactFind) && !page.text.includes(normalizedFind);
  });
}

export function deriveTextEditGate({
  hasDocument,
  streamed,
  textLayerCoverage,
  engineAvailable,
  permissionProtected = false,
}: {
  hasDocument: boolean;
  streamed: boolean;
  textLayerCoverage: TextLayerCoverage | null;
  engineAvailable: boolean;
  permissionProtected?: boolean;
}): TextEditGate {
  if (!hasDocument) {
    return { blocked: true, message: "Open a PDF before editing document text.", notes: [] };
  }

  if (!engineAvailable) {
    return { blocked: true, message: "This tool only works in the installed RaioPDF app.", notes: [] };
  }

  if (streamed) {
    return { blocked: true, message: TEXT_EDIT_STREAMED_GATE_MESSAGE, notes: [] };
  }

  if (permissionProtected) {
    return {
      blocked: true,
      message: "Text editing isn't available for permissions-protected PDFs in this version.",
      notes: [],
    };
  }

  const totalPages = textLayerCoverage
    ? textLayerCoverage.imageOnlyPages.length +
      textLayerCoverage.mixedPages.length +
      textLayerCoverage.textPages.length
    : 0;
  const effectivelyImageOnlyPages = textLayerCoverage
    ? textLayerCoverage.imageOnlyPages.length + (textLayerCoverage.trivialTextImagePages?.length ?? 0)
    : 0;

  if (textLayerCoverage && totalPages > 0 && effectivelyImageOnlyPages === totalPages) {
    return { blocked: true, message: TEXT_EDIT_SCANNED_GATE_MESSAGE, notes: [] };
  }

  const notes: string[] = [];
  if (textLayerCoverage && effectivelyImageOnlyPages > 0) {
    notes.push(TEXT_EDIT_IMAGE_PAGE_NOTE);
  }
  if (textLayerCoverage && textLayerCoverage.garbledPages.length > 0) {
    notes.push(
      `Matching may be incomplete - the text layer looks garbled on ${textLayerCoverage.garbledPages.length} page${textLayerCoverage.garbledPages.length === 1 ? "" : "s"}.`,
    );
  }

  return { blocked: false, message: null, notes };
}

export function buildTextEditReviewReport({
  operations,
  originalPages,
  candidatePages,
}: {
  operations: readonly PendingTextReplacement[];
  originalPages: readonly ExtractedPageText[];
  candidatePages: readonly ExtractedPageText[];
}): TextEditReviewReport {
  const selectedOperation = operations.length === 1 && operations[0]?.target
    ? operations[0]
    : null;
  const selectedVerification = selectedOperation
    ? verifySelectedReplacement(selectedOperation, originalPages, candidatePages)
    : null;
  const changedPageIndexes = uniqueSorted(
    candidatePages
      .filter((candidate) => {
        const original = originalPages.find((page) => page.pageIndex === candidate.pageIndex);
        return original ? original.text !== candidate.text : candidate.text.trim().length > 0;
      })
      .map((page) => page.pageIndex),
  );
  const changedPages = new Set(changedPageIndexes);
  const reports: TextEditOperationReport[] = operations.map((operation) => {
    if (operation.target) {
      const pageIndex = operation.target.pageIndex;
      const originalPage = originalPages.find((page) => page.pageIndex === pageIndex);
      const candidatePage = candidatePages.find((page) => page.pageIndex === pageIndex);
      // The target's offsets live in the engine text-map model, which joins
      // text items with NO separators — the same model the DOM text layer
      // exposes. Verify against the separator-free extraction (`flatText`);
      // `text` splices inferred spaces/newlines between items, so slicing it
      // with engine offsets drifts on any multi-item page and every selected
      // replacement would verify as "unchanged".
      const originalText = originalPage?.flatText ?? originalPage?.text ?? "";
      const candidateText = candidatePage?.flatText ?? candidatePage?.text ?? "";
      const originalStillMatches = originalText.slice(
        operation.target.start,
        operation.target.end,
      ) === operation.target.expectedText;
      const expectedCandidateText = originalStillMatches
        ? [
            originalText.slice(0, operation.target.start),
            operation.replace,
            originalText.slice(operation.target.end),
          ].join("")
        : null;
      const selectedChanged = changedPages.has(pageIndex) &&
        originalStillMatches &&
        candidateText === expectedCandidateText &&
        selectedVerification?.ok === true;

      return {
        operationId: operation.id,
        find: operation.find,
        replace: operation.replace,
        selected: true,
        foundBefore: [pageIndex],
        foundAfter: selectedChanged ? [] : [pageIndex],
        replacedEstimate: selectedChanged ? 1 : 0,
        status: selectedChanged ? "changed" : "unchanged",
      };
    }

    const beforeMatches = findTextMatchesInPages(originalPages, operation);
    const afterMatches = findTextMatchesInPages(candidatePages, operation);
    const foundBefore = uniqueSorted(beforeMatches.map((match) => match.pageIndex));
    const foundAfter = uniqueSorted(afterMatches.map((match) => match.pageIndex));
    const replacedEstimate = Math.max(0, beforeMatches.length - afterMatches.length);

    return {
      operationId: operation.id,
      find: operation.find,
      replace: operation.replace,
      selected: false,
      foundBefore,
      foundAfter,
      replacedEstimate,
      status: replacedEstimate > 0
        ? "changed"
        : foundBefore.length > 0
          ? "unchanged"
          : "not-found",
    };
  });

  return {
    operations: reports,
    changedPageIndexes,
    zeroChange: changedPageIndexes.length === 0,
    advisory: lengthDeltaAdvisory(operations),
    selectedExcerpt: selectedVerification?.excerpt ?? null,
  };
}

export function warningCopy(warning: PdfReplaceTextWarning): string {
  switch (warning.code) {
    case "COUNTS_UNAVAILABLE":
      return "The engine does not return replacement counts; this review re-read the staged PDF.";
    case "SIGNATURES_INVALIDATED":
      return "Digital signatures are invalidated in the edited copy.";
    case "FALLBACK_FONT_POSSIBLE":
      return "A substitute font may have been used; review the affected pages before applying.";
    case "PDFA_IDENTIFICATION_REMOVED":
      return "Editing removes this file's PDF/A marking — you can convert again afterward.";
    case "IMAGES_REENCODED":
      return "This engine build may rewrite embedded images while editing text.";
    case "ATTACHMENTS_REMOVED":
      return "Embedded attachments may be removed by this edit.";
    case "TAGS_REMOVED":
      return "Accessibility tags may be removed by this edit.";
    case "SELECTED_TEXT_LAYOUT_RISK":
      return "This selected-text edit spans multiple PDF text runs; review the affected page for spacing or overlap.";
  }
}

export function formatReplaceTextResult(report: TextEditReviewReport): string {
  const selectedOperation = report.operations.length === 1 && report.operations[0]?.selected
    ? report.operations[0]
    : null;
  if (selectedOperation) {
    if (report.zeroChange) {
      return TEXT_EDIT_SELECTED_ZERO_CHANGE_MESSAGE;
    }
    return selectedOperation.status === "changed"
      ? `This replacement is scoped to the selected occurrence on page ${selectedOperation.foundBefore[0] !== undefined ? selectedOperation.foundBefore[0] + 1 : "the selected page"} and was verified.`
      : "Selected replacement was not staged.";
  }

  if (report.zeroChange) {
    return TEXT_EDIT_ZERO_CHANGE_MESSAGE;
  }

  const estimate = report.operations.reduce((total, operation) => total + operation.replacedEstimate, 0);
  const pageCount = report.changedPageIndexes.length;
  return `${estimate} estimated ${estimate === 1 ? "replacement" : "replacements"} on ${pageCount} ${pageCount === 1 ? "page" : "pages"}.`;
}

export function canApplyTextEditReview(report: TextEditReviewReport): boolean {
  return !report.zeroChange &&
    report.operations.every((operation) => !operation.selected || operation.status === "changed");
}

/**
 * A selected edit is intentionally stricter than bulk replacement: the
 * candidate's extracted text must be exactly the original text with this one
 * offset range replaced. Any unrelated extracted-text change (including on a
 * different page) fails the review closed instead of being omitted from a
 * short page list.
 */
function verifySelectedReplacement(
  operation: PendingTextReplacement,
  originalPages: readonly ExtractedPageText[],
  candidatePages: readonly ExtractedPageText[],
): { ok: boolean; excerpt: SelectedTextReviewExcerpt | null } {
  const target = operation.target;
  if (!target) {
    return { ok: false, excerpt: null };
  }

  const originalByPage = new Map(originalPages.map((page) => [page.pageIndex, page]));
  const candidateByPage = new Map(candidatePages.map((page) => [page.pageIndex, page]));
  const pageIndexes = new Set([...originalByPage.keys(), ...candidateByPage.keys()]);
  const originalTarget = originalByPage.get(target.pageIndex);
  if (!originalTarget || !candidateByPage.has(target.pageIndex)) {
    return { ok: false, excerpt: null };
  }

  const originalText = extractedTextModel(originalTarget);
  if (originalText.slice(target.start, target.end) !== target.expectedText) {
    return { ok: false, excerpt: null };
  }

  const expectedTargetText = `${originalText.slice(0, target.start)}${operation.replace}${originalText.slice(target.end)}`;
  for (const pageIndex of pageIndexes) {
    const original = originalByPage.get(pageIndex);
    const candidate = candidateByPage.get(pageIndex);
    if (!original || !candidate) {
      return { ok: false, excerpt: null };
    }
    const expected = pageIndex === target.pageIndex ? expectedTargetText : extractedTextModel(original);
    if (extractedTextModel(candidate) !== expected) {
      return { ok: false, excerpt: null };
    }
  }

  return {
    ok: true,
    excerpt: {
      pageIndex: target.pageIndex,
      before: originalText.slice(Math.max(0, target.start - 72), target.start),
      selected: target.expectedText,
      replacement: operation.replace,
      after: originalText.slice(target.end, target.end + 72),
    },
  };
}

function extractedTextModel(page: ExtractedPageText): string {
  return page.flatText ?? page.text;
}

function lengthDeltaAdvisory(operations: readonly PendingTextReplacement[]): string | null {
  return operations.some((operation) => operation.find.length !== operation.replace.length)
    ? TEXT_EDIT_ADVISORY
    : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function excerpt(text: string, start: number, length: number): string {
  const before = text.slice(Math.max(0, start - 32), start).replace(/\s+/g, " ");
  const match = text.slice(start, start + length).replace(/\s+/g, " ");
  const after = text.slice(start + length, start + length + 32).replace(/\s+/g, " ");
  return `${before}${before ? " " : ""}${match}${after ? " " : ""}${after}`.trim();
}

function uniqueSorted(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}
