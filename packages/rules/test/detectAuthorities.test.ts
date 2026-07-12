import { describe, expect, it } from "vitest";
import {
  authoritiesGarbleGate,
  detectAuthorities,
  reporterTable,
  type DetectedAuthority,
  type DocumentFacts,
  type PageTextByPage,
} from "../src/index";

describe("detectAuthorities", () => {
  it("classifies, canonicalizes, and dedupes authorities with per-page hits", () => {
    const pages: PageTextByPage = [
      {
        pageIndex: 0,
        text: [
          "The motion relies on Roe v. Wade, 410 U.S. 113, and Doe v. State, 123 So.3d 456.",
          "It also cites 42 U.S.C. § 1983, Fla. R. Civ. P. 1.510, and U.S. Const. amend. XIV.",
        ].join(" "),
      },
      {
        pageIndex: 1,
        text: [
          "The same authorities appear as 410 U. S. 113 and 42 USC section 1983.",
          "Additional authority includes Fla. Stat. § 90.702 and O.C.G.A. § 9-11-56.",
        ].join(" "),
      },
      {
        pageIndex: 2,
        text: [
          "Other rules include Fed. R. Evid. 702 and Ind. Trial Rule 56.",
          "Constitutional text includes Fla. Const. art. V, § 3 and Ind. Code sec. 34-13-3-5.",
        ].join(" "),
      },
    ];

    const detected = detectAuthorities(pages, reporterTable);

    expect(canonicalMap(detected)).toEqual({
      "123 So. 3d 456": { kind: "case", pages: [0] },
      "410 U.S. 113": { kind: "case", pages: [0, 1] },
      "42 U.S.C. § 1983": { kind: "statute", pages: [0, 1] },
      "Fed. R. Evid. 702": { kind: "rule", pages: [2] },
      "Fla. Const. art. V, § 3": { kind: "constitutional", pages: [2] },
      "Fla. R. Civ. P. 1.510": { kind: "rule", pages: [0] },
      "Fla. Stat. § 90.702": { kind: "statute", pages: [1] },
      "Ind. Code § 34-13-3-5": { kind: "statute", pages: [2] },
      "Ind. Trial Rule 56": { kind: "rule", pages: [2] },
      "O.C.G.A. § 9-11-56": { kind: "statute", pages: [1] },
      "U.S. Const. amend. XIV": { kind: "constitutional", pages: [0] },
    });
    expect(detected.find((authority) => authority.canonical === "410 U.S. 113")?.id).toMatch(
      /^authority-[a-z0-9]+$/u,
    );
  });

  it("does not emit authorities for dates, dollar amounts, or plain numbers", () => {
    const pages: PageTextByPage = [
      {
        pageIndex: 4,
        text: "On 01/02/2024 the invoice listed $550.00, 1214 pages, and no legal citations.",
      },
    ];

    expect(detectAuthorities(pages, reporterTable)).toEqual([]);
  });

  it("preserves canonicalization for ordinary citation variants", () => {
    const pages: PageTextByPage = [
      {
        pageIndex: 0,
        text: [
          "The authorities include 42 USC section 1983 and O.C.G.A. sec. 9-11-56.",
          "Constitutional references include U.S. Const. article III, section 2 and Florida Const. article V, section 3.",
          "The rules citation is Fla. R. Jud. Admin. 2.420.",
        ].join(" "),
      },
    ];

    expect(canonicalMap(detectAuthorities(pages, reporterTable))).toEqual({
      "42 U.S.C. § 1983": { kind: "statute", pages: [0] },
      "Fla. Const. art. V, § 3": { kind: "constitutional", pages: [0] },
      "Fla. R. Jud. Admin. 2.420": { kind: "rule", pages: [0] },
      "O.C.G.A. § 9-11-56": { kind: "statute", pages: [0] },
      "U.S. Const. art. III, § 2": { kind: "constitutional", pages: [0] },
    });
  });

  it("keeps ALL-CAPS and non-breaking-space case citations instead of dropping them", () => {
    const pages: PageTextByPage = [
      { pageIndex: 0, text: "THE COURT ERRED. SEE 123 SO. 2D 456 AND 550 F.3D 1214." },
      { pageIndex: 1, text: "See 123 So. 2d 456 and 123 So. 2d 456 again." },
    ];

    expect(canonicalMap(detectAuthorities(pages, reporterTable))).toEqual({
      "123 So. 2d 456": { kind: "case", pages: [0, 1] },
      "550 F.3d 1214": { kind: "case", pages: [0] },
    });
  });

  it("emits one authority per section for §§ lists and dedupes with standalone cites", () => {
    const pages: PageTextByPage = [
      {
        pageIndex: 0,
        text: "Jurisdiction rests on 28 U.S.C. §§ 1331, 1332. Immunity is waived by Fla. Stat. §§ 768.28(1), (5).",
      },
      { pageIndex: 1, text: "Diversity jurisdiction under 28 U.S.C. § 1332 is contested." },
    ];

    expect(canonicalMap(detectAuthorities(pages, reporterTable))).toEqual({
      "28 U.S.C. § 1331": { kind: "statute", pages: [0] },
      "28 U.S.C. § 1332": { kind: "statute", pages: [0, 1] },
      "Fla. Stat. § 768.28(1)": { kind: "statute", pages: [0] },
      "Fla. Stat. § 768.28(5)": { kind: "statute", pages: [0] },
    });
  });

  it("continues nested parentheticals from the immediate parent, not the bare statute", () => {
    const pages: PageTextByPage = [
      { pageIndex: 0, text: "Sovereign immunity is waived by Fla. Stat. §§ 768.28(1)(a), (b)." },
    ];

    expect(canonicalMap(detectAuthorities(pages, reporterTable))).toEqual({
      "Fla. Stat. § 768.28(1)(a)": { kind: "statute", pages: [0] },
      "Fla. Stat. § 768.28(1)(b)": { kind: "statute", pages: [0] },
    });
  });

  it("does not swallow prose after a section list", () => {
    const pages: PageTextByPage = [
      { pageIndex: 0, text: "Under 28 U.S.C. §§ 1331, and the court held otherwise." },
    ];

    expect(canonicalMap(detectAuthorities(pages, reporterTable))).toEqual({
      "28 U.S.C. § 1331": { kind: "statute", pages: [0] },
    });
  });

  it("collapses every spelling of a constitutional provision to one canonical row", () => {
    const pages: PageTextByPage = [
      { pageIndex: 0, text: "U.S. Const. art. III, § 2 controls." },
      { pageIndex: 1, text: "U.S. Const. art. III § 2 controls." },
      { pageIndex: 2, text: "U.S. Const. art. III sec. 2 controls." },
      { pageIndex: 3, text: "U.S. Const. article III section 2 controls." },
    ];

    const detected = detectAuthorities(pages, reporterTable);

    expect(canonicalMap(detected)).toEqual({
      "U.S. Const. art. III, § 2": { kind: "constitutional", pages: [0, 1, 2, 3] },
    });
    for (const authority of detected) {
      expect(authority.canonical).not.toContain("§ .");
    }
  });

  it("detects the post-2021 Florida general practice and judicial administration rules", () => {
    const pages: PageTextByPage = [
      {
        pageIndex: 0,
        text: "Confidentiality is governed by Fla. R. Gen. Prac. & Jud. Admin. 2.425 and Florida Rule of General Practice and Judicial Administration 2.425.",
      },
    ];

    expect(canonicalMap(detectAuthorities(pages, reporterTable))).toEqual({
      "Fla. R. Gen. Prac. & Jud. Admin. 2.425": { kind: "rule", pages: [0] },
    });
  });
});

