import { describe, expect, it } from "vitest";
import {
  containsFilePath,
  formatBatchFailureReason,
  formatWorkflowError,
} from "./userMessages";

describe("userMessages", () => {
  it("does not surface unix paths from unknown workflow failures", () => {
    const message = formatWorkflowError(
      new Error("failed to read /home/jacob/cases/source.pdf"),
      "The workflow could not finish.",
    );

    expect(message).toBe("The workflow could not finish.");
    expect(message).not.toContain("/home/jacob");
  });

  it("does not surface windows paths from unknown workflow failures", () => {
    const message = formatWorkflowError(
      "failed to write C:\\Users\\Jacob\\Cases\\output.pdf",
      "The workflow could not finish.",
    );

    expect(message).toBe("The workflow could not finish.");
    expect(message).not.toContain("C:\\Users");
  });

  it("maps non-empty output folders to a lay instruction", () => {
    expect(formatWorkflowError("Output path already exists: /tmp/package", "Nope")).toBe(
      "Choose an empty new package folder. RaioPDF will not overwrite existing files.",
    );
  });

  it("maps missing local paths to the desktop-app requirement", () => {
    expect(formatWorkflowError(new Error("source needs absolute path"), "Nope")).toBe(
      "This workflow needs PDFs opened from the desktop app so RaioPDF can read their file paths.",
    );
  });

  it("maps permission failures without exposing backend terms", () => {
    expect(formatWorkflowError("EACCES: permission denied", "Nope")).toBe(
      "RaioPDF could not write there. Choose a folder you can edit and try again.",
    );
  });

  it("maps unreadable PDFs for per-file batch reasons", () => {
    expect(formatBatchFailureReason("invalid PDF object at /home/jacob/bad.pdf")).toBe(
      "One of the PDFs could not be read. It may be encrypted, corrupt, or unsupported.",
    );
  });

  it("maps a missing bundled tool to an install-integrity message, not reopen-the-PDF", () => {
    expect(formatWorkflowError("qpdf binary not found in payload", "Nope")).toBe(
      "RaioPDF's built-in tools could not be found. Your installation may be incomplete — reinstall RaioPDF and try again.",
    );
    expect(
      formatWorkflowError("bundled Node/MCP one-shot runtime not found", "Nope"),
    ).toBe(
      "RaioPDF's built-in tools could not be found. Your installation may be incomplete — reinstall RaioPDF and try again.",
    );
  });

  it("still maps a genuinely missing file (including a lost grant) to reopen-the-PDF", () => {
    expect(formatWorkflowError("File grant not found", "Nope")).toBe(
      "RaioPDF could not find one of the selected files. Reopen the PDF and try again.",
    );
    expect(formatWorkflowError("ENOENT: no such file or directory", "Nope")).toBe(
      "RaioPDF could not find one of the selected files. Reopen the PDF and try again.",
    );
  });

  it("falls back for unknown objects", () => {
    expect(formatWorkflowError({ message: "/tmp/raw" }, "The operation failed.")).toBe(
      "The operation failed.",
    );
  });

  it("preserves path-free workflow validation messages", () => {
    expect(formatWorkflowError(
      "Split size cap must be a positive number of MB.",
      "Batch cleanup could not be completed.",
    )).toBe("Split size cap must be a positive number of MB.");
  });

  it("preserves path-free skipped batch reasons", () => {
    expect(formatBatchFailureReason("No selected operation applies to this file.")).toBe(
      "No selected operation applies to this file.",
    );
  });

  it("detects common file path shapes", () => {
    expect(containsFilePath("/home/jacob/file.pdf")).toBe(true);
    expect(containsFilePath("C:\\Users\\Jacob\\file.pdf")).toBe(true);
    expect(containsFilePath("\\\\server\\share\\file.pdf")).toBe(true);
  });
});
