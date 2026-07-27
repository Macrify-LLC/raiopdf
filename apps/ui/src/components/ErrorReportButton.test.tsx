// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { recordDiagnosticEvent, resetDiagnosticsForTests } from "../lib/diagnostics";
import { ErrorReportButton } from "./ErrorReportButton";

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(node: React.ReactNode): void {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(node);
  });
}

beforeEach(() => {
  resetDiagnosticsForTests();
});

afterEach(() => {
  if (root) {
    act(() => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  resetDiagnosticsForTests();
});

function reportButton(): HTMLButtonElement | null {
  return container?.querySelector<HTMLButtonElement>(".error-report__button") ?? null;
}

describe("ErrorReportButton", () => {
  it("offers a report for the failure it was given", () => {
    const diagnosticId = recordDiagnosticEvent("ocr.failed", "OCR could not finish");

    render(<ErrorReportButton diagnosticId={diagnosticId} />);

    expect(reportButton()?.textContent).toContain("Email a report");
  });

  it("renders nothing for a message with no diagnostic", () => {
    // This is the capability-gap case: the OCR dialog reaches its error phase for
    // a missing toolchain while deliberately recording nothing. It used to offer a
    // report anyway, attaching whichever unrelated failure happened to be newest.
    recordDiagnosticEvent("merge.failed", "an earlier, unrelated failure");

    render(<ErrorReportButton diagnosticId={null} />);

    expect(reportButton()).toBeNull();
    expect(container?.textContent).toBe("");
  });

  it("renders nothing when no diagnosticId is passed at all", () => {
    recordDiagnosticEvent("merge.failed", "an earlier, unrelated failure");

    render(<ErrorReportButton />);

    expect(reportButton()).toBeNull();
  });

  it("renders nothing once the diagnostic has aged out of the ring buffer", () => {
    const diagnosticId = recordDiagnosticEvent("first.failed", "oldest");
    for (let index = 0; index < 10; index += 1) {
      recordDiagnosticEvent("filler.failed", `filler ${index}`);
    }

    render(<ErrorReportButton diagnosticId={diagnosticId} />);

    expect(reportButton()).toBeNull();
  });

  it("shows the hint by default and hides it on request", () => {
    const diagnosticId = recordDiagnosticEvent("save.failed", "nope");

    render(<ErrorReportButton diagnosticId={diagnosticId} />);
    expect(container?.querySelector(".error-report__hint")?.textContent).toContain(
      "nothing sends until you do",
    );

    act(() => {
      root!.render(<ErrorReportButton diagnosticId={diagnosticId} showHint={false} />);
    });
    expect(container?.querySelector(".error-report__hint")).toBeNull();
  });

  it("accepts a custom label and placement class", () => {
    const diagnosticId = recordDiagnosticEvent("filing.failed", "nope");

    render(
      <ErrorReportButton
        diagnosticId={diagnosticId}
        label="Email the maintainer"
        className="filing-progress__report"
      />,
    );

    expect(reportButton()?.textContent).toContain("Email the maintainer");
    expect(container?.querySelector(".filing-progress__report")).not.toBeNull();
  });
});