describe("authoritiesGarbleGate", () => {
  it("blocks detection when OCR text is garbled", () => {
    const facts = baseFacts({
      textLayerCoverage: {
        imageOnlyPages: [],
        mixedPages: [],
        textPages: [0, 1, 2],
        garbledPages: [
          {
            pageIndex: 1,
            confidence: 0.8,
            reason: "low_alpha_entropy",
            puaRatio: 0,
            replacementRatio: 0,
            alphaRatio: 0.2,
          },
        ],
      },
    });

    expect(authoritiesGarbleGate(facts)).toEqual({
      blocked: true,
      garbledPages: [1],
      guidance:
        "The document's hidden searchable text looks garbled on 1 of 3 pages; running Make Searchable again is recommended.",
    });
  });

  it("allows detection when there are no garbled pages", () => {
    const facts = baseFacts({
      textLayerCoverage: {
        imageOnlyPages: [],
        mixedPages: [],
        textPages: [0],
        garbledPages: [],
      },
    });

    expect(authoritiesGarbleGate(facts)).toEqual({
      blocked: false,
      garbledPages: [],
    });
  });
});

function canonicalMap(
  detected: DetectedAuthority[],
): Record<string, { kind: string; pages: number[] }> {
  return Object.fromEntries(
    detected.map((authority) => [
      authority.canonical,
      {
        kind: authority.kind,
        pages: authority.hits.map((hit) => hit.pageIndex),
      },
    ]),
  );
}

function baseFacts(overrides: Partial<DocumentFacts>): DocumentFacts {
  return {
    pages: [
      {
        pageIndex: 0,
        size: { w: 8.5, h: 11, in: true },
        orientation: "portrait",
      },
      {
        pageIndex: 1,
        size: { w: 8.5, h: 11, in: true },
        orientation: "portrait",
      },
      {
        pageIndex: 2,
        size: { w: 8.5, h: 11, in: true },
        orientation: "portrait",
      },
    ],
    ...overrides,
  };
}
