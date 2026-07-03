import { describe, expect, it } from "vitest";
import manifestJson from "../data/packs.manifest.json";
import {
  DEFAULT_PACK_ID,
  getPack,
  packJsonSha256,
  preflight,
  shouldConvertToPdfA,
  unknownPack,
  verifyAppDataPackIntegrity,
  verifyBundledPackIntegrity,
  type PackManifest,
  type PdfAStance,
} from "../src/index";
import { loadJurisdictionPackFromJson } from "../src/packLoader";

describe("Florida jurisdiction pack", () => {
  const floridaPack = getPack();

  it("is the default pack and exposes machine-readable filing constraints", () => {
    expect(DEFAULT_PACK_ID).toBe("florida");
    expect(getPack()).toMatchObject({ id: "florida" });
    expect(floridaPack).toMatchObject({
      id: "florida",
      name: "Florida",
      schemaVersion: 2,
      packVersion: "2.0.0",
      jurisdiction: "Florida",
      courtSystem: "State trial and appellate courts",
      portal: "Florida Courts E-Filing Portal",
      guidanceNote: "These checks are guidance only — not legal advice…tell us at support@macrify.me",
      pageSize: { w: 8.5, h: 11, in: true },
      orientation: "portrait",
      clerkStampSpace: {
        firstPage: { x: 5.5, y: 8, w: 3, h: 3 },
        laterPages: null,
      },
      maxFileBytes: 25 * 1024 * 1024,
      recommendedMaxFileBytes: 24 * 1024 * 1024,
      maxEnvelopeBytes: 25 * 1024 * 1024,
      filenameMaxChars: 150,
      pdfa: {
        stance: "preferred",
        prepDefault: "on",
        flavor: "pdfa-2b",
      },
      ocr: {
        stance: "required",
        prepDefault: "on",
      },
      metadataScrub: {
        stance: "unknown",
        prepDefault: "on",
      },
      splitNaming: "{name} — Part {n} of {total}",
    });
  });

  it("snapshots the Florida schema v2 migration fields", () => {
    expect({
      schemaVersion: floridaPack.schemaVersion,
      jurisdiction: floridaPack.jurisdiction,
      courtSystem: floridaPack.courtSystem,
      portal: floridaPack.portal,
      maxEnvelopeBytes: floridaPack.maxEnvelopeBytes,
      filenameMaxChars: floridaPack.filenameMaxChars,
      userConfigurable: floridaPack.userConfigurable,
      pdfa: floridaPack.pdfa,
      activeContent: floridaPack.activeContent,
      encryption: floridaPack.encryption,
      embeddedFiles: floridaPack.embeddedFiles,
      metadataScrub: floridaPack.metadataScrub,
      ocr: floridaPack.ocr,
      flattenForms: floridaPack.flattenForms,
    }).toMatchInlineSnapshot(`
      {
        "activeContent": {
          "authority": "Florida Courts Technology Standards v4.0, adopted May 2025",
          "condition": "when submitted as PDF/A",
          "lastVerified": "2026-07-02",
          "note": "JavaScript and form actions are prohibited PDF/A document-intelligence elements.",
          "prepDefault": "on",
          "stance": "prohibited",
        },
        "courtSystem": "State trial and appellate courts",
        "embeddedFiles": {
          "authority": "Florida Courts Technology Standards v4.0, adopted May 2025",
          "condition": "when submitted as PDF/A",
          "lastVerified": "2026-07-02",
          "prepDefault": "on",
          "stance": "prohibited",
        },
        "encryption": {
          "authority": "Florida Courts Technology Standards v4.0, adopted May 2025; Florida Courts E-Filing Authority PDF/A FAQ, revised Aug. 2021",
          "condition": "when submitted as PDF/A; encryption-key digital signatures are not passed through by the Portal",
          "lastVerified": "2026-07-02",
          "prepDefault": "off",
          "stance": "prohibited",
        },
        "filenameMaxChars": 150,
        "flattenForms": {
          "authority": "Florida Courts Technology Standards v4.0, adopted May 2025",
          "condition": "form fields and actions are prohibited when submitted as PDF/A",
          "lastVerified": "2026-07-02",
          "prepDefault": "off",
          "stance": "prohibited",
        },
        "jurisdiction": "Florida",
        "maxEnvelopeBytes": 26214400,
        "metadataScrub": {
          "authority": "Florida Courts Technology Standards v4.0, adopted May 2025; Florida Courts E-Filing Authority PDF/A FAQ, revised Aug. 2021",
          "lastVerified": "2026-07-02",
          "note": "Formal standards do not impose a general metadata-scrub requirement, but the Portal PDF/A FAQ describes a conflict: scrubbing the pdfcreator tag can make PDF/A conformance verification fail.",
          "prepDefault": "on",
          "stance": "unknown",
        },
        "ocr": {
          "authority": "Florida Courts Technology Standards v4.0, adopted May 2025",
          "lastVerified": "2026-07-02",
          "note": "PDF documents filed with the Portal must be searchable; scanned documents should be OCR'd.",
          "prepDefault": "on",
          "stance": "required",
        },
        "pdfa": {
          "authority": "Florida Courts Technology Standards v4.0, adopted May 2025; Florida Courts E-Filing Authority PDF/A FAQ, revised Aug. 2021",
          "flavor": "pdfa-2b",
          "lastVerified": "2026-07-02",
          "note": "The ePortal's PDF/A check is informational only; non-conformant files still file. PDF/A-2a is preferred for born-digital documents, while PDF/A-2b is acceptable for scanned documents. Full metadata scrubbing can remove the pdfcreator tag needed by PDF/A conformance checks.",
          "prepDefault": "on",
          "stance": "preferred",
        },
        "portal": "Florida Courts E-Filing Portal",
        "schemaVersion": 2,
        "userConfigurable": {
          "maxEnvelopeBytes": true,
          "maxFileBytes": true,
        },
      }
    `);
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
          schemaVersion: 2,
          name: "Broken",
          packVersion: "not-semver",
        }),
        "broken pack",
      );
    }).toThrow(/broken pack\.packVersion must be a semver string/);
  });

  it("accepts schema v2 packs and rejects newer schema versions with an update message", () => {
    expect(loadJurisdictionPackFromJson(JSON.stringify(floridaPack), "schema v2 pack")).toMatchObject({
      id: "florida",
      schemaVersion: 2,
    });

    const futurePack = {
      ...JSON.parse(JSON.stringify(floridaPack)),
      schemaVersion: 3,
    };

    expect(() => loadJurisdictionPackFromJson(JSON.stringify(futurePack), "future pack")).toThrow(
      /Update RaioPDF to load this jurisdiction pack/,
    );
  });

  it("preflights passing Florida facts", () => {
    const report = preflight(
      {
        filename: "motion.pdf",
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
      "pass",
    ]);
  });

  it("preflights warning-only Florida facts", () => {
    const report = preflight(
      {
        filename: "motion.pdf",
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
      "file-size": "warn",
      filename: "pass",
      "clerk-stamp-space": "warn",
      pdfa: "warn",
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
      filename: "unknown",
      "clerk-stamp-space": "unknown",
      pdfa: "unknown",
    });
  });

  it("uses one warning status vocabulary for rule and portal constraints", () => {
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
        filename: "motion.pdf",
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

  it("keeps hard file-size caps on the cap-exceeded branch", () => {
    const report = preflight(
      {
        filename: "motion.pdf",
        fileBytes: 26 * 1024 * 1024,
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
      floridaPack,
    );

    expect(report.checks.find((check) => check.checkId === "file-size")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("portal cap"),
    });
  });

  it("allow-lists PDF/A conversion to required and preferred stances only", () => {
    const stances: Record<PdfAStance, boolean> = {
      required: true,
      preferred: true,
      accepted: false,
      prohibited: false,
      unknown: false,
    };

    for (const [stance, expected] of Object.entries(stances)) {
      const pack = {
        ...floridaPack,
        pdfa: { ...floridaPack.pdfa, stance: stance as PdfAStance },
      };

      expect(shouldConvertToPdfA(pack), `stance ${stance}`).toBe(expected);
    }

    expect(shouldConvertToPdfA({
      ...floridaPack,
      pdfa: { ...floridaPack.pdfa, stance: "preferred", prepDefault: "off" },
    })).toBe(false);
  });

  it("preflights PDF/A per stance without ever converting outside the allow-list", () => {
    const packWithStance = (stance: PdfAStance) => ({
      ...floridaPack,
      pdfa: { ...floridaPack.pdfa, stance },
    });
    const facts = (pdfaCompliant: boolean | undefined) => ({
      pages: [
        {
          pageIndex: 0,
          size: { w: 8.5, h: 11, in: true as const },
          orientation: "portrait" as const,
        },
      ],
      ...(pdfaCompliant === undefined ? {} : { pdfaCompliant }),
    });
    const pdfaStatus = (stance: PdfAStance, pdfaCompliant: boolean | undefined) =>
      preflight(facts(pdfaCompliant), packWithStance(stance))
        .checks.find((check) => check.checkId === "pdfa")?.status;

    expect(pdfaStatus("required", false)).toBe("warn");
    expect(pdfaStatus("preferred", false)).toBe("warn");
    expect(pdfaStatus("preferred", true)).toBe("pass");
    expect(pdfaStatus("accepted", false)).toBe("pass");
    expect(pdfaStatus("unknown", false)).toBe("unknown");
    // A prohibited portal treats an already-PDF/A document as outstanding portal work,
    // and refuses to call unverified facts safe.
    expect(pdfaStatus("prohibited", true)).toBe("warn");
    expect(pdfaStatus("prohibited", false)).toBe("pass");
    expect(pdfaStatus("prohibited", undefined)).toBe("unknown");
  });

  it("rejects packs whose pdfa stance is missing or invalid", () => {
    const rawPack = JSON.parse(JSON.stringify(floridaPack)) as Record<string, unknown>;
    (rawPack.pdfa as Record<string, unknown>).stance = "mandatory";

    expect(() => loadJurisdictionPackFromJson(JSON.stringify(rawPack), "bad stance")).toThrow(
      /bad stance\.pdfa\.stance must be/,
    );
  });

  it("checks selection-level envelope size, filename limits, and collisions", () => {
    const under = preflight(
      {
        filename: "motion.pdf",
        fileBytes: 1,
        searchableText: true,
        pdfaCompliant: true,
        pages: [],
      },
      floridaPack,
      {
        files: [
          { filename: "motion.pdf", fileBytes: 10 * 1024 * 1024 },
          { filename: "exhibit.pdf", fileBytes: 10 * 1024 * 1024 },
        ],
      },
    );

    expect(Object.fromEntries(under.selectionChecks!.map((check) => [check.checkId, check.status]))).toEqual({
      "envelope-size": "pass",
      "selection-filenames": "pass",
      "filename-collisions": "pass",
    });

    const over = preflight(
      {
        filename: "motion.pdf",
        fileBytes: 1,
        searchableText: true,
        pdfaCompliant: true,
        pages: [],
      },
      floridaPack,
      {
        files: [
          { filename: "motion.pdf", fileBytes: 20 * 1024 * 1024 },
          { filename: "motion.pdf", fileBytes: 10 * 1024 * 1024 },
          { filename: "bad.name.pdf", fileBytes: 1 },
        ],
      },
    );

    expect(Object.fromEntries(over.selectionChecks!.map((check) => [check.checkId, check.status]))).toEqual({
      "envelope-size": "warn",
      "selection-filenames": "warn",
      "filename-collisions": "warn",
    });
  });

  it("matches the committed pack manifest hash", () => {
    const manifest = manifestJson as PackManifest;

    expect(manifest.packs.florida?.sha256).toBe(packJsonSha256(floridaPack));
    expect(verifyBundledPackIntegrity(manifest, "florida", floridaPack)).toBeNull();
  });

  it("refuses bundled packs when the manifest hash does not match", () => {
    const issue = verifyBundledPackIntegrity(
      manifestJson as PackManifest,
      "florida",
      {
        ...floridaPack,
        guidanceNote: "tampered",
      },
    );

    expect(issue).toMatchObject({
      packId: "florida",
      reason: "Bundled pack hash does not match packs.manifest.json.",
    });
  });

  it("preflights unknown when pack integrity is unavailable", () => {
    const report = preflight(
      {
        fileBytes: 1,
        searchableText: true,
        pdfaCompliant: true,
        pages: [
          {
            pageIndex: 0,
            size: { w: 8.5, h: 11, in: true },
            orientation: "portrait",
          },
        ],
      },
      unknownPack,
    );

    expect(report.checks.every((check) => check.status === "unknown")).toBe(true);
  });

  it("requires a signature-equivalent manifest match or hash acknowledgment for app-data packs", () => {
    const rejected = verifyAppDataPackIntegrity("florida", floridaPack);
    const acknowledged = verifyAppDataPackIntegrity("florida", floridaPack, {
      acknowledgments: {
        hasAcknowledgment: (_packId, sha256) => sha256 === packJsonSha256(floridaPack),
      },
    });

    expect(rejected).toMatchObject({
      accepted: false,
      reason: "App-data pack hash has not been signed or explicitly acknowledged.",
    });
    expect(acknowledged).toEqual({
      accepted: true,
      sha256: packJsonSha256(floridaPack),
    });
  });
});
