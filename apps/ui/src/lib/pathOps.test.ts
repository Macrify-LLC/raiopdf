// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isFilingStepEnabled,
  isPathOpCancelledError,
  pathOpErrorMessage,
  isPathOpAvailableForInput,
  pathOpApplyEdits,
  pathOpBuildBinder,
  pathOpCancel,
  pathOpOcr,
  pathOpRedactAreas,
  PathOpsError,
  PathOpsUnavailableError,
  type PathOpsFileGrant,
  type PathOpsStatus,
} from "./pathOps";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

function statusFixture(overrides?: Partial<PathOpsStatus>): PathOpsStatus {
  return {
    toolchain: { qpdf: true, ghostscript: true, ocrmypdf: false, node: true },
    ops: [
      {
        name: "normalize_to_letter_portrait",
        available: true,
        missingTools: [],
        filingStep: "normalize-pages",
        maxInputBytes: null,
      },
      {
        name: "split_by_max_bytes",
        available: true,
        missingTools: [],
        filingStep: "split-by-size",
        maxInputBytes: null,
      },
      {
        name: "ocr",
        available: false,
        missingTools: ["ocrmypdf"],
        filingStep: "make-searchable",
        maxInputBytes: null,
      },
      {
        name: "build_binder",
        available: true,
        missingTools: [],
        filingStep: null,
        maxInputBytes: 400,
      },
      {
        name: "apply_edits",
        available: true,
        missingTools: [],
        filingStep: null,
        maxInputBytes: 400,
      },
    ],
    filingSteps: {
      "remove-encryption": "decrypt",
      "normalize-pages": "normalize_to_letter_portrait",
      "sanitize-content": "sanitize",
      "scrub-metadata": "scrub_metadata",
      "make-searchable": "ocr",
      "flatten-forms": null,
      "convert-pdfa": null,
      "split-by-size": "split_by_max_bytes",
    },
    ...overrides,
  };
}

describe("isFilingStepEnabled (closed-form checklist rule)", () => {
  it("enables a step when a registered path op implements it and is available", () => {
    const status = statusFixture();
    expect(isFilingStepEnabled(status, "normalize-pages")).toBe(true);
    expect(isFilingStepEnabled(status, "split-by-size")).toBe(true);
  });

  it("disables steps with no registered path op", () => {
    const status = statusFixture();
    expect(isFilingStepEnabled(status, "flatten-forms")).toBe(false);
    expect(isFilingStepEnabled(status, "convert-pdfa")).toBe(false);
  });

  it("disables a registered step whose toolchain is missing", () => {
    const status = statusFixture();
    expect(isFilingStepEnabled(status, "make-searchable")).toBe(false);
  });

  it("disables a step whose mapped op is absent from the ops list", () => {
    // "remove-encryption" maps to "decrypt" but the fixture ops list does not
    // include it — the rule must fail closed, not assume availability.
    const status = statusFixture();
    expect(isFilingStepEnabled(status, "remove-encryption")).toBe(false);
  });
});

describe("isPathOpAvailableForInput", () => {
  it("requires the op to be present and available", () => {
    const status = statusFixture({
      ops: [
        {
          name: "build_binder",
          available: false,
          missingTools: ["node"],
          filingStep: null,
          maxInputBytes: 400,
        },
      ],
    });
    expect(isPathOpAvailableForInput(status, "build_binder", 100)).toBe(false);
    expect(isPathOpAvailableForInput(status, "missing_op", 100)).toBe(false);
  });

  it("honors per-op maxInputBytes when reported", () => {
    const status = statusFixture();
    expect(isPathOpAvailableForInput(status, "build_binder", 399)).toBe(true);
    expect(isPathOpAvailableForInput(status, "build_binder", 401)).toBe(false);
    expect(isPathOpAvailableForInput(status, "apply_edits", 399)).toBe(true);
    expect(isPathOpAvailableForInput(status, "apply_edits", 401)).toBe(false);
  });

  it("allows available ops without a ceiling", () => {
    const status = statusFixture();
    expect(isPathOpAvailableForInput(status, "split_by_max_bytes", 1_000_000)).toBe(true);
  });
});

