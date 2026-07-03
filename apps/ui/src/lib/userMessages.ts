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
    message.includes("tauri") ||
    message.includes("ipc") ||
    message.includes("invoke")
  ) {
    return "This operation needs the desktop engine. Open RaioPDF as the desktop app and try again.";
  }

  if (containsFilePath(raw)) {
    return fallback;
  }

  return fallback;
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
