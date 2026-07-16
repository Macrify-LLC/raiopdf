import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PathOpsFileGrant } from "./pathOps";
import { pathOpApplyEdits, pathOpDecrypt, pathOpReleaseOutput } from "./pathOps";
import { stageStreamedProtectedCopyEdits } from "./protectedCopyStaging";

vi.mock("./pathOps", () => ({
  pathOpApplyEdits: vi.fn(),
  pathOpDecrypt: vi.fn(),
  pathOpReleaseOutput: vi.fn(),
}));

const sourceGrant = "source-grant" as PathOpsFileGrant;
const decryptedGrant = "decrypted-grant" as PathOpsFileGrant;
const editedGrant = "edited-grant" as PathOpsFileGrant;

function output(outputGrant: PathOpsFileGrant) {
  return {
    outputGrant,
    name: "output.pdf",
    sizeBytes: 10,
    pageCount: 1,
    opReport: {
      op: "test",
      tool: "test",
      durationMs: 1,
      inputSizeBytes: 9,
      outputSizeBytes: 10,
      notes: [],
    },
  };
}

describe("stageStreamedProtectedCopyEdits", () => {
  beforeEach(() => {
    vi.mocked(pathOpDecrypt).mockReset();
    vi.mocked(pathOpApplyEdits).mockReset();
    vi.mocked(pathOpReleaseOutput).mockReset();
  });

  it("decrypts an owner-restricted source before applying pending edits", async () => {
    vi.mocked(pathOpDecrypt).mockResolvedValue(output(decryptedGrant));
    vi.mocked(pathOpApplyEdits).mockResolvedValue(output(editedGrant));

    const result = await stageStreamedProtectedCopyEdits({
      sourceGrant,
      ownerRestricted: true,
      edits: [{ type: "formValues", values: { approved: true } }],
      applyOptions: { markupMode: "annotation", printMarkupAnnotations: true },
      outputName: "case-protected.pdf",
      flatten: false,
    });

    expect(pathOpDecrypt).toHaveBeenCalledWith(sourceGrant, "");
    expect(pathOpApplyEdits).toHaveBeenCalledWith(
      decryptedGrant,
      [{ type: "formValues", values: { approved: true } }],
      { markupMode: "annotation", printMarkupAnnotations: true },
      "case-protected.pdf",
      false,
    );
    expect(result).toEqual({
      inputGrant: editedGrant,
      temporaryGrants: [decryptedGrant, editedGrant],
    });
  });

  it("applies edits directly when the streamed source is not encrypted", async () => {
    vi.mocked(pathOpApplyEdits).mockResolvedValue(output(editedGrant));

    const result = await stageStreamedProtectedCopyEdits({
      sourceGrant,
      ownerRestricted: false,
      edits: [],
      applyOptions: { markupMode: "annotation", printMarkupAnnotations: false },
      outputName: "case-protected.pdf",
      flatten: true,
    });

    expect(pathOpDecrypt).not.toHaveBeenCalled();
    expect(pathOpApplyEdits).toHaveBeenCalledWith(
      sourceGrant,
      [],
      { markupMode: "annotation", printMarkupAnnotations: false },
      "case-protected.pdf",
      true,
    );
    expect(result).toEqual({
      inputGrant: editedGrant,
      temporaryGrants: [editedGrant],
    });
  });

  it("releases a decrypted intermediate when applying edits fails", async () => {
    vi.mocked(pathOpDecrypt).mockResolvedValue(output(decryptedGrant));
    vi.mocked(pathOpApplyEdits).mockRejectedValue(new Error("apply failed"));
    vi.mocked(pathOpReleaseOutput).mockResolvedValue();

    await expect(stageStreamedProtectedCopyEdits({
      sourceGrant,
      ownerRestricted: true,
      edits: [],
      applyOptions: { markupMode: "annotation", printMarkupAnnotations: true },
      outputName: "case-protected.pdf",
      flatten: false,
    })).rejects.toThrow("apply failed");

    expect(pathOpReleaseOutput).toHaveBeenCalledWith(decryptedGrant);
  });
});
