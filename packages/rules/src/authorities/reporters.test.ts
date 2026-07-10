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
});
