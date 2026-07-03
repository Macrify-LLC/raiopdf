import { describe, expect, it } from "vitest";
import manifestJson from "../data/packs.manifest.json";
import {
  getPack,
  listPacks,
  packJsonSha256,
  preflight,
  shouldConvertToPdfA,
  verifyBundledPackIntegrity,
  type JurisdictionPack,
  type PackManifest,
} from "../src/index";
import { loadJurisdictionPackFromJson } from "../src/packLoader";

const PACK_IDS = [
  "florida",
  "federal-cmecf",
  "georgia-efilega",
  "georgia-peachcourt",
  "indiana-iefs",
] as const;

const MiB = 1024 * 1024;

describe("bundled jurisdiction packs", () => {
  it("registers the picker-facing pack list in deterministic order", () => {
    expect(listPacks().map((pack) => pack.id)).toEqual(PACK_IDS);
  });

  it("round-trips every pack through the schema v2 loader", () => {
    for (const packId of PACK_IDS) {
      const pack = getPack(packId);
      const roundTripped = loadJurisdictionPackFromJson(
        JSON.stringify(pack),
        `${packId} round-trip`,
      );

      expect(roundTripped).toEqual(pack);
    }
  });

  it("matches the committed integrity manifest for every pack", () => {
    const manifest = manifestJson as PackManifest;

    for (const packId of PACK_IDS) {
      const pack = getPack(packId);

      expect(manifest.packs[packId]?.sha256).toBe(packJsonSha256(pack));
      expect(verifyBundledPackIntegrity(manifest, packId, pack)).toBeNull();
    }
  });

  it("keeps every researched constraint and policy tied to the research date", () => {
    for (const packId of PACK_IDS) {
      const pack = getPack(packId);

      for (const constraint of pack.constraints) {
        expect(constraint.authority, `${packId}.${constraint.id}`).not.toBe("");
        expect(constraint.lastVerified, `${packId}.${constraint.id}`).toBe(
          packId === "florida" && constraint.id === "conferral-certificate"
            ? "2026-07-03"
            : "2026-07-02",
        );
      }

      for (const [key, policy] of Object.entries(policyConstraints(pack))) {
        expect(policy.authority, `${packId}.${key}`).not.toBe("");
        expect(policy.lastVerified, `${packId}.${key}`).toBe("2026-07-02");
      }
    }
  });

  it("preserves the Federal CM/ECF national baseline choices", () => {
    const pack = getPack("federal-cmecf");

    expect(pack).toMatchObject({
      portal: "CM/ECF",
      userConfigurable: { maxFileBytes: true },
      pdfa: { stance: "accepted", prepDefault: "off" },
      activeContent: { stance: "prohibited", prepDefault: "on" },
      encryption: { stance: "prohibited", prepDefault: "on" },
      embeddedFiles: { stance: "prohibited", prepDefault: "on" },
      flattenForms: { stance: "preferred", prepDefault: "on" },
      ocr: { stance: "accepted", prepDefault: "off" },
    });
    expect(pack.maxFileBytes).toBeUndefined();
    expect(pack.recommendedMaxFileBytes).toBeUndefined();
    expect(pack.scopeNote).toContain("Each district/bankruptcy/appellate court configures its own file-size cap");
    expect(shouldConvertToPdfA(pack)).toBe(false);

    const report = preflight(
      {
        filename: "motion.pdf",
        fileBytes: 500 * MiB,
        searchableText: false,
        pdfaCompliant: false,
        pages: [],
      },
      pack,
    );

    expect(Object.fromEntries(report.checks.map((check) => [check.checkId, check.status]))).toEqual({
      "searchable-text": "pass",
      "file-size": "unknown",
      "active-content": "unknown",
      encryption: "unknown",
      "embedded-files": "unknown",
      "flatten-forms": "unknown",
      pdfa: "pass",
    });
    expect(report.checks.find((check) => check.checkId === "file-size")?.detail).toContain(
      "Set this court's file-size cap",
    );
  });

  it("models Georgia eFileGA recommendations and skips risky PDF/A/OCR automation", () => {
    const pack = getPack("georgia-efilega");

    expect(pack).toMatchObject({
      recommendedMaxFileBytes: 5 * MiB,
      maxEnvelopeBytes: 25 * MiB,
      pdfa: { stance: "accepted", prepDefault: "off" },
      ocr: { prepDefault: "off" },
      encryption: { stance: "prohibited" },
    });
    expect(pack.maxFileBytes).toBeUndefined();
    expect(pack.pdfa.note).toMatch(/JBIG|JBig/);
    expect(pack.ocr.note).toMatch(/Format Error/);
    expect(shouldConvertToPdfA(pack)).toBe(false);

    const report = preflight(
      {
        filename: "brief.pdf",
        fileBytes: 8 * MiB,
        searchableText: false,
        pdfaCompliant: false,
        pages: [],
      },
      pack,
      {
        files: [
          { filename: "brief.pdf", fileBytes: 20 * MiB },
          { filename: "exhibits.pdf", fileBytes: 6 * MiB },
        ],
      },
    );

    expect(Object.fromEntries(report.checks.map((check) => [check.checkId, check.status]))).toMatchObject({
      "file-size": "warn",
      "searchable-text": "pass",
      pdfa: "pass",
    });
    const fileSizeCheck = report.checks.find((check) => check.checkId === "file-size");
    expect(fileSizeCheck?.detail).toContain("Tyler Odyssey File & Serve eFileGA FAQ recommended limit");
    expect(fileSizeCheck?.detail).not.toContain("portal cap");
    expect(report.selectionChecks?.find((check) => check.checkId === "envelope-size")).toMatchObject({
      status: "warn",
    });
  });

  it("keeps Georgia PeachCourt thin where the source is thin", () => {
    const pack = getPack("georgia-peachcourt");

    expect(pack.scopeNote).toContain("published PeachCourt-facing spec found in this pass is thin");
    expect(pack).toMatchObject({
      maxFileBytes: 25 * MiB,
      maxEnvelopeBytes: 25 * MiB,
      pdfa: { stance: "unknown", prepDefault: "off" },
      metadataScrub: { stance: "unknown" },
      ocr: { stance: "unknown", prepDefault: "off" },
    });

    const report = preflight(
      {
        filename: "motion.pdf",
        fileBytes: 26 * MiB,
        pages: [],
      },
      pack,
      {
        files: [{ filename: "motion.pdf", fileBytes: 26 * MiB }],
      },
    );

    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({ checkId: "file-size", status: "warn" });
    expect(report.selectionChecks?.find((check) => check.checkId === "envelope-size")).toMatchObject({
      status: "warn",
    });
  });

  it("models Indiana IEFS hard limits and conditional prep defaults", () => {
    const pack = getPack("indiana-iefs");
    const tooLongFilename = `${"a".repeat(97)}.pdf`;

    expect(pack).toMatchObject({
      maxFileBytes: 50 * MiB,
      maxEnvelopeBytes: 75 * MiB,
      filenameMaxChars: 100,
      pdfa: { stance: "unknown", prepDefault: "off" },
      encryption: { stance: "prohibited" },
      embeddedFiles: { stance: "prohibited" },
      ocr: { stance: "required", condition: "for scanned documents" },
      metadataScrub: {
        stance: "required",
        condition: "when the filing contains confidential/redacted information",
        prepDefault: "on",
      },
    });

    const report = preflight(
      {
        filename: tooLongFilename,
        fileBytes: 51 * MiB,
        searchableText: false,
        pdfaCompliant: false,
        pages: [],
      },
      pack,
      {
        files: [
          { filename: "volume 1.pdf", fileBytes: 50 * MiB },
          { filename: "volume 2.pdf", fileBytes: 26 * MiB },
        ],
      },
    );

    expect(Object.fromEntries(report.checks.map((check) => [check.checkId, check.status]))).toMatchObject({
      "file-size": "warn",
      filename: "warn",
      "searchable-text": "warn",
      pdfa: "unknown",
    });
    expect(report.checks.find((check) => check.checkId === "filename")?.detail).toContain("101 characters");
    expect(report.selectionChecks?.find((check) => check.checkId === "envelope-size")).toMatchObject({
      status: "warn",
    });
  });
});

function policyConstraints(pack: JurisdictionPack) {
  return {
    pdfa: pack.pdfa,
    activeContent: pack.activeContent,
    encryption: pack.encryption,
    embeddedFiles: pack.embeddedFiles,
    metadataScrub: pack.metadataScrub,
    ocr: pack.ocr,
    flattenForms: pack.flattenForms,
  };
}
