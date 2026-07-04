import { promises as fs } from "node:fs";
import { z } from "zod";
import type {
  PdfCommentEdit,
  PdfEditColor,
  PdfEditPoint,
  PdfEditRect,
  PdfHighlightEdit,
  PdfTextMarkupEdit,
} from "@raiopdf/engine-api";
import type { EngineHandle } from "../engine.js";
import { baseOutputSchema, errorResult, successResult, type StructuredToolResult } from "../format.js";
import { runLocalSingleOutputOp } from "../ops.js";
import { resolveInput } from "../paths.js";
import { extractTextBoxesByPage } from "../pdfjs-node.js";
import { locateText, type LocatedMatch } from "../textLocate.js";

const absoluteInput = z.string().describe("Absolute path to an existing PDF file.");
const absoluteOutput = z
  .string()
  .describe("Absolute path for the annotated PDF. Must not already exist (never overwrites).");
const pageSubsetSchema = z
  .array(z.number().int().nonnegative())
  .optional()
  .describe("Optional zero-based page indexes to search.");
const rectSchema = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive(),
  h: z.number().positive(),
});
const locatedMatchSchema = z.object({
  pageIndex: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  snippet: z.string(),
  rects: z.array(rectSchema),
  score: z.number(),
});
const matchAnchorSchema = z.object({
  pageIndex: z.number().int().nonnegative(),
  rects: z.array(rectSchema).min(1),
});
const pointSchema = z.object({
  x: z.number(),
  y: z.number(),
});

const highlightColorSchema = z.enum(["yellow", "green", "pink", "blue", "orange"]);
const markupColorSchema = z.enum(["black", "red", "blue", "green"]);

const locateOptionsSchema = {
  caseSensitive: z.boolean().optional().describe("Default false."),
  wholeWord: z.boolean().optional().describe("Default false."),
  pages: pageSubsetSchema,
};

const annotateByTextBaseSchema = {
  input: absoluteInput,
  output: absoluteOutput,
  quote: z.string().min(1).optional().describe("Text to locate and annotate."),
  matches: z
    .array(matchAnchorSchema)
    .optional()
    .describe("Rectangles returned by locate_text. Use instead of quote."),
  matchAll: z.boolean().optional().describe("When quote is used, annotate all matches. Default true."),
  ...locateOptionsSchema,
};

export const locateTextInputSchema = {
  input: absoluteInput,
  query: z.string().min(1).describe("Text to locate in the PDF text layer."),
  ...locateOptionsSchema,
  fuzzy: z.boolean().optional().describe("Opt into conservative approximate matching. Default false."),
  minScore: z.number().min(0).max(1).optional().describe("Fuzzy minimum score. Default 0.85."),
};
export const locateTextOutputSchema = {
  ...baseOutputSchema,
  matchCount: z.number().int().nonnegative().optional(),
  matches: z.array(locatedMatchSchema).optional(),
};
export interface LocateTextInput {
  input: string;
  query: string;
  caseSensitive?: boolean | undefined;
  wholeWord?: boolean | undefined;
  pages?: number[] | undefined;
  fuzzy?: boolean | undefined;
  minScore?: number | undefined;
}

export const highlightTextInputSchema = {
  ...annotateByTextBaseSchema,
  color: highlightColorSchema.optional().describe("Default yellow."),
  opacity: z.number().min(0).max(1).optional(),
};
export const highlightTextOutputSchema = {
  ...baseOutputSchema,
  output: z.string().optional(),
  occurrences: z.number().int().nonnegative().optional(),
  pages: z.array(z.number().int().positive()).optional(),
};
export interface HighlightTextInput extends AnnotateByTextInput {
  color?: z.infer<typeof highlightColorSchema> | undefined;
  opacity?: number | undefined;
}

export const underlineTextInputSchema = {
  ...annotateByTextBaseSchema,
  color: markupColorSchema.optional().describe("Default black."),
  thicknessPt: z.number().positive().optional(),
};
export const underlineTextOutputSchema = highlightTextOutputSchema;
export interface UnderlineTextInput extends AnnotateByTextInput {
  color?: z.infer<typeof markupColorSchema> | undefined;
  thicknessPt?: number | undefined;
}

export const strikethroughTextInputSchema = underlineTextInputSchema;
export const strikethroughTextOutputSchema = highlightTextOutputSchema;
export type StrikethroughTextInput = UnderlineTextInput;

export const addCommentInputSchema = {
  input: absoluteInput,
  output: absoluteOutput,
  text: z.string().min(1).describe("Comment body."),
  anchorText: z.string().min(1).optional().describe("Place at the first occurrence of this text."),
  page: z.number().int().positive().optional().describe("One-based page for manual placement."),
  at: pointSchema.optional().describe("Optional PDF user-space point for page placement."),
  author: z.string().optional(),
  caseSensitive: z.boolean().optional().describe("Default false when anchorText is used."),
  wholeWord: z.boolean().optional().describe("Default false when anchorText is used."),
};
export const addCommentOutputSchema = {
  ...baseOutputSchema,
  output: z.string().optional(),
  page: z.number().int().positive().optional(),
};
export interface AddCommentInput {
  input: string;
  output: string;
  text: string;
  anchorText?: string | undefined;
  page?: number | undefined;
  at?: PdfEditPoint | undefined;
  author?: string | undefined;
  caseSensitive?: boolean | undefined;
  wholeWord?: boolean | undefined;
}

