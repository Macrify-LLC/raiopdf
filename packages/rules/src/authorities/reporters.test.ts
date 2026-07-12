import { describe, expect, it } from "vitest";
import { lookupReporter, normalizeReporterAbbreviation, reporterTable } from "./reporters.js";

describe("reporter table", () => {
  it("is non-empty", () => {
    expect(Object.keys(reporterTable).length).toBeGreaterThan(0);
  });

  it("normalizes reporter abbreviations", () => {
    expect(normalizeReporterAbbreviation("  S.   Ct.  ")).toBe("S. Ct.");
  });

  it("looks up known reporters and edition variants", () => {
    expect(lookupReporter("U.S.")).toMatchObject({
      abbreviation: "U.S.",
      name: "United States Supreme Court Reports",
      kind: "case",
    });
    expect(lookupReporter("F.3d")).toMatchObject({
      abbreviation: "F.3d",
      name: "Federal Reporter",
      kind: "case",
    });
    expect(lookupReporter("So. 3d")).toMatchObject({
      abbreviation: "So. 3d",
      name: "Southern Reporter",
      kind: "case",
    });
    expect(lookupReporter("F. Supp. 3d")).toMatchObject({
      abbreviation: "F. Supp. 3d",
      name: "Federal Supplement",
      kind: "case",
    });
  });

  it("uses generated reporter variations for lookup", () => {
    expect(lookupReporter("So.3d")).toMatchObject({
      abbreviation: "So. 3d",
      name: "Southern Reporter",
    });
    expect(lookupReporter("S.Ct.")).toMatchObject({
      abbreviation: "S. Ct.",
      name: "West's Supreme Court Reporter",
    });
  });

  it("returns undefined for unknown abbreviations", () => {
    expect(lookupReporter("Not A Reporter")).toBeUndefined();
  });

  it("normalizes unicode whitespace inside reporter abbreviations", () => {
    // U+00A0 no-break space and U+202F narrow no-break space.
    expect(normalizeReporterAbbreviation("So. 2d")).toBe("So. 2d");
    expect(normalizeReporterAbbreviation("So. 2d")).toBe("So. 2d");
    expect(lookupReporter("So. 2d")).toMatchObject({ abbreviation: "So. 2d" });
    expect(lookupReporter("So. 2d")).toMatchObject({ abbreviation: "So. 2d" });
  });

  it("falls back to a case-folded lookup when the exact-case lookup misses", () => {
    expect(lookupReporter("SO. 2D")).toMatchObject({ abbreviation: "So. 2d" });
    expect(lookupReporter("F.3D")).toMatchObject({ abbreviation: "F.3d" });
    // Exact-case entries still win outright.
    expect(lookupReporter("So. 2d")).toMatchObject({ abbreviation: "So. 2d" });
  });

  it("case-folding introduces no new collisions between different reporter series", () => {
    // The case-folded fallback index is only safe if lowercasing never maps
    // two DIFFERENT reporter series onto the same key unless the exact-case
    // compact index already collides for that key. This asserts that
    // invariant over the whole generated table so a future data regeneration
    // cannot silently break lookup correctness.
    const compact = (value: string) => value.replace(/\s+/gu, "");
    const exactCase = new Map<string, Set<string>>();
    const caseFolded = new Map<string, Set<string>>();

    for (const [lookupKey, entry] of Object.entries(reporterTable)) {
      for (const alias of [lookupKey, entry.abbreviation]) {
        const exactKey = compact(alias);
        const foldedKey = exactKey.toLowerCase();

        exactCase.set(exactKey, (exactCase.get(exactKey) ?? new Set()).add(entry.abbreviation));
        caseFolded.set(foldedKey, (caseFolded.get(foldedKey) ?? new Set()).add(entry.abbreviation));
      }
    }

    const exactCollisions = new Set(
      [...exactCase.entries()]
        .filter(([, series]) => series.size > 1)
        .map(([key]) => key.toLowerCase()),
    );
    const newCollisions = [...caseFolded.entries()]
      .filter(([key, series]) => series.size > 1 && !exactCollisions.has(key))
      .map(([key]) => key);

    expect(newCollisions).toEqual([]);
  });
});
