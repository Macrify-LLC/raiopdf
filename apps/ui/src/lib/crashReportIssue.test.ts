import { describe, expect, it } from "vitest";
import { formatCrashReportPreview, type CrashReportPayload } from "../components/CrashReportDialog";
import {
  buildCrashReportIssueUrl,
  CRASH_REPORT_ISSUE_TRUNCATION_NOTE,
  CRASH_REPORT_ISSUE_URL_MAX_LENGTH,
  fitCrashReportPayloadToIssueUrl,
} from "./crashReportIssue";

describe("crash report GitHub issue URL", () => {
  it("fits encoding-heavy bodies under the URL budget and keeps preview identical to the sent body", () => {
    const payload: CrashReportPayload = {
      title: "Crash report: encoding-heavy panic",
      body: Array.from(
        { length: 420 },
        (_, index) =>
          `frame ${index}: C:\\Users\\[user]\\cases\\Motion: ${"details: ".repeat(4)}`,
      ).join("\n"),
      signature: "encoding-heavy panic",
      panicLocation: "src/main.rs:42",
      backtrace: "full backtrace",
      logTail: "recent activity",
    };

    const fitted = fitCrashReportPayloadToIssueUrl(payload);
    const url = buildCrashReportIssueUrl(fitted);
    const sentBody = new URL(url).searchParams.get("body");

    expect(url.length).toBeLessThanOrEqual(CRASH_REPORT_ISSUE_URL_MAX_LENGTH);
    expect(fitted.body).toContain(CRASH_REPORT_ISSUE_TRUNCATION_NOTE.trim());
    expect(sentBody).toBe(fitted.body);
    expect(formatCrashReportPreview(fitted).split("GitHub issue body\n").at(1)).toBe(sentBody);
    expect(fitted.backtrace).toBe("full backtrace");
    expect(fitted.logTail).toBe("recent activity");
  });
});
