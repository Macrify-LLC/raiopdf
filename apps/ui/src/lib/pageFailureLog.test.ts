import { beforeEach, describe, expect, it } from "vitest";
import { getRecentDiagnostics, resetDiagnosticsForTests } from "./diagnostics";
import { recordFirstPageFailure } from "./pageFailureLog";

// The guard only uses the document as a WeakMap key, so any object stands in.
function fakeDocument(): object {
  return {};
}

describe("recordFirstPageFailure", () => {
  beforeEach(() => {
    resetDiagnosticsForTests();
  });

  it("records once per document and kind", () => {
    // Pages mount on scroll and re-render on every zoom step, so a broken
    // document would otherwise write one log line per page per pass — enough to
    // rotate the root cause out of app.log and evict the displayed failure from
    // the ring buffer.
    const document = fakeDocument();

    recordFirstPageFailure(document, "page.render-failed", new Error("boom"));
    recordFirstPageFailure(document, "page.render-failed", new Error("boom"));
    recordFirstPageFailure(document, "page.render-failed", new Error("boom"));

    expect(getRecentDiagnostics()).toHaveLength(1);
  });

  it("returns the FIRST id on every repeat, never null", () => {
    // The regression this guards: returning null for a suppressed repeat would
    // be forwarded into the document's failure state and clear the id already on
    // screen, so a second failing page removed the first one's report action
    // while its message stayed visible.
    const document = fakeDocument();

    const first = recordFirstPageFailure(document, "page.load-failed", new Error("boom"));
    const second = recordFirstPageFailure(document, "page.load-failed", new Error("boom"));

    expect(first).toMatch(/^d-[0-9a-f]{8}$/);
    expect(second).toBe(first);
  });

  it("separates the two failure kinds", () => {
    const document = fakeDocument();

    const load = recordFirstPageFailure(document, "page.load-failed", new Error("a"));
    const render = recordFirstPageFailure(document, "page.render-failed", new Error("b"));

    expect(render).not.toBe(load);
    expect(getRecentDiagnostics()).toHaveLength(2);
  });

  it("starts fresh for a different document", () => {
    // A newly opened document is a new fact, so its first failure records again.
    const first = recordFirstPageFailure(fakeDocument(), "page.render-failed", new Error("a"));
    const second = recordFirstPageFailure(fakeDocument(), "page.render-failed", new Error("b"));

    expect(second).not.toBe(first);
    expect(getRecentDiagnostics()).toHaveLength(2);
  });

  it("records the raw error chain but not a stack", () => {
    const document = fakeDocument();
    recordFirstPageFailure(document, "page.render-failed", new Error("outer", { cause: new TypeError("inner") }));

    const entry = getRecentDiagnostics().at(-1);
    expect(entry?.message).toBe("Error: outer <- TypeError: inner");
    // A pdf.js render stack is noise and this is the highest-frequency call site.
    expect(entry?.details).toBeNull();
  });
});
