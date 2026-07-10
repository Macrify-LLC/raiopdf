import { PdfEngineError } from "@raiopdf/engine-api";
import {
  PDFDocument,
  type PDFFont,
  type PDFPage,
  rgb,
  StandardFonts,
  type Color,
} from "pdf-lib";
import { fitTextToWidth, sanitizeIndexTextForFont } from "./textFit";

const LETTER_PORTRAIT: readonly [number, number] = [612, 792];
const FRONT_MATTER_MAX_ITERATIONS = 5;
const STAMP_COLOR = rgb(0.08, 0.08, 0.08);
const DEFAULT_MARGIN = 54;
const DEFAULT_TITLE_SIZE = 16;
const DEFAULT_SECTION_TITLE_SIZE = 10;
const DEFAULT_ROW_FONT_SIZE = 9;
const DEFAULT_ROW_HEIGHT = 18;
const DEFAULT_SECTION_GAP = 10;
const DEFAULT_TITLE_GAP = 30;
const DEFAULT_PAGE_LABEL_SIZE = 8;
const LEADER_PADDING = 4;

export type DotLeaderRowDrawResult = {
  leftText: string;
  rightText: string;
  leaderText: string;
};

export type DotLeaderRowDrawInput = {
  page: PDFPage;
  font: PDFFont;
  leftText: string;
  rightText: string;
  x: number;
  y: number;
  width: number;
  fontSize: number;
  color?: Color | undefined;
};

export type FrontMatterLeaderRow = {
  leftText: string;
  rightText: string;
};

export type FrontMatterSection = {
  title: string;
  rows: readonly FrontMatterLeaderRow[];
};

export type FrontMatterSectionResolver = (context: {
  frontMatterPageCount: number;
}) => readonly FrontMatterSection[];

export type FrontMatterFonts = {
  regular: PDFFont;
  bold: PDFFont;
};

export type StableFrontMatterRenderInput = {
  doc?: PDFDocument | undefined;
  pageSize?: readonly [number, number] | undefined;
  title?: string | undefined;
  sections: readonly FrontMatterSection[] | FrontMatterSectionResolver;
  fonts?: FrontMatterFonts | undefined;
  margin?: number | undefined;
  titleSize?: number | undefined;
  sectionTitleSize?: number | undefined;
  rowFontSize?: number | undefined;
  rowHeight?: number | undefined;
  sectionGap?: number | undefined;
  maxIterations?: number | undefined;
  color?: Color | undefined;
};

export type StableFrontMatterRenderResult = {
  doc: PDFDocument;
  pages: PDFPage[];
  pageCount: number;
  sections: readonly FrontMatterSection[];
  iterations: number;
};

type FrontMatterLayout = ReturnType<typeof normalizeFrontMatterLayout>;

type LayoutEntry =
  | { type: "sectionTitle"; text: string; y: number; pageIndex: number }
  | { type: "row"; row: FrontMatterLeaderRow; y: number; pageIndex: number };

export function drawDotLeaderRow(input: DotLeaderRowDrawInput): DotLeaderRowDrawResult {
  const color = input.color ?? STAMP_COLOR;
  const width = Math.max(0, input.width);
  const rightText = fitTextToWidth(
    input.font,
    sanitizeIndexTextForFont(input.font, input.rightText),
    input.fontSize,
    width,
  );
  const rightTextWidth = input.font.widthOfTextAtSize(rightText, input.fontSize);
  const rightTextX = input.x + width - rightTextWidth;
  const leftMaxWidth = Math.max(0, rightTextX - input.x - (LEADER_PADDING * 2));
  const leftText = fitTextToWidth(
    input.font,
    sanitizeIndexTextForFont(input.font, input.leftText),
    input.fontSize,
    leftMaxWidth,
  );
  const leftTextWidth = input.font.widthOfTextAtSize(leftText, input.fontSize);
  const leaderStartX = input.x + leftTextWidth + LEADER_PADDING;
  const leaderEndX = rightTextX - LEADER_PADDING;
  const leaderText = createDotLeader(input.font, input.fontSize, leaderEndX - leaderStartX);

  if (leftText.length > 0) {
    input.page.drawText(leftText, {
      x: input.x,
      y: input.y,
      size: input.fontSize,
      font: input.font,
      color,
    });
  }

  if (leaderText.length > 0) {
    input.page.drawText(leaderText, {
      x: leaderStartX,
      y: input.y,
      size: input.fontSize,
      font: input.font,
      color,
    });
  }

  if (rightText.length > 0) {
    input.page.drawText(rightText, {
      x: rightTextX,
      y: input.y,
      size: input.fontSize,
      font: input.font,
      color,
    });
  }

  return {
    leftText,
    rightText,
    leaderText,
  };
}

