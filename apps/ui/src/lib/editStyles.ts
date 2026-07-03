import type {
  PdfEditColor,
  PdfTextBoxAlign,
  PdfTextBoxFontFamily,
} from "@raiopdf/engine-api";

export interface EditColorOption {
  id: string;
  label: string;
  color: PdfEditColor;
}

export interface HighlightEditStyle {
  color?: PdfEditColor;
  opacity?: number;
}

export interface TextBoxEditStyle {
  color?: PdfEditColor;
  fontFamily?: PdfTextBoxFontFamily;
  bold?: boolean;
  italic?: boolean;
  align?: PdfTextBoxAlign;
}

export interface InkEditStyle {
  color?: PdfEditColor;
  strokeWidthPt: number;
}

export const DEFAULT_HIGHLIGHT_COLOR: PdfEditColor = { r: 1, g: 0.9, b: 0.3 };
export const DEFAULT_HIGHLIGHT_OPACITY = 0.4;
export const DEFAULT_TEXT_COLOR: PdfEditColor = hexToPdfEditColor("#111111");
export const DEFAULT_TEXT_FONT_FAMILY: PdfTextBoxFontFamily = "helvetica";
export const DEFAULT_TEXT_ALIGN: PdfTextBoxAlign = "left";
export const DEFAULT_INK_COLOR: PdfEditColor = DEFAULT_TEXT_COLOR;
export const DEFAULT_INK_STROKE_WIDTH_PT = 1.5;
export const INK_STROKE_WIDTH_OPTIONS = [1, 1.5, 3, 5] as const;

export const HIGHLIGHT_COLOR_OPTIONS: readonly EditColorOption[] = [
  { id: "yellow", label: "Yellow", color: DEFAULT_HIGHLIGHT_COLOR },
  { id: "green", label: "Green", color: hexToPdfEditColor("#86efac") },
  { id: "pink", label: "Pink", color: hexToPdfEditColor("#f9a8d4") },
  { id: "blue", label: "Blue", color: hexToPdfEditColor("#93c5fd") },
  { id: "orange", label: "Orange", color: hexToPdfEditColor("#fdba74") },
] as const;

export const INK_TEXT_COLOR_OPTIONS: readonly EditColorOption[] = [
  { id: "black", label: "Black", color: DEFAULT_TEXT_COLOR },
  { id: "red", label: "Red", color: hexToPdfEditColor("#dc2626") },
  { id: "blue", label: "Blue", color: hexToPdfEditColor("#2563eb") },
  { id: "green", label: "Green", color: hexToPdfEditColor("#16a34a") },
] as const;

export function hexToPdfEditColor(hex: string): PdfEditColor {
  const normalized = hex.trim().replace(/^#/, "");

  if (!/^[\da-f]{6}$/i.test(normalized)) {
    throw new Error(`Invalid edit color hex: ${hex}`);
  }

  return {
    r: Number.parseInt(normalized.slice(0, 2), 16) / 255,
    g: Number.parseInt(normalized.slice(2, 4), 16) / 255,
    b: Number.parseInt(normalized.slice(4, 6), 16) / 255,
  };
}

export function pdfEditColorToHex(color: PdfEditColor): string {
  return `#${[color.r, color.g, color.b]
    .map((channel) => Math.round(clamp01(channel) * 255).toString(16).padStart(2, "0"))
    .join("")}`;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
