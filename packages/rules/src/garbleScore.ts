import type { GarbledPageInfo, GarbleReason } from "./types.js";

export const GARBLE_MIN_NON_WHITESPACE_CHARS = 40;
export const GARBLE_ALPHA_RATIO_THRESHOLD = 0.60;
export const GARBLE_PUNCT_OR_SYMBOL_RATIO_THRESHOLD = 0.25;
export const GARBLE_VOWELLESS_TOKEN_RATIO_THRESHOLD = 0.15;

const TOKEN_PATTERN = /[^\W\d_]{2,}/gu;
const LATIN_VOWEL_PATTERN = /[aeiouyæœø]/iu;
const REPLACEMENT_CHAR = "\uFFFD";

export function scoreGarbledPage(text: string, pageIndex = 0): GarbledPageInfo | null {
  const chars = [...text].filter((char) => !/\s/u.test(char));
  const totalChars = chars.length;
  if (totalChars < GARBLE_MIN_NON_WHITESPACE_CHARS) {
    return null;
  }

  let letterCount = 0;
  let punctOrSymbolCount = 0;
  let puaCount = 0;
  let replacementCount = 0;

  for (const char of chars) {
    if (/\p{L}/u.test(char)) {
      letterCount += 1;
    }
    if (char === REPLACEMENT_CHAR) {
      replacementCount += 1;
    } else if (/[\p{P}\p{S}]/u.test(char)) {
      punctOrSymbolCount += 1;
    }
    if (isPrivateUseCodePoint(char.codePointAt(0) ?? 0)) {
      puaCount += 1;
    }
  }

  const alphaRatio = letterCount / totalChars;
  const punctRatio = punctOrSymbolCount / totalChars;
  const puaRatio = puaCount / totalChars;
  const replacementRatio = replacementCount / totalChars;
  const tripsBrokenCMap =
    alphaRatio < GARBLE_ALPHA_RATIO_THRESHOLD &&
    punctRatio > GARBLE_PUNCT_OR_SYMBOL_RATIO_THRESHOLD;

  if (!tripsBrokenCMap) {
    return null;
  }

  return {
    pageIndex,
    confidence: garbleConfidence(alphaRatio, punctRatio, vowellessTokenRatio(text)),
    reason: garbleReason(puaRatio, replacementRatio),
    puaRatio,
    replacementRatio,
    alphaRatio,
  };
}

function garbleConfidence(alphaRatio: number, punctRatio: number, vowellessRatio: number): number {
  const alphaDistance = (GARBLE_ALPHA_RATIO_THRESHOLD - alphaRatio) / GARBLE_ALPHA_RATIO_THRESHOLD;
  const punctDistance =
    (punctRatio - GARBLE_PUNCT_OR_SYMBOL_RATIO_THRESHOLD) /
    (1 - GARBLE_PUNCT_OR_SYMBOL_RATIO_THRESHOLD);
  const structuralConfidence = (clamp01(alphaDistance) + clamp01(punctDistance)) / 2;
  const vowellessBoost = vowellessRatio > GARBLE_VOWELLESS_TOKEN_RATIO_THRESHOLD
    ? clamp01((vowellessRatio - GARBLE_VOWELLESS_TOKEN_RATIO_THRESHOLD) /
      (1 - GARBLE_VOWELLESS_TOKEN_RATIO_THRESHOLD)) * 0.20
    : 0;

  return clamp01(structuralConfidence + vowellessBoost);
}

function garbleReason(puaRatio: number, replacementRatio: number): GarbleReason {
  if (puaRatio > 0 || replacementRatio > 0) {
    return "combined";
  }
  return "low_alpha_entropy";
}

function vowellessTokenRatio(text: string): number {
  const tokens = text.match(TOKEN_PATTERN) ?? [];
  if (tokens.length === 0) {
    return 0;
  }

  const vowellessTokens = tokens.filter((token) => !LATIN_VOWEL_PATTERN.test(token.normalize("NFD")));
  return vowellessTokens.length / tokens.length;
}

function isPrivateUseCodePoint(codePoint: number): boolean {
  return (codePoint >= 0xE000 && codePoint <= 0xF8FF) ||
    (codePoint >= 0xF0000 && codePoint <= 0xFFFFD) ||
    (codePoint >= 0x100000 && codePoint <= 0x10FFFD);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