export async function renderStableFrontMatter(
  input: StableFrontMatterRenderInput,
): Promise<StableFrontMatterRenderResult> {
  const maxIterations = input.maxIterations ?? FRONT_MATTER_MAX_ITERATIONS;

  if (!Number.isInteger(maxIterations) || maxIterations <= 0) {
    throw new PdfEngineError("INVALID_DOCUMENT", "maxIterations must be a positive integer.");
  }

  const layout = normalizeFrontMatterLayout(input);
  let frontMatterPageCount = 0;

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const sections = resolveFrontMatterSections(input.sections, frontMatterPageCount);
    const pageCount = planFrontMatterPages(sections, layout).pageCount;

    if (pageCount === frontMatterPageCount) {
      const rendered = await renderFrontMatterPages(input, layout, sections, pageCount);

      return {
        doc: rendered.doc,
        pages: rendered.pages,
        pageCount,
        sections,
        iterations: iteration,
      };
    }

    frontMatterPageCount = pageCount;
  }

  throw new PdfEngineError(
    "INVALID_DOCUMENT",
    `Front matter pagination did not stabilize within ${maxIterations} iterations.`,
  );
}

function createDotLeader(font: PDFFont, fontSize: number, maxWidth: number): string {
  if (maxWidth <= 0) {
    return "";
  }

  const dotWidth = font.widthOfTextAtSize(".", fontSize);
  const dotCount = Math.floor(maxWidth / dotWidth);

  return dotCount < 2 ? "" : ".".repeat(dotCount);
}

function normalizeFrontMatterLayout(input: StableFrontMatterRenderInput): {
  pageSize: readonly [number, number];
  margin: number;
  titleSize: number;
  sectionTitleSize: number;
  rowFontSize: number;
  rowHeight: number;
  sectionGap: number;
  titleGap: number;
  pageLabelSize: number;
  color: Color;
} {
  const pageSize = input.pageSize ?? LETTER_PORTRAIT;
  assertPositiveNumber(pageSize[0], "front matter page width");
  assertPositiveNumber(pageSize[1], "front matter page height");
  const margin = input.margin ?? DEFAULT_MARGIN;
  const titleSize = input.titleSize ?? DEFAULT_TITLE_SIZE;
  const sectionTitleSize = input.sectionTitleSize ?? DEFAULT_SECTION_TITLE_SIZE;
  const rowFontSize = input.rowFontSize ?? DEFAULT_ROW_FONT_SIZE;
  const rowHeight = input.rowHeight ?? DEFAULT_ROW_HEIGHT;
  const sectionGap = input.sectionGap ?? DEFAULT_SECTION_GAP;

  assertPositiveNumber(margin, "front matter margin");
  assertPositiveNumber(titleSize, "front matter title size");
  assertPositiveNumber(sectionTitleSize, "front matter section title size");
  assertPositiveNumber(rowFontSize, "front matter row font size");
  assertPositiveNumber(rowHeight, "front matter row height");
  assertNonNegativeNumber(sectionGap, "front matter section gap");

  return {
    pageSize,
    margin,
    titleSize,
    sectionTitleSize,
    rowFontSize,
    rowHeight,
    sectionGap,
    titleGap: DEFAULT_TITLE_GAP,
    pageLabelSize: DEFAULT_PAGE_LABEL_SIZE,
    color: input.color ?? STAMP_COLOR,
  };
}

function resolveFrontMatterSections(
  sections: StableFrontMatterRenderInput["sections"],
  frontMatterPageCount: number,
): readonly FrontMatterSection[] {
  if (typeof sections === "function") {
    return sections({ frontMatterPageCount });
  }

  return sections;
}