type MatchAnchor = {
  pageIndex: number;
  rects: PdfEditRect[];
};

interface AnnotateByTextInput {
  input: string;
  output: string;
  quote?: string | undefined;
  matches?: MatchAnchor[] | undefined;
  matchAll?: boolean | undefined;
  caseSensitive?: boolean | undefined;
  wholeWord?: boolean | undefined;
  pages?: number[] | undefined;
}

type MarkupKind = "highlight" | "underline" | "strikethrough";

const HIGHLIGHT_COLORS: Record<NonNullable<HighlightTextInput["color"]>, PdfEditColor> = {
  yellow: { r: 1, g: 0.9, b: 0.3 },
  green: hexToPdfEditColor("#86efac"),
  pink: hexToPdfEditColor("#f9a8d4"),
  blue: hexToPdfEditColor("#93c5fd"),
  orange: hexToPdfEditColor("#fdba74"),
};

const MARKUP_COLORS: Record<NonNullable<UnderlineTextInput["color"]>, PdfEditColor> = {
  black: hexToPdfEditColor("#111111"),
  red: hexToPdfEditColor("#dc2626"),
  blue: hexToPdfEditColor("#2563eb"),
  green: hexToPdfEditColor("#16a34a"),
};

export async function handleLocateText(
  input: LocateTextInput,
  _engine: EngineHandle,
): Promise<StructuredToolResult> {
  const source = await resolveInput(input.input);
  const bytes = await fs.readFile(source.realPath);
  const matches = await locateText(bytes, input.query, {
    caseSensitive: input.caseSensitive ?? false,
    wholeWord: input.wholeWord ?? false,
    pages: input.pages,
    fuzzy: input.fuzzy ?? false,
    minScore: input.minScore,
  });

  return successResult(
    `Found ${matches.length} match(es) for "${input.query}".`,
    { matchCount: matches.length, matches },
  );
}

export function handleHighlightText(
  input: HighlightTextInput,
  _engine: EngineHandle,
): Promise<StructuredToolResult> {
  return handleTextMarkup("highlight", input);
}

export function handleUnderlineText(
  input: UnderlineTextInput,
  _engine: EngineHandle,
): Promise<StructuredToolResult> {
  return handleTextMarkup("underline", input);
}

export function handleStrikethroughText(
  input: StrikethroughTextInput,
  _engine: EngineHandle,
): Promise<StructuredToolResult> {
  return handleTextMarkup("strikethrough", input);
}

export async function handleAddComment(
  input: AddCommentInput,
  _engine: EngineHandle,
): Promise<StructuredToolResult> {
  const hasAnchorText = input.anchorText !== undefined;
  const hasPage = input.page !== undefined;
  if (hasAnchorText === hasPage) {
    return errorResult(
      "INVALID_ARGUMENT",
      "add_comment requires exactly one anchor: anchorText or page.",
    );
  }

  const source = await resolveInput(input.input);
  const bytes = await fs.readFile(source.realPath);
  const anchor = hasAnchorText
    ? await resolveTextCommentAnchor(bytes, input)
    : await resolvePageCommentAnchor(bytes, input);
  if (anchor === undefined) {
    return errorResult(
      "NO_MATCH",
      `No match found for "${input.anchorText}". The document was NOT written.`,
      "Use locate_text to inspect the available text or provide a manual page/at anchor.",
    );
  }

  const edit: PdfCommentEdit = {
    type: "comment",
    pageIndex: anchor.pageIndex,
    at: anchor.at,
    text: input.text,
    ...(input.author === undefined ? {} : { author: input.author }),
  };

  return runLocalSingleOutputOp(input.input, input.output, async (engine, document) => {
    const result = await engine.applyEdits(document, [edit], { markupMode: "annotation" });
    return {
      result,
      summary: `Added a comment on page ${anchor.pageIndex + 1} into ${input.output}.`,
      extra: { page: anchor.pageIndex + 1 },
    };
  });
}

async function handleTextMarkup(
  type: MarkupKind,
  input: HighlightTextInput | UnderlineTextInput | StrikethroughTextInput,
): Promise<StructuredToolResult> {
  const selected = await resolveMarkupTargets(input);
  if (!selected.ok) {
    return selected.result;
  }

  const targets = selected.matches;
  const edits = buildMarkupEdits(type, targets, input);
  const pages = [...new Set(targets.map((match) => match.pageIndex + 1))].sort((a, b) => a - b);
  const verb = type === "highlight"
    ? "Highlighted"
    : type === "underline"
      ? "Underlined"
      : "Struck through";
  const noun = input.quote === undefined ? "selected text" : `"${input.quote}"`;

  return runLocalSingleOutputOp(input.input, input.output, async (engine, document) => {
    const result = await engine.applyEdits(document, edits, { markupMode: "annotation" });
    return {
      result,
      summary:
        `${verb} ${targets.length} occurrence(s) of ${noun} across ${pages.length} page(s).`,
      extra: { occurrences: targets.length, pages },
    };
  });
}