describe("pathOpErrorMessage", () => {
  it("maps FILE_CHANGED onto the reopen message", () => {
    const message = pathOpErrorMessage(
      new PathOpsError({ code: "FILE_CHANGED", message: "raw drift detail" }),
      "fallback",
    );
    expect(message).toBe("This file changed on disk — reopen it.");
  });

  it("surfaces VERIFICATION_FAILED and TOOLCHAIN_MISSING verbatim", () => {
    expect(
      pathOpErrorMessage(
        new PathOpsError({ code: "VERIFICATION_FAILED", message: "text survived on page 3" }),
        "fallback",
      ),
    ).toBe("text survived on page 3");
    expect(
      pathOpErrorMessage(
        new PathOpsError({ code: "TOOLCHAIN_MISSING", message: "qpdf not found" }),
        "fallback",
      ),
    ).toBe("qpdf not found");
  });

  it("maps cancellation to a calm unchanged-document message", () => {
    const error = new PathOpsError({ code: "PATH_OP_CANCELLED", message: "Operation was cancelled." });

    expect(pathOpErrorMessage(error, "fallback")).toBe(
      "Operation cancelled. The document was left unchanged.",
    );
    expect(isPathOpCancelledError(error)).toBe(true);
    expect(isPathOpCancelledError(new Error("nope"))).toBe(false);
  });

  it("uses the caller's fallback for everything else", () => {
    expect(
      pathOpErrorMessage(new PathOpsError({ code: "OP_FAILED", message: "stderr soup" }), "fallback"),
    ).toBe("fallback");
    expect(pathOpErrorMessage(new Error("boom"), "fallback")).toBe("fallback");
  });

  it("keeps the desktop-only message for PathOpsUnavailableError", () => {
    expect(pathOpErrorMessage(new PathOpsUnavailableError(), "fallback")).toBe(
      "This tool only works in the installed RaioPDF app.",
    );
  });
});

