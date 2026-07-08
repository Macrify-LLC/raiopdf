import type {
  PdfAFlavor,
  PdfDocumentHandle,
  PdfEngine,
  PdfSplitPart,
} from "@raiopdf/engine-api";
import type { JurisdictionPack } from "@raiopdf/rules";

type FilingPartEngine = Pick<PdfEngine, "pageCount" | "saveToBytes" | "splitByMaxBytes">;

export interface PreparedFilingOutputPart {
  bytes: Uint8Array;
  fileName: string;
  pageIndexes: readonly number[];
  oversized: boolean;
}

export interface PreparedFilingOutputParts {
  parts: readonly PreparedFilingOutputPart[];
  handlesToClose: readonly PdfDocumentHandle[];
}

export interface PdfAOutputConversion {
  flavor: PdfAFlavor;
  convert: (bytes: Uint8Array, flavor: PdfAFlavor) => Promise<Uint8Array>;
}

export async function prepareFilingOutputParts({
  engine,
  document,
  splitBySize,
  splitTargetBytes,
  baseName,
  pack,
  pdfAConversion,
  formatFileName,
}: {
  engine: FilingPartEngine;
  document: PdfDocumentHandle;
  splitBySize: boolean;
  splitTargetBytes: number;
  baseName: string;
  pack: JurisdictionPack;
  pdfAConversion?: PdfAOutputConversion;
  formatFileName: (
    baseName: string,
    pack: JurisdictionPack,
    partNumber: number,
    totalParts: number,
  ) => string;
}): Promise<PreparedFilingOutputParts> {
  const splitResult = splitBySize
    ? await engine.splitByMaxBytes(document, splitTargetBytes)
    : await singleFilingPart(engine, document);
  const handlesToClose = splitBySize
    ? splitResult.parts.map((part) => part.document)
    : [];

  const parts = await Promise.all(
    splitResult.parts.map(async (part, index) => {
      const splitBytes = await engine.saveToBytes(part.document);
      const bytes = pdfAConversion
        ? await pdfAConversion.convert(splitBytes, pdfAConversion.flavor)
        : splitBytes;

      return {
        bytes,
        fileName: formatFileName(baseName, pack, index + 1, splitResult.parts.length),
        pageIndexes: part.pageIndexes,
        oversized: part.oversized || (splitBySize && bytes.byteLength > splitTargetBytes),
      };
    }),
  );

  return {
    parts,
    handlesToClose,
  };
}

async function singleFilingPart(
  engine: Pick<PdfEngine, "pageCount" | "saveToBytes">,
  document: PdfDocumentHandle,
): Promise<{ parts: readonly PdfSplitPart[] }> {
  const bytes = await engine.saveToBytes(document);
  const pageCount = await engine.pageCount(document);

  return {
    parts: [
      {
        document,
        pageIndexes: Array.from({ length: pageCount }, (_value, index) => index),
        byteLength: bytes.byteLength,
        oversized: false,
      },
    ],
  };
}
