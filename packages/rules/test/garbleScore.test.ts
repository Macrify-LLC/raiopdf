import { describe, expect, it } from "vitest";
import {
  GARBLE_ALPHA_RATIO_THRESHOLD,
  GARBLE_MIN_NON_WHITESPACE_CHARS,
  GARBLE_PUNCT_OR_SYMBOL_RATIO_THRESHOLD,
  scoreGarbledPage,
} from "../src/index";

describe("scoreGarbledPage", () => {
  it("flags synthetic broken-CMap-style letter and punctuation noise", () => {
    const text = "xqz!@#$ brt%^&* crw+=? plk[]{} mnn<>/ ".repeat(4);

    const score = scoreGarbledPage(text, 2);

    expect(score).toMatchObject({
      pageIndex: 2,
      reason: "low_alpha_entropy",
      puaRatio: 0,
      replacementRatio: 0,
    });
    expect(score?.alphaRatio).toBeLessThan(GARBLE_ALPHA_RATIO_THRESHOLD);
    expect(score?.confidence).toBeGreaterThan(0);
  });

  it("does not let pure private-use glyphs trigger the broken-CMap detector", () => {
    const text = "\uE000".repeat(GARBLE_MIN_NON_WHITESPACE_CHARS + 10);

    expect(scoreGarbledPage(text)).toBeNull();
  });

  it("does not let replacement characters trigger the broken-CMap detector by themselves", () => {
    const text = "\uFFFD".repeat(GARBLE_MIN_NON_WHITESPACE_CHARS + 10);

    expect(scoreGarbledPage(text)).toBeNull();
  });

  it("returns reserved PUA and replacement ratios when structural garble also trips", () => {
    const text = "xqz!@#$ brt%^&* \uE000 crw+=? \uFFFD plk[]{} mnn<>/ ".repeat(4);

    const score = scoreGarbledPage(text);

    expect(score?.reason).toBe("combined");
    expect(score?.puaRatio).toBeGreaterThan(0);
    expect(score?.replacementRatio).toBeGreaterThan(0);
  });

  it("keeps clean English text clean", () => {
    const text = "This motion asks the Court to enter an order after review of the record and exhibits.";

    expect(scoreGarbledPage(text)).toBeNull();
  });

  it("keeps clean accented Spanish text clean", () => {
    const text = "El señor García presentó una moción válida con información pública y decisión del tribunal.";

    expect(scoreGarbledPage(text)).toBeNull();
  });

  it("keeps CJK text clean because Unicode letters count as letters", () => {
    const text = "本文件包含可搜索文本并且应当保持为干净的文本层以便法院审查。".repeat(3);

    expect(scoreGarbledPage(text)).toBeNull();
  });

  it("keeps citation, Bates, and number-heavy lines clean", () => {
    const text = "CASE NO. 2024-CA-000123; BATES 000001-000040; Fla. R. Civ. P. 1.510.";

    expect(scoreGarbledPage(text)).toBeNull();
  });

  it("does not score short captions", () => {
    expect(scoreGarbledPage("MOTION TO COMPEL")).toBeNull();
  });

  it("uses the same pure scorer result for node and browser callers", () => {
    const text = "xqz!@#$ brt%^&* crw+=? plk[]{} mnn<>/ ".repeat(3);
    const nodeCaller = (input: string) => scoreGarbledPage(input, 0);
    const browserCaller = (input: string) => scoreGarbledPage(input, 0);

    expect(nodeCaller(text)).toEqual(browserCaller(text));
    expect(nodeCaller(text)?.alphaRatio).toBeLessThan(GARBLE_ALPHA_RATIO_THRESHOLD);
    expect(nodeCaller(text)?.confidence).toBeGreaterThan(0);
    expect(nodeCaller(text)?.confidence).toBeLessThanOrEqual(1);
    expect(nodeCaller(text)?.puaRatio).toBe(0);
    expect(nodeCaller(text)?.replacementRatio).toBe(0);
    expect(nodeCaller(text)).toMatchObject({ reason: "low_alpha_entropy" });
    expect(nodeCaller(text)?.alphaRatio).toBeLessThan(0.60);
    expect(GARBLE_PUNCT_OR_SYMBOL_RATIO_THRESHOLD).toBe(0.25);
  });
});
