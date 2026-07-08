import { describe, expect, it, vi } from "vitest";
import type {
  DocumentFacts,
  JurisdictionPack,
  PreflightReport,
  SelectionFacts,
} from "@raiopdf/rules";
import { getPack, preflight } from "@raiopdf/rules";
import type { PdfAFlavor, PdfDocumentHandle, PdfEngine } from "@raiopdf/engine-api";
import {
  aggregateOutputReports,
  runFilingOutputPreflights,
} from "./filingOutputPreflight";
import { prepareFilingOutputParts } from "./filingOutputParts";

describe("prepareFilingOutputParts", () => {
  it("splits before PDF/A conversion and preflights the converted output bytes honestly", async () => {
    const splitTargetBytes = 10;
    const source = handle("source");
    const partOne = handle("part-one");
    const partTwo = handle("part-two");
    const sourceBytes = new Uint8Array(21);
    const splitPartOneBytes = new Uint8Array(9);
    const splitPartTwoBytes = new Uint8Array(8);
    const convertedPartOneBytes = new Uint8Array(13);
    const convertedPartTwoBytes = new Uint8Array(7);
    const bytesByHandle = new Map<PdfDocumentHandle, Uint8Array>([
      [source, sourceBytes],
      [partOne, splitPartOneBytes],
      [partTwo, splitPartTwoBytes],
    ]);
    const engine = {
      close: vi.fn(async () => undefined),
      pageCount: vi.fn(async () => 4),
      saveToBytes: vi.fn(async (document: PdfDocumentHandle) => bytesByHandle.get(document) ?? new Uint8Array()),
      splitByMaxBytes: vi.fn(async (document: PdfDocumentHandle, maxBytes: number) => {
        expect(document).toBe(source);
        expect(maxBytes).toBe(splitTargetBytes);

        return {
          parts: [
            {
              document: partOne,
              pageIndexes: [0, 1],
              byteLength: splitPartOneBytes.byteLength,
              oversized: false,
            },
            {
              document: partTwo,
              pageIndexes: [2, 3],
              byteLength: splitPartTwoBytes.byteLength,
              oversized: false,
            },
          ],
        };
      }),
    } satisfies Pick<PdfEngine, "close" | "pageCount" | "saveToBytes" | "splitByMaxBytes">;
    const convert = vi.fn(async (bytes: Uint8Array, flavor: PdfAFlavor) => {
      expect(flavor).toBe("pdfa-2b");

      if (bytes === splitPartOneBytes) {
        return convertedPartOneBytes;
      }

      if (bytes === splitPartTwoBytes) {
        return convertedPartTwoBytes;
      }

      throw new Error("unexpected conversion input");
    });
    const pack = {
      ...getPack(),
      maxFileBytes: 20,
      recommendedMaxFileBytes: splitTargetBytes,
    } satisfies JurisdictionPack;

    const prepared = await prepareFilingOutputParts({
      engine,
      document: source,
      splitBySize: true,
      splitTargetBytes,
      baseName: "motion",
      pack,
      pdfAConversion: {
        flavor: "pdfa-2b",
        convert,
      },
      formatFileName: (baseName, _pack, partNumber, totalParts) => (
        `${baseName} - part ${partNumber} of ${totalParts}.pdf`
      ),
    });

    expect(prepared.handlesToClose).toEqual([partOne, partTwo]);
    expect(engine.close).not.toHaveBeenCalled();
    expect(convert).toHaveBeenCalledTimes(2);
    expect(convert.mock.calls.map(([bytes]) => bytes)).toEqual([
      splitPartOneBytes,
      splitPartTwoBytes,
    ]);
    expect(prepared.parts).toMatchObject([
      {
        bytes: convertedPartOneBytes,
        fileName: "motion - part 1 of 2.pdf",
        pageIndexes: [0, 1],
        oversized: true,
      },
      {
        bytes: convertedPartTwoBytes,
        fileName: "motion - part 2 of 2.pdf",
        pageIndexes: [2, 3],
        oversized: false,
      },
    ]);

    const reports = await runFilingOutputPreflights(
      prepared.parts,
      pack,
      async (part) => {
        const facts = {
          filename: part.fileName,
          fileBytes: part.bytes.byteLength,
          searchableText: true,
          pages: [],
        } satisfies DocumentFacts;

        expect(Object.hasOwn(facts, "pdfaCompliant")).toBe(false);
        return facts;
      },
      (facts: DocumentFacts, jurisdictionPack: JurisdictionPack, selection?: SelectionFacts): PreflightReport => (
        preflight(facts, jurisdictionPack, selection)
      ),
    );
    const finalReport = aggregateOutputReports(reports);

    expect(finalReport.checks.find((check) => check.checkId === "file-size")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("recommended"),
    });
    expect(finalReport.checks.find((check) => check.checkId === "pdfa")).toMatchObject({
      status: "unknown",
      detail: expect.stringContaining("compliance facts were not provided"),
    });
  });

  it("rejects output parts over a hard portal cap before they can be saved", async () => {
    const source = handle("source");
    const part = handle("part");
    const convertedBytes = new Uint8Array(11);
    const engine = {
      close: vi.fn(async () => undefined),
      pageCount: vi.fn(async () => 1),
      saveToBytes: vi.fn(async () => new Uint8Array(9)),
      splitByMaxBytes: vi.fn(async () => ({
        parts: [{
          document: part,
          pageIndexes: [0],
          byteLength: 9,
          oversized: false,
        }],
      })),
    } satisfies Pick<PdfEngine, "close" | "pageCount" | "saveToBytes" | "splitByMaxBytes">;
    const pack = {
      ...getPack(),
      maxFileBytes: 10,
      recommendedMaxFileBytes: 10,
    } satisfies JurisdictionPack;

    await expect(prepareFilingOutputParts({
      engine,
      document: source,
      splitBySize: true,
      splitTargetBytes: 10,
      baseName: "motion",
      pack,
      pdfAConversion: {
        flavor: "pdfa-2b",
        convert: vi.fn(async () => convertedBytes),
      },
      formatFileName: (baseName) => `${baseName}.pdf`,
    })).rejects.toThrow(/exceeded the 0\.00 MB portal cap/);
    expect(engine.close).toHaveBeenCalledWith(part);
  });
});

function handle(value: string): PdfDocumentHandle {
  return value as PdfDocumentHandle;
}
