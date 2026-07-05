// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isFilingStepEnabled,
  pathOpErrorMessage,
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
    toolchain: { qpdf: true, ghostscript: true, ocrmypdf: false },
    ops: [
      {
        name: "normalize_to_letter_portrait",
        available: true,
        missingTools: [],
        filingStep: "normalize-pages",
      },
      {
        name: "split_by_max_bytes",
        available: true,
        missingTools: [],
        filingStep: "split-by-size",
      },
      {
        name: "ocr",
        available: false,
        missingTools: ["ocrmypdf"],
        filingStep: "make-searchable",
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

  it("uses the caller's fallback for everything else", () => {
    expect(
      pathOpErrorMessage(new PathOpsError({ code: "OP_FAILED", message: "stderr soup" }), "fallback"),
    ).toBe("fallback");
    expect(pathOpErrorMessage(new Error("boom"), "fallback")).toBe("fallback");
  });

  it("keeps the desktop-only message for PathOpsUnavailableError", () => {
    expect(pathOpErrorMessage(new PathOpsUnavailableError(), "fallback")).toBe(
      "Path-based engine ops are only available in the desktop app.",
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
