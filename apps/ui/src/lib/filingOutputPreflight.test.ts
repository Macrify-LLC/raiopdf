import { describe, expect, it } from "vitest";
import { getPack, preflight } from "@raiopdf/rules";
import type {
  DocumentFacts,
  JurisdictionPack,
  SelectionFacts,
} from "@raiopdf/rules";
import {
  aggregateOutputReports,
  runFilingOutputPreflights,
  type FilingOutputPreflightPart,
} from "./filingOutputPreflight";

const MiB = 1024 * 1024;

describe("filing output preflight", () => {
  it("checks split output parts as one filing selection for the envelope cap", async () => {
    const pack = getPack();
    const parts: FilingOutputPreflightPart[] = [
      { fileName: "motion - part 1 of 2.pdf", bytes: new Uint8Array(14 * MiB) },
      { fileName: "motion - part 2 of 2.pdf", bytes: new Uint8Array(14 * MiB) },
    ];
    const selections: Array<SelectionFacts | undefined> = [];

    const reports = await runFilingOutputPreflights(
      parts,
      pack,
      async (part) => ({
        filename: part.fileName,
        fileBytes: part.bytes.byteLength,
        searchableText: true,
        pdfaCompliant: true,
        pages: [],
      }),
      (facts: DocumentFacts, jurisdictionPack: JurisdictionPack, selection?: SelectionFacts) => {
        selections.push(selection);
        return preflight(facts, jurisdictionPack, selection);
      },
    );

    expect(selections).toEqual([
      {
        envelopeBytes: 28 * MiB,
        files: [
          { filename: "motion - part 1 of 2.pdf", fileBytes: 14 * MiB },
          { filename: "motion - part 2 of 2.pdf", fileBytes: 14 * MiB },
        ],
      },
      undefined,
    ]);

    const finalReport = aggregateOutputReports(reports);
    const envelopeCheck = finalReport.selectionChecks?.find((check) => check.checkId === "envelope-size");

    expect(envelopeCheck).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("exceeding"),
    });
  });
});
