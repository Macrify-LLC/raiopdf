import { describe, expect, it } from "vitest";
import { formatPageRangeSpec, PageRangeError, parsePageRanges } from "../src/index";

describe("parsePageRanges", () => {
  it("treats undefined as every page", () => {
    expect(parsePageRanges(undefined, 5)).toBe("all");
  });

  it("treats a blank/whitespace-only spec as every page", () => {
    expect(parsePageRanges("", 5)).toBe("all");
    expect(parsePageRanges("   ", 5)).toBe("all");
  });

  it("parses a single page as a one-based-to-zero-based index", () => {
    expect(parsePageRanges("1", 5)).toEqual([0]);
    expect(parsePageRanges("5", 5)).toEqual([4]);
  });

  it("parses an inclusive range", () => {
    expect(parsePageRanges("2-4", 5)).toEqual([1, 2, 3]);
  });

  it("parses a mix of pages and ranges, tolerates whitespace", () => {
    expect(parsePageRanges(" 1 , 3-5 , 7 ", 10)).toEqual([0, 2, 3, 4, 6]);
  });

  it("deduplicates and normalizes overlapping entries into ascending order", () => {
    expect(parsePageRanges("5,1-3,2-4", 10)).toEqual([0, 1, 2, 3, 4]);
  });

  it("rejects an out-of-bounds page with a typed error naming the page and the checked count", () => {
    const error = catchPageRangeError(() => parsePageRanges("1,9", 5));
    expect(error.code).toBe("out-of-bounds");
    expect(error.message).toContain("Page 9");
    expect(error.message).toContain("5-page document");
  });

  it("rejects page 0 as out of bounds (1-based input)", () => {
    const error = catchPageRangeError(() => parsePageRanges("0", 5));
    expect(error.code).toBe("out-of-bounds");
  });

  it("rejects a reversed range with a typed error suggesting the fix", () => {
    const error = catchPageRangeError(() => parsePageRanges("5-2", 10));
    expect(error.code).toBe("reversed-range");
    expect(error.message).toContain("2-5");
  });

  it("rejects unparsable garbage with a typed syntax error", () => {
    const error = catchPageRangeError(() => parsePageRanges("abc", 5));
    expect(error.code).toBe("invalid-syntax");
  });

  it("rejects an empty entry between commas", () => {
    const error = catchPageRangeError(() => parsePageRanges("1,,3", 5));
    expect(error.code).toBe("invalid-syntax");
  });
});

describe("formatPageRangeSpec", () => {
  it('returns null for "all" and "first"', () => {
    expect(formatPageRangeSpec("all")).toBeNull();
    expect(formatPageRangeSpec("first")).toBeNull();
  });

  it("collapses consecutive zero-based indexes into a 1-based range", () => {
    expect(formatPageRangeSpec([0, 1, 2, 6])).toBe("1-3,7");
  });

  it("normalizes duplicate/unsorted input", () => {
    expect(formatPageRangeSpec([4, 0, 1, 4, 2])).toBe("1-3,5");
  });

  it("round-trips through parsePageRanges", () => {
    const parsed = parsePageRanges("1-3,7", 10);
    expect(formatPageRangeSpec(parsed)).toBe("1-3,7");
  });
});

function catchPageRangeError(run: () => unknown): PageRangeError {
  try {
    run();
  } catch (error) {
    if (error instanceof PageRangeError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected parsePageRanges to throw a PageRangeError.");
}
