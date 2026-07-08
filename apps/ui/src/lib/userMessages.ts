const UNIX_PATH_PATTERN = /(^|[\s("'`])\/(?:[^\s"'`<>]+\/?)+/u;
const WINDOWS_PATH_PATTERN = /[A-Za-z]:[\\/][^\s"'`<>]+/u;
const UNC_PATH_PATTERN = /\\\\[^\s"'`<>]+[\\/][^\s"'`<>]+/u;

export function formatWorkflowError(error: unknown, fallback: string): string {
  const raw = getErrorText(error);

  if (!raw) {
    return fallback;
  }

  const message = raw.toLowerCase();

  if (
    message.includes("local desktop path") ||
    message.includes("absolute path") ||
    message.includes("path unavailable")
  ) {
    return "This workflow needs PDFs opened from the desktop app so RaioPDF can read their file paths.";
  }

  if (
    message.includes("already exists") ||
    message.includes("not empty") ||
    message.includes("non-empty") ||
    message.includes("output path exists")
  ) {
    return "Choose an empty new package folder. RaioPDF will not overwrite existing files.";
  }

  if (
    message.includes("permission denied") ||
    message.includes("access denied") ||
    message.includes("eacces") ||
    message.includes("eperm")
  ) {
    return "RaioPDF could not write there. Choose a folder you can edit and try again.";
  }

  // Incomplete-install failures also contain "not found" ("qpdf binary not found
  // in payload", "bundled Node/MCP one-shot runtime not found"). Those are an
  // install-integrity problem, not a missing user file — routing them to the
  // "reopen the PDF" message below would send the user on a wild goose chase.
  // Catch them first with honest, actionable guidance. Key ONLY on missing-tool
  // phrasing here — a bare tool name is not enough. The same names appear in
  // ordinary operation failures ("qpdf --decrypt failed" on a wrong password,
  // "ghostscript PDF/A conversion failed"), which are document problems, not a
  // broken install; those fall through to the document/generic buckets below.
  if (
    message.includes("not found in payload") ||
    message.includes("runtime not found") ||
    message.includes("binary not found") ||
    message.includes("node lane") ||
    message.includes("is not configured")
  ) {
    return "RaioPDF's built-in tools could not be found. Your installation may be incomplete — reinstall RaioPDF and try again.";
  }

  if (
    message.includes("no such file") ||
    message.includes("not found") ||
    message.includes("enoent")
  ) {
    return "RaioPDF could not find one of the selected files. Reopen the PDF and try again.";
  }

  if (
    message.includes("encrypted") ||
    message.includes("password") ||
    message.includes("invalid pdf") ||
    message.includes("corrupt") ||
    message.includes("malformed")
  ) {
    return "One of the PDFs could not be read. It may be encrypted, corrupt, or unsupported.";
  }

  if (
    message.includes("spawn") ||
    message.includes("sidecar") ||
    message.includes("desktop engine") ||
    message.includes("local engine") ||
    message.includes("stirling") ||
    message.includes("tauri") ||
    message.includes("ipc") ||
    message.includes("invoke") ||
    // A built-in tool ran but the operation itself failed (e.g. "qpdf produced an
    // empty compressed PDF", "ghostscript PDF/A conversion failed", "OCRmyPDF
    // exited with status 1"). Not a broken install and not a document we can name
    // a cause for — give the neutral retry message, and keep the raw dependency
    // name out of the user's face. (Wrong-password / corrupt-PDF failures that
    // also mention these tools are caught by the document bucket above.)
    message.includes("qpdf") ||
    message.includes("ghostscript") ||
    message.includes("ocrmypdf")
  ) {
    return "Something went wrong running this. Close and reopen RaioPDF, then try again.";
  }

  if (containsFilePath(raw)) {
    return fallback;
  }

  return raw;
}

export function formatBatchFailureReason(reason: string | null): string | null {
  if (!reason) {
    return null;
  }

  return formatWorkflowError(
    reason,
    "That file could not be cleaned up. Check the source PDF and try again.",
  );
}

export function containsFilePath(value: string): boolean {
  return UNIX_PATH_PATTERN.test(value) ||
    WINDOWS_PATH_PATTERN.test(value) ||
    UNC_PATH_PATTERN.test(value);
}

function getErrorText(error: unknown): string | null {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return null;
}
