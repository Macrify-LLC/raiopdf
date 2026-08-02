import { describe, expect, it } from "vitest";
import {
  MAX_EXHIBIT_INDEX,
  exhibitLabelLines,
  formatExhibitIdentifier,
  formatExhibitLabel,
  parseIdentifier,
  toLetters,
} from "./exhibitLabels";

describe("toLetters", () => {
  it("runs A through Z before widening", () => {
    expect(toLetters(0)).toBe("A");
    expect(toLetters(25)).toBe("Z");
  });

  it("wraps Z to AA and keeps counting", () => {
    expect(toLetters(26)).toBe("AA");
    expect(toLetters(27)).toBe("AB");
    expect(toLetters(51)).toBe("AZ");
    expect(toLetters(52)).toBe("BA");
    expect(toLetters(701)).toBe("ZZ");
    expect(toLetters(702)).toBe("AAA");
  });
});

describe("formatExhibitIdentifier", () => {
  it("numbers are one-based", () => {
    expect(formatExhibitIdentifier("numbers", 0)).toBe("1");
    expect(formatExhibitIdentifier("numbers", 11)).toBe("12");
  });

  it("none renders no identifier", () => {
    expect(formatExhibitIdentifier("none", 4)).toBe("");
  });
});

describe("formatExhibitLabel", () => {
  it("keeps the binder's prefix-plus-identifier shape", () => {
    expect(formatExhibitLabel("Exhibit", "letters", 0)).toBe("Exhibit A");
    expect(formatExhibitLabel("Exhibit", "numbers", 11)).toBe("Exhibit 12");
  });

  it("trims the prefix and falls back when it is blank", () => {
    expect(formatExhibitLabel("  Plaintiff's Exhibit  ", "numbers", 0)).toBe(
      "Plaintiff's Exhibit 1",
    );
    expect(formatExhibitLabel("   ", "letters", 1)).toBe("Exhibit B");
  });

  it("drops the identifier entirely for the none style", () => {
    expect(formatExhibitLabel("Confidential", "none", 3)).toBe("Confidential");
  });

  it("appends a suffix after the identifier", () => {
    expect(formatExhibitLabel("Exhibit", "letters", 2, "(Smith Depo)")).toBe(
      "Exhibit C (Smith Depo)",
    );
    expect(formatExhibitLabel("Exhibit", "none", 2, "  ")).toBe("Exhibit");
  });
});

describe("exhibitLabelLines", () => {
  it("stacks the identifier under the prefix", () => {
    expect(exhibitLabelLines("Plaintiff's Exhibit", "numbers", 11, "stacked")).toEqual([
      "Plaintiff's Exhibit",
      "12",
    ]);
  });

  it("keeps the suffix on the identifier line when stacked", () => {
    expect(exhibitLabelLines("Exhibit", "letters", 0, "stacked", "(Smith Depo)")).toEqual([
      "Exhibit",
      "A (Smith Depo)",
    ]);
  });

  it("renders one line when inline", () => {
    expect(exhibitLabelLines("Exhibit", "letters", 0, "inline")).toEqual(["Exhibit A"]);
  });

  it("never emits an empty second line when there is nothing to stack", () => {
    expect(exhibitLabelLines("Confidential", "none", 0, "stacked")).toEqual(["Confidential"]);
  });
});

describe("parseIdentifier", () => {
  it("reads a typed number back as a zero-based index", () => {
    expect(parseIdentifier("1")).toBe(0);
    expect(parseIdentifier("12")).toBe(11);
    expect(parseIdentifier(" 12 ")).toBe(11);
  });

  it("reads typed letters back as a zero-based index", () => {
    expect(parseIdentifier("A")).toBe(0);
    expect(parseIdentifier("Z")).toBe(25);
    expect(parseIdentifier("AA")).toBe(26);
    expect(parseIdentifier("AB")).toBe(27);
    expect(parseIdentifier("ab")).toBe(27);
  });

  it("round-trips every rendered identifier", () => {
    for (const index of [0, 1, 25, 26, 27, 51, 52, 701, 702, 5000]) {
      expect(parseIdentifier(toLetters(index))).toBe(index);
      expect(parseIdentifier(formatExhibitIdentifier("numbers", index))).toBe(index);
    }
  });

  it("rejects garbage", () => {
    for (const input of [
      "",
      "   ",
      "0",
      "-1",
      "1.5",
      "12A",
      "A1",
      "A B",
      "exhibit",
      "Ⅻ",
      "①",
      "1e3",
      "+3",
    ]) {
      expect(parseIdentifier(input)).toBeNull();
    }
  });

  it("rejects identifiers past the supported range", () => {
    expect(parseIdentifier(String(MAX_EXHIBIT_INDEX + 1))).toBe(MAX_EXHIBIT_INDEX);
    expect(parseIdentifier(String(MAX_EXHIBIT_INDEX + 2))).toBeNull();
    expect(parseIdentifier("AAAAAAAA")).toBeNull();
    expect(parseIdentifier("99999999999999999999")).toBeNull();
  });
});
