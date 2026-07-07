import type { PDFFont } from "pdf-lib";

export function sanitizeIndexTextForFont(font: PDFFont, text: string): string {
  let sanitized = "";

  for (const character of text) {
    if (isWhitespace(character) || isControlCharacter(character)) {
      sanitized += " ";
      continue;
    }

    try {
      font.widthOfTextAtSize(character, 1);
      sanitized += character;
    } catch {
      sanitized += " ";
    }
  }

  return sanitized.replace(/\s+/gu, " ").trim();
}

export function fitTextToWidth(font: PDFFont, text: string, fontSize: number, maxWidth: number): string {
  if (font.widthOfTextAtSize(text, fontSize) <= maxWidth) {
    return text;
  }

  const marker = "...";
  let fitted = text;

  while (fitted.length > 0 && font.widthOfTextAtSize(`${fitted}${marker}`, fontSize) > maxWidth) {
    fitted = fitted.slice(0, -1);
  }

  return fitted.length === 0 ? "" : `${fitted}${marker}`;
}

function isWhitespace(character: string): boolean {
  return /\s/u.test(character);
}

function isControlCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0);

  return codePoint !== undefined && (codePoint < 0x20 || codePoint === 0x7f);
}
