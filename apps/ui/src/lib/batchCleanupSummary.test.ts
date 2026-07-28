import { describe, expect, it } from "vitest";
import { batchCleanupCompletionMessage } from "./batchCleanupSummary";

describe("batchCleanupCompletionMessage", () => {
  it("reports a clean run", () => {
    const message = batchCleanupCompletionMessage([{ status: "done" }, { status: "done" }]);

    expect(message).toBe("Batch cleanup finished for 2 file(s).");
  });

  it("does not read as success when every file failed", () => {
    // The regression this guards: the banner used to say "finished for 3 file(s)"
    // even when all three failed, because only invalidated signatures were counted.
    const message = batchCleanupCompletionMessage([
      { status: "failed" },
      { status: "failed" },
      { status: "failed" },
    ]);

    expect(message).toBe("Batch cleanup could not process any of the 3 file(s).");
    expect(message).not.toContain("finished for");
  });

  it("names the failed count on a partial run", () => {
    const message = batchCleanupCompletionMessage([
      { status: "done" },
      { status: "failed" },
      { status: "done" },
    ]);

    expect(message).toBe("Batch cleanup finished 2 of 3 file(s) — 1 could not be processed.");
  });

  it("still reports invalidated signatures alongside failures", () => {
    const message = batchCleanupCompletionMessage([
      { status: "done", signatureInvalidated: true },
      { status: "failed" },
    ]);

    expect(message).toContain("1 could not be processed.");
    expect(message).toContain("1 had digital signatures invalidated.");
  });

  it("reports invalidated signatures on an otherwise clean run", () => {
    const message = batchCleanupCompletionMessage([
      { status: "done", signatureInvalidated: true },
      { status: "done" },
    ]);

    expect(message).toBe(
      "Batch cleanup finished for 2 file(s). 1 had digital signatures invalidated.",
    );
  });

  it("does not claim a total failure for an empty run", () => {
    // 0 failed of 0 files must not trip the all-failed branch.
    expect(batchCleanupCompletionMessage([])).toBe("Batch cleanup finished for 0 file(s).");
  });

  it("treats skipped files as neither done nor failed", () => {
    const message = batchCleanupCompletionMessage([{ status: "skipped" }, { status: "done" }]);

    expect(message).toBe("Batch cleanup finished for 2 file(s).");
  });
});
