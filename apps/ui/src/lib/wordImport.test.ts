import { describe, expect, it, vi } from "vitest";
import { runWordDocumentImport, type WordImportDeps, type WordImportOutput } from "./wordImport";
import type { PickedDocxForImport, FileGrant } from "./filePort";
import type { WordCapability } from "./wordCapability";

const output: WordImportOutput = {
  outputGrant: "converted-grant" as FileGrant,
  name: "Motion.pdf",
  sizeBytes: 4096,
};

const cleanDocx: PickedDocxForImport = {
  grant: "docx-grant" as FileGrant,
  name: "Motion.docx",
  sizeBytes: 2048,
  markupScan: "clean",
};

function deps(overrides: Partial<WordImportDeps> = {}): WordImportDeps {
  return {
    getCapability: vi.fn(async () => ({ state: "available", reason: null }) as WordCapability),
    pickDocx: vi.fn(async () => cleanDocx),
    chooseMarkup: vi.fn(async () => "final" as const),
    convert: vi.fn(async () => output),
    ...overrides,
  };
}

describe("runWordDocumentImport", () => {
  it("refuses when Word cannot run, without picking or converting", async () => {
    const testDeps = deps({
      getCapability: vi.fn(async () => ({ state: "notDetected", reason: null }) as WordCapability),
    });

    const result = await runWordDocumentImport({}, testDeps);

    expect(result.status).toBe("unavailable");
    expect(testDeps.pickDocx).not.toHaveBeenCalled();
    expect(testDeps.convert).not.toHaveBeenCalled();
  });

  it("returns cancelled when no file is picked", async () => {
    const testDeps = deps({ pickDocx: vi.fn(async () => null) });

    const result = await runWordDocumentImport({}, testDeps);

    expect(result.status).toBe("cancelled");
    expect(testDeps.convert).not.toHaveBeenCalled();
  });

  it("converts a clean docx to PDF with the chosen markup and returns the output to open", async () => {
    const testDeps = deps();

    const result = await runWordDocumentImport({}, testDeps);

    expect(result.status).toBe("converted");
    expect(result.status === "converted" ? result.output : null).toEqual(output);
    expect(testDeps.chooseMarkup).toHaveBeenCalledWith([cleanDocx]);
    expect(testDeps.convert).toHaveBeenCalledWith(cleanDocx.grant, "final");
  });

  it("passes the show-markup choice through to conversion for a tracked-changes docx", async () => {
    const markupDocx: PickedDocxForImport = { ...cleanDocx, markupScan: "hasMarkup" };
    const testDeps = deps({
      pickDocx: vi.fn(async () => markupDocx),
      chooseMarkup: vi.fn(async () => "showMarkup" as const),
    });

    const result = await runWordDocumentImport({}, testDeps);

    expect(result.status).toBe("converted");
    expect(testDeps.convert).toHaveBeenCalledWith(markupDocx.grant, "showMarkup");
  });

  it("returns a failure message when conversion throws", async () => {
    const testDeps = deps({
      convert: vi.fn(async () => {
        throw new Error("Word automation failed.");
      }),
    });

    const result = await runWordDocumentImport({}, testDeps);

    expect(result.status).toBe("failed");
  });
});