describe("path op invoke plumbing", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
  });

  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  const grant = "grant-1" as PathOpsFileGrant;

  it("invokes the op command with the grant and returns the payload", async () => {
    const output = {
      outputGrant: "grant-out",
      name: "doc-ocr.pdf",
      sizeBytes: 10,
      pageCount: 2,
      opReport: { op: "ocr", tool: "ocrmypdf", durationMs: 1, inputSizeBytes: 9, outputSizeBytes: 10, notes: [] },
    };
    invokeMock.mockResolvedValueOnce(output);

    await expect(pathOpOcr(grant)).resolves.toEqual(output);
    expect(invokeMock).toHaveBeenCalledWith("path_op_ocr", { grant: "grant-1", mode: "skip-text" });
  });

  it("passes an OCR job token when progress is requested", async () => {
    const output = {
      outputGrant: "grant-out",
      name: "doc-ocr.pdf",
      sizeBytes: 10,
      pageCount: 2,
      opReport: { op: "ocr", tool: "ocrmypdf", durationMs: 1, inputSizeBytes: 9, outputSizeBytes: 10, notes: [] },
    };
    invokeMock.mockResolvedValueOnce(output);

    await expect(pathOpOcr(grant, "force-ocr", "job-1")).resolves.toEqual(output);
    expect(invokeMock).toHaveBeenCalledWith("path_op_ocr", {
      grant: "grant-1",
      mode: "force-ocr",
      jobToken: "job-1",
    });
  });

  it("passes selected OCR page indexes when provided", async () => {
    const output = {
      outputGrant: "grant-out",
      name: "doc-ocr.pdf",
      sizeBytes: 10,
      pageCount: 2,
      opReport: { op: "ocr", tool: "ocrmypdf", durationMs: 1, inputSizeBytes: 9, outputSizeBytes: 10, notes: [] },
    };
    invokeMock.mockResolvedValueOnce(output);

    await expect(pathOpOcr(grant, "force-ocr", "job-1", [0, 2])).resolves.toEqual(output);
    expect(invokeMock).toHaveBeenCalledWith("path_op_ocr", {
      grant: "grant-1",
      mode: "force-ocr",
      jobToken: "job-1",
      pageIndexes: [0, 2],
    });
  });

  it("invokes path_op_cancel with the running job token", async () => {
    invokeMock.mockResolvedValueOnce(true);

    await expect(pathOpCancel("job-1")).resolves.toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("path_op_cancel", { jobToken: "job-1" });
  });

  it("invokes build_binder with exhibit bytes and options", async () => {
    const output = {
      outputGrant: "grant-out",
      name: "binder.pdf",
      sizeBytes: 20,
      pageCount: 4,
      opReport: { op: "build_binder", tool: "node", durationMs: 1, inputSizeBytes: 12, outputSizeBytes: 20, notes: [] },
    };
    invokeMock.mockResolvedValueOnce(output);

    await expect(pathOpBuildBinder(
      grant,
      [{ bytes: new Uint8Array([1, 2, 3]), label: "Exhibit A", sourceFileName: "a.pdf" }],
      { slipSheets: false, coverStyle: "bordered" },
      "Main Binder.pdf",
    )).resolves.toEqual(output);
    expect(invokeMock).toHaveBeenCalledWith("path_op_build_binder", {
      grant: "grant-1",
      exhibits: [{ bytes: [1, 2, 3], label: "Exhibit A", sourceFileName: "a.pdf" }],
      options: { slipSheets: false, coverStyle: "bordered" },
      outputName: "Main Binder.pdf",
    });
  });

  it("invokes apply_edits with image bytes serialized for shell temp transport", async () => {
    const output = {
      outputGrant: "grant-out",
      name: "edited.pdf",
      sizeBytes: 20,
      pageCount: 1,
      opReport: { op: "apply_edits", tool: "node", durationMs: 1, inputSizeBytes: 12, outputSizeBytes: 20, notes: [] },
    };
    invokeMock.mockResolvedValueOnce(output);

    await expect(pathOpApplyEdits(
      grant,
      [
        {
          type: "image",
          pageIndex: 0,
          rect: { x: 1, y: 2, w: 3, h: 4 },
          bytes: new Uint8Array([9, 8, 7]),
          format: "png",
        },
      ],
      { markupMode: "annotation", printMarkupAnnotations: true },
      "edited.pdf",
    )).resolves.toEqual(output);
    expect(invokeMock).toHaveBeenCalledWith("path_op_apply_edits", {
      grant: "grant-1",
      payload: {
        edits: [{
          type: "image",
          pageIndex: 0,
          rect: { x: 1, y: 2, w: 3, h: 4 },
          bytes: [9, 8, 7],
          format: "png",
        }],
        applyOptions: { markupMode: "annotation", printMarkupAnnotations: true },
        outputName: "edited.pdf",
      },
    });
  });

  it("rethrows a serialized PathOpError payload as a typed PathOpsError", async () => {
    invokeMock.mockRejectedValueOnce({ code: "VERIFICATION_FAILED", message: "still readable" });

    const rejection = pathOpRedactAreas(grant, [{ pageIndex: 0, x: 1, y: 1, w: 2, h: 2 }]);
    await expect(rejection).rejects.toBeInstanceOf(PathOpsError);
    await rejection.catch((error: unknown) => {
      expect((error as PathOpsError).code).toBe("VERIFICATION_FAILED");
      expect((error as PathOpsError).message).toBe("still readable");
    });
  });

  it("throws PathOpsUnavailableError outside the Tauri runtime", async () => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    await expect(pathOpOcr(grant)).rejects.toBeInstanceOf(PathOpsUnavailableError);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
