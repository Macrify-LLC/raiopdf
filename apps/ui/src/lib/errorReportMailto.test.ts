import { describe, expect, it } from "vitest";
import type { DiagnosticEntry } from "./diagnostics";
import {
  buildErrorReportMailto,
  ERROR_REPORT_EMAIL,
  ERROR_REPORT_MAILTO_MAX_LENGTH,
  scrubFilePaths,
} from "./errorReportMailto";

function decodeBody(mailto: string): string {
  const body = new URL(mailto).searchParams.get("body");
  return body ?? "";
}

const diagnostic: DiagnosticEntry = {
  kind: "redaction.failed",
  message: "Error: Redaction could not finish. <- TypeError: Failed to fetch",
  details: null,
  at: Date.UTC(2026, 6, 9, 15, 30, 0),
};

describe("buildErrorReportMailto", () => {
  it("drafts to the crash-reports alias with a subject and body", () => {
    const mailto = buildErrorReportMailto({
      diagnostic,
      appVersion: "0.1.2",
      userAgent: "Mozilla/5.0 (Windows NT 10.0)",
    });

    expect(mailto.startsWith(`mailto:${ERROR_REPORT_EMAIL}?`)).toBe(true);
    const url = new URL(mailto);
    expect(url.searchParams.get("subject")).toBe("RaioPDF error report");
    const body = decodeBody(mailto);
    expect(body).toContain("App version: 0.1.2");
    expect(body).toContain("Windows NT 10.0");
    expect(body).toContain("redaction.failed");
    expect(body).toContain("Failed to fetch");
  });

  it("includes a fill-in prompt for the user", () => {
    const mailto = buildErrorReportMailto({
      diagnostic,
      appVersion: "0.1.2",
      userAgent: "ua",
    });
    expect(decodeBody(mailto)).toContain("What were you doing when this happened?");
  });

  it("drafts a blank report when no diagnostic was captured", () => {
    const mailto = buildErrorReportMailto({
      diagnostic: null,
      appVersion: null,
      userAgent: "ua",
    });
    const body = decodeBody(mailto);
    expect(body).toContain("App version: unknown");
    expect(body).toContain("No recent error was captured");
  });

  it("strips absolute file paths so a local path never leaves the machine", () => {
    const mailto = buildErrorReportMailto({
      diagnostic: {
        ...diagnostic,
        message: "ENOENT: no such file C:\\Users\\Jane\\Matters\\Smith\\complaint.pdf",
        details: "opened from /home/jane/cases/acme/exhibit-a.pdf",
      },
      appVersion: "0.1.2",
      userAgent: "ua",
    });
    const body = decodeBody(mailto);
    expect(body).not.toContain("complaint.pdf");
    expect(body).not.toContain("exhibit-a.pdf");
    expect(body).not.toContain("Smith");
    expect(body).toContain("[path removed]");
  });

  it("trims an oversized technical detail to keep the mailto under the length cap", () => {
    const mailto = buildErrorReportMailto({
      diagnostic: { ...diagnostic, message: "boom ".repeat(2000) },
      appVersion: "0.1.2",
      userAgent: "ua",
    });
    expect(mailto.length).toBeLessThanOrEqual(ERROR_REPORT_MAILTO_MAX_LENGTH);
    expect(decodeBody(mailto)).toContain("trimmed");
  });
});

describe("scrubFilePaths", () => {
  it("replaces unix, windows, and UNC paths", () => {
    expect(scrubFilePaths("read /home/jane/a.pdf")).toBe("read [path removed]");
    expect(scrubFilePaths("open C:\\Users\\Jane\\a.pdf")).toBe("open [path removed]");
    expect(scrubFilePaths("share \\\\server\\vol\\a.pdf")).toBe("share [path removed]");
  });

  it("removes a whole path that contains spaces (the Windows common case)", () => {
    const scrubbed = scrubFilePaths("open C:\\Users\\Jane Doe\\Matter\\complaint.pdf");
    expect(scrubbed).toBe("open [path removed]");
    expect(scrubbed).not.toContain("Jane Doe");
    expect(scrubbed).not.toContain("complaint");
  });

  it("stops at the error-chain separator so later clauses survive", () => {
    const scrubbed = scrubFilePaths("open C:\\a b\\c.pdf failed <- TypeError: boom");
    expect(scrubbed).toContain("TypeError: boom");
    expect(scrubbed).not.toContain("c.pdf");
  });

  it("does not match slashes inside ordinary prose", () => {
    expect(scrubFilePaths("read/write access on 6/9 failed")).toBe("read/write access on 6/9 failed");
  });

  it("leaves ordinary text untouched", () => {
    expect(scrubFilePaths("qpdf exited with status 2")).toBe("qpdf exited with status 2");
  });
});