async function resolveMarkupTargets(
  input: AnnotateByTextInput,
): Promise<{ ok: true; matches: MatchAnchor[] } | { ok: false; result: StructuredToolResult }> {
  const hasQuote = input.quote !== undefined;
  const hasMatches = input.matches !== undefined;
  if (hasQuote === hasMatches) {
    return {
      ok: false,
      result: errorResult(
        "INVALID_ARGUMENT",
        "Annotation tools require exactly one of quote or matches.",
      ),
    };
  }

  if (input.matches !== undefined) {
    if (input.matches.length === 0) {
      return {
        ok: false,
        result: errorResult("INVALID_ARGUMENT", "matches must contain at least one target."),
      };
    }
    return { ok: true, matches: input.matches };
  }

  const source = await resolveInput(input.input);
  const bytes = await fs.readFile(source.realPath);
  const located = await locateText(bytes, input.quote ?? "", {
    caseSensitive: input.caseSensitive ?? false,
    wholeWord: input.wholeWord ?? false,
    pages: input.pages,
    fuzzy: false,
  });
  if (located.length === 0) {
    return {
      ok: false,
      result: errorResult(
        "NO_MATCH",
        `No match found for "${input.quote}". The document was NOT written.`,
        "Use locate_text to inspect the available text or pass explicit matches.",
      ),
    };
  }

  const selected = input.matchAll === false ? located.slice(0, 1) : located;
  return { ok: true, matches: selected.map(toMatchAnchor) };
}

function buildMarkupEdits(
  type: MarkupKind,
  targets: readonly MatchAnchor[],
  input: HighlightTextInput | UnderlineTextInput | StrikethroughTextInput,
): Array<PdfHighlightEdit | PdfTextMarkupEdit> {
  const rectsByPage = new Map<number, PdfEditRect[]>();
  for (const target of targets) {
    const current = rectsByPage.get(target.pageIndex) ?? [];
    current.push(...target.rects);
    rectsByPage.set(target.pageIndex, current);
  }

  return [...rectsByPage.entries()].map(([pageIndex, rects]) => {
    if (type === "highlight") {
      const highlightInput = input as HighlightTextInput;
      return {
        type,
        pageIndex,
        rects,
        color: HIGHLIGHT_COLORS[highlightInput.color ?? "yellow"],
        ...(highlightInput.opacity === undefined ? {} : { opacity: highlightInput.opacity }),
      };
    }

    const markupInput = input as UnderlineTextInput;
    return {
      type,
      pageIndex,
      rects,
      color: MARKUP_COLORS[markupInput.color ?? "black"],
      ...(markupInput.thicknessPt === undefined ? {} : { thicknessPt: markupInput.thicknessPt }),
    };
  });
}

async function resolveTextCommentAnchor(
  bytes: Uint8Array,
  input: AddCommentInput,
): Promise<{ pageIndex: number; at: PdfEditPoint } | undefined> {
  const [match] = await locateText(bytes, input.anchorText ?? "", {
    caseSensitive: input.caseSensitive ?? false,
    wholeWord: input.wholeWord ?? false,
  });
  const [rect] = match?.rects ?? [];
  if (match === undefined || rect === undefined) {
    return undefined;
  }

  return {
    pageIndex: match.pageIndex,
    at: { x: rect.x, y: rect.y + rect.h },
  };
}

async function resolvePageCommentAnchor(
  bytes: Uint8Array,
  input: AddCommentInput,
): Promise<{ pageIndex: number; at: PdfEditPoint }> {
  const pages = await extractTextBoxesByPage(bytes);
  const pageIndex = (input.page ?? 1) - 1;
  const page = pages.find((candidate) => candidate.pageIndex === pageIndex);
  if (page === undefined) {
    throw new Error(`Page ${input.page} is out of range; the document has ${pages.length} page(s).`);
  }

  return {
    pageIndex,
    at: input.at ?? { x: Math.max(0, page.width - 36), y: Math.max(0, page.height - 36) },
  };
}

function toMatchAnchor(match: LocatedMatch): MatchAnchor {
  return {
    pageIndex: match.pageIndex,
    rects: match.rects,
  };
}

function hexToPdfEditColor(hex: string): PdfEditColor {
  const normalized = hex.replace(/^#/, "");
  const value = Number.parseInt(normalized, 16);
  return {
    r: ((value >> 16) & 0xff) / 255,
    g: ((value >> 8) & 0xff) / 255,
    b: (value & 0xff) / 255,
  };
}
