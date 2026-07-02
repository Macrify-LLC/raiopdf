import { describe, expect, it } from "vitest";
import { DEFAULT_PACK_ID, floridaPack, getPack, preflight } from "../src/index";

describe("Florida jurisdiction pack", () => {
  it("is the default pack and exposes machine-readable filing constraints", () => {
    expect(DEFAULT_PACK_ID).toBe("florida");
    expect(getPack()).toBe(floridaPack);
    expect(floridaPack).toMatchObject({
      id: "florida",
      name: "Florida",
      pageSize: { w: 8.5, h: 11, in: true },
      orientation: "portrait",
      clerkStampSpace: {
        firstPage: { x: 5.5, y: 8, w: 3, h: 3 },
        laterPages: null,
      },
      maxFileBytes: 25 * 1024 * 1024,
      recommendedMaxFileBytes: 24 * 1024 * 1024,
      pdfa: {
        required: false,
        preferred: true,
        flavor: "pdfa-2b",
      },
      searchableTextRequired: true,
      splitNaming: "{name} — Part {n} of {total}",
    });
  });

  it("tags every constraint with kind, authority, and verification date", () => {
    expect(floridaPack.constraints.length).toBeGreaterThan(0);

    for (const constraint of floridaPack.constraints) {
      expect(["rule", "portal"]).toContain(constraint.kind);
      expect(constraint.authority.length).toBeGreaterThan(0);
      expect(constraint.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("preflights passing Florida facts", () => {
    const report = preflight(
      {
        fileBytes: 2 * 1024 * 1024,
        searchableText: true,
        pdfaCompliant: true,
        pages: [
          {
            pageIndex: 0,
            size: { w: 8.5, h: 11, in: true },
            orientation: "portrait",
            occupiedRegions: [{ x: 0.5, y: 0.5, w: 4, h: 6 }],
          },
        ],
      },
      floridaPack,
    );

    expect(report.checks.map((check) => check.status)).toEqual([
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
  });

  it("preflights failing and warning Florida facts", () => {
    const report = preflight(
      {
        fileBytes: 24.5 * 1024 * 1024,
        searchableText: false,
        pages: [
          {
            pageIndex: 0,
            size: { w: 11, h: 8.5, in: true },
            orientation: "landscape",
            occupiedRegions: [{ x: 6, y: 9, w: 1, h: 1 }],
          },
        ],
      },
      floridaPack,
    );

    expect(Object.fromEntries(report.checks.map((check) => [check.checkId, check.status]))).toEqual({
      "page-size-orientation": "fail",
      "searchable-text": "fail",
      "file-size": "warn",
      "clerk-stamp-space": "fail",
      pdfa: "warn",
    });
  });
});