function planFrontMatterPages(
  sections: readonly FrontMatterSection[],
  layout: FrontMatterLayout,
): { pageCount: number; entries: LayoutEntry[] } {
  const entries: LayoutEntry[] = [];
  let pageIndex = 0;
  let y = firstContentY(layout);

  for (const section of sections) {
    const title = section.title.trim();
    const sectionNeedsHeight = section.rows.length > 0
      ? layout.sectionTitleSize + layout.rowHeight
      : layout.sectionTitleSize;

    if (title.length > 0) {
      if (!hasRoomFor(y, sectionNeedsHeight, layout)) {
        pageIndex += 1;
        y = firstContentY(layout);
      }

      entries.push({ type: "sectionTitle", text: title, y, pageIndex });
      y -= layout.rowHeight;
    }

    for (const row of section.rows) {
      if (!hasRoomFor(y, layout.rowHeight, layout)) {
        pageIndex += 1;
        y = firstContentY(layout);
      }

      entries.push({ type: "row", row, y, pageIndex });
      y -= layout.rowHeight;
    }

    y -= layout.sectionGap;
  }

  return {
    pageCount: Math.max(1, pageIndex + 1),
    entries,
  };
}

async function renderFrontMatterPages(
  input: StableFrontMatterRenderInput,
  layout: FrontMatterLayout,
  sections: readonly FrontMatterSection[],
  pageCount: number,
): Promise<{ doc: PDFDocument; pages: PDFPage[] }> {
  const doc = input.doc ?? await PDFDocument.create();
  const fonts = input.fonts ?? {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
  };
  const plan = planFrontMatterPages(sections, layout);
  const pages = Array.from({ length: pageCount }, () => doc.addPage([...layout.pageSize]));
  const contentWidth = layout.pageSize[0] - (layout.margin * 2);

  pages.forEach((page, pageIndex) => {
    drawFrontMatterPageHeader(page, fonts, layout, input.title, pageIndex, pageCount);
  });

  for (const entry of plan.entries) {
    const page = pages[entry.pageIndex];

    if (page === undefined) {
      continue;
    }

    if (entry.type === "sectionTitle") {
      page.drawText(fitTextToWidth(fonts.bold, entry.text, layout.sectionTitleSize, contentWidth), {
        x: layout.margin,
        y: entry.y,
        size: layout.sectionTitleSize,
        font: fonts.bold,
        color: layout.color,
      });
      continue;
    }

    drawDotLeaderRow({
      page,
      font: fonts.regular,
      leftText: entry.row.leftText,
      rightText: entry.row.rightText,
      x: layout.margin,
      y: entry.y,
      width: contentWidth,
      fontSize: layout.rowFontSize,
      color: layout.color,
    });
  }

  return { doc, pages };
}

function drawFrontMatterPageHeader(
  page: PDFPage,
  fonts: FrontMatterFonts,
  layout: FrontMatterLayout,
  title: string | undefined,
  pageIndex: number,
  pageCount: number,
): void {
  if (title !== undefined && title.length > 0) {
    const [pageWidth, pageHeight] = layout.pageSize;
    const y = pageHeight - layout.margin - layout.titleSize;

    page.drawText(fitTextToWidth(fonts.bold, title, layout.titleSize, pageWidth - (layout.margin * 2)), {
      x: layout.margin,
      y,
      size: layout.titleSize,
      font: fonts.bold,
      color: layout.color,
    });

    if (pageCount > 1) {
      drawRightAlignedText(
        page,
        fonts.regular,
        `${pageIndex + 1} of ${pageCount}`,
        pageWidth - layout.margin - 80,
        80,
        y + 2,
        layout.pageLabelSize,
        layout.color,
      );
    }
  }
}

function drawRightAlignedText(
  page: PDFPage,
  font: PDFFont,
  text: string,
  x: number,
  width: number,
  y: number,
  fontSize: number,
  color: Color,
): void {
  const fitted = fitTextToWidth(font, sanitizeIndexTextForFont(font, text), fontSize, width);
  page.drawText(fitted, {
    x: x + width - font.widthOfTextAtSize(fitted, fontSize),
    y,
    size: fontSize,
    font,
    color,
  });
}

function firstContentY(layout: FrontMatterLayout): number {
  const [, pageHeight] = layout.pageSize;

  return pageHeight - layout.margin - layout.titleSize - layout.titleGap;
}

function hasRoomFor(currentY: number, height: number, layout: FrontMatterLayout): boolean {
  return currentY - height >= layout.margin;
}

function assertPositiveNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new PdfEngineError("INVALID_DOCUMENT", `${name} must be a positive number.`);
  }
}

function assertNonNegativeNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new PdfEngineError("INVALID_DOCUMENT", `${name} must be a non-negative number.`);
  }
}
