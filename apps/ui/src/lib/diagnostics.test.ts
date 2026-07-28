import { beforeEach, describe, expect, it } from "vitest";
import {
  describeErrorChain,
  getDiagnosticById,
  getRecentDiagnostics,
  logWorkflowFailure,
  newDiagnosticId,
  recordDiagnosticEvent,
  resetDiagnosticsForTests,
} from "./diagnostics";

describe("describeErrorChain", () => {
  it("serializes a simple error", () => {
    expect(describeErrorChain(new Error("boom"))).toBe("Error: boom");
  });

  it("walks the full cause chain so hidden transport detail survives", () => {
    const inner = new TypeError("Failed to fetch");
    const outer = new Error("Local engine request failed.", { cause: inner });

    expect(describeErrorChain(outer)).toBe(
      "Error: Local engine request failed. <- TypeError: Failed to fetch",
    );
  });

  it("includes a string error code when present", () => {
    const error = Object.assign(new Error("qpdf refused"), { code: "INVALID_DOCUMENT" });

    expect(describeErrorChain(error)).toBe("Error[INVALID_DOCUMENT]: qpdf refused");
  });

  it("passes through a raw string cause", () => {
    const error = new Error("wrap", { cause: "read request body: (os error 10035)" });

    expect(describeErrorChain(error)).toBe(
      "Error: wrap <- read request body: (os error 10035)",
    );
  });

  it("does not loop on a cyclic cause chain", () => {
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;

    expect(describeErrorChain(a)).toBe("Error: a <- Error: b");
  });

  it("falls back for nullish input", () => {
    expect(describeErrorChain(null)).toBe("unknown error");
    expect(describeErrorChain(undefined)).toBe("unknown error");
  });
});

describe("newDiagnosticId", () => {
  it("mints a log-token-safe id", () => {
    // The shell's `log_token` keeps only [A-Za-z0-9_.-], so anything outside
    // that set would be silently mangled in app.log and stop matching.
    expect(newDiagnosticId()).toMatch(/^d-[0-9a-f]{8}$/);
  });

  it("does not repeat across a batch", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newDiagnosticId()));

    expect(ids.size).toBe(200);
  });
});

describe("correlation ids", () => {
  beforeEach(() => {
    resetDiagnosticsForTests();
  });

  it("returns the id synchronously so a catch block can store it with its message", () => {
    // Synchronous return is the whole point: a catch block sets the user-facing
    // message and the id in the same tick, which is what pairs them.
    const id = recordDiagnosticEvent("ocr.failed", "OCR could not finish");

    expect(id).toMatch(/^d-[0-9a-f]{8}$/);
    expect(getDiagnosticById(id)?.kind).toBe("ocr.failed");
  });

  it("resolves each failure by its own id rather than whichever was newest", () => {
    const first = logWorkflowFailure("merge.failed", new Error("merge blew up"));
    const second = logWorkflowFailure("split.failed", new Error("split blew up"));

    // The regression this guards: a surface displaying the merge failure used to
    // attach the split failure, because it asked for "the last diagnostic".
    expect(getDiagnosticById(first)?.message).toContain("merge blew up");
    expect(getDiagnosticById(second)?.message).toContain("split blew up");
  });

  it("records the raw error chain, not a user-facing message", () => {
    const id = logWorkflowFailure(
      "save.failed",
      new Error("Local engine request failed.", { cause: new TypeError("Failed to fetch") }),
    );

    expect(getDiagnosticById(id)?.message).toBe(
      "Error: Local engine request failed. <- TypeError: Failed to fetch",
    );
  });

  it("joins truthy details and drops the rest", () => {
    const id = recordDiagnosticEvent("save.failed", "nope", ["op=apply_edits", null, undefined, ""]);

    expect(getDiagnosticById(id)?.details).toBe("op=apply_edits");
  });

  it("reports null details when every detail was empty", () => {
    const id = recordDiagnosticEvent("save.failed", "nope", [null, undefined, ""]);

    expect(getDiagnosticById(id)?.details).toBeNull();
  });

  it("returns null for an id that has aged out of the ring buffer", () => {
    const oldest = recordDiagnosticEvent("first.failed", "oldest");
    for (let index = 0; index < 10; index += 1) {
      recordDiagnosticEvent("filler.failed", `filler ${index}`);
    }

    // Callers must tolerate this: the ring is bounded, and in a later process the
    // durable log is the only copy.
    expect(getDiagnosticById(oldest)).toBeNull();
    expect(getRecentDiagnostics()).toHaveLength(10);
  });
});
