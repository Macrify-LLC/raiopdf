import { describe, expect, it } from "vitest";
import { DEFAULT_PACK_ID, floridaPack, getPack, preflight } from "../src/index";
import { loadJurisdictionPackFromJson } from "../src/packLoader";

describe("Florida jurisdiction pack", () => {
  it("is the default pack and exposes machine-readable filing constraints", () => {
    expect(DEFAULT_PACK_ID).toBe("florida");
    expect(getPack()).toBe(floridaPack);
    expect(floridaPack).toMatchObject({
      id: "florida",
      name: "Florida",
      packVersion: "1.0.0",
      guidanceNote: "These checks are guidance only — not legal advice…tell us at support@macrify.me",
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

  it("tags every constraint with kind, authority, verification date, and applicability", () => {
    expect(floridaPack.constraints.length).toBeGreaterThan(0);

    for (const constraint of floridaPack.constraints) {
      expect(["rule", "portal"]).toContain(constraint.kind);
      expect(constraint.authority.length).toBeGreaterThan(0);
      expect(constraint.lastVerified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(constraint.applicability).toEqual({ scope: "statewide" });
    }
  });

  it("rejects malformed JSON packs with descriptive schema errors", () => {
    expect(() => loadJurisdictionPackFromJson("{", "broken pack")).toThrow(
      /broken pack: invalid JSON/,
    );

    expect(() => {
      loadJurisdictionPackFromJson(
        JSON.stringify({
          id: "broken",
          name: "Broken",
          packVersion: "not-semver",
        }),
        "broken pack",
      );
    }).toThrow(/broken pack\.packVersion must be a semver string/);
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

  it("preflights warning and fixing Florida facts", () => {
    const report = preflight(
      {
        fileBytes: 24.5 * 1024 * 1024,
        searchableText: false,
        pdfaCompliant: false,
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
      "page-size-orientation": "warn",
      "searchable-text": "warn",
      "file-size": "fix",
      "clerk-stamp-space": "warn",
      pdfa: "fix",
    });
  });

  it("reports unknown when required facts are missing", () => {
    const report = preflight(
      {
        pages: [
          {
            pageIndex: 0,
            size: { w: 8.5, h: 11, in: true },
            orientation: "portrait",
          },
        ],
      },
      floridaPack,
    );

    expect(Object.fromEntries(report.checks.map((check) => [check.checkId, check.status]))).toEqual({
      "page-size-orientation": "pass",
      "searchable-text": "unknown",
      "file-size": "unknown",
      "clerk-stamp-space": "unknown",
      pdfa: "unknown",
    });
  });

  it("never emits fix for rule-kind constraints", () => {
    const ruleOnlyFileSizePack = {
      ...floridaPack,
      constraints: floridaPack.constraints.map((constraint) => {
        if (constraint.id !== "file-size") {
          return constraint;
        }

        return {
          ...constraint,
          kind: "rule" as const,
        };
      }),
    };

    const report = preflight(
      {
        fileBytes: 30 * 1024 * 1024,
        searchableText: true,
        pdfaCompliant: true,
        pages: [
          {
            pageIndex: 0,
            size: { w: 8.5, h: 11, in: true },
            orientation: "portrait",
            occupiedRegions: [],
          },
        ],
      },
      ruleOnlyFileSizePack,
    );

    expect(report.checks.find((check) => check.checkId === "file-size")).toMatchObject({
      kind: "rule",
      status: "warn",
    });
  });
});
