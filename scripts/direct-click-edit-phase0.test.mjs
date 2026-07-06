import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DirectClickEditError,
  applyTargetedEdit,
  createTargetFromEngineRange,
  element,
  rect,
  resolveDomSelectionToEngineTarget,
  runPhase0Spike,
} from "./direct-click-edit-phase0.mjs";

describe("direct click-to-edit Phase 0 spike", () => {
  it("passes the complete local feasibility battery", () => {
    const result = runPhase0Spike();

    assert.equal(result.pass, true, JSON.stringify(result.cases, null, 2));
    assert.equal(result.cases.length, 7);
  });

  it("edits a selected duplicate occurrence without touching the earlier duplicate", () => {
    const elements = [
      element("John Smith", 72, 700, 80, 12),
      element(" v. ", 152, 700, 18, 12),
      element("John Smith", 170, 700, 80, 12),
    ];
    const target = resolveDomSelectionToEngineTarget({
      pageIndex: 0,
      elements,
      selectedText: "John Smith",
      selectionRects: [rect(170, 700, 80, 12)],
    });

    const result = applyTargetedEdit({ pageIndex: 0, elements, target, replacement: "Jane Doe" });

    assert.equal(result.text, "John Smith v. Jane Doe");
    assert.deepEqual(result.changedElementIndexes, [2]);
  });

  it("rejects a stale source fingerprint before mutating text", () => {
    const original = [element("John Smith", 72, 700, 80, 12)];
    const target = createTargetFromEngineRange({ pageIndex: 0, elements: original, start: 0, end: 10 });

    assert.throws(
      () =>
        applyTargetedEdit({
          pageIndex: 0,
          elements: [element("John Q. Smith", 72, 700, 92, 12)],
          target,
          replacement: "Jane Doe",
        }),
      (error) => error instanceof DirectClickEditError && error.code === "TARGET_STALE",
    );
  });

  it("rejects pdf.js inferred whitespace that is absent from the engine text model", () => {
    assert.throws(
      () =>
        resolveDomSelectionToEngineTarget({
          pageIndex: 0,
          elements: [
            element("John", 72, 700, 32, 12),
            element("Smith", 110, 700, 40, 12),
          ],
          selectedText: "John Smith",
          selectionRects: [rect(72, 700, 78, 12)],
        }),
      (error) => error instanceof DirectClickEditError && error.code === "TEXT_MODEL_MISMATCH",
    );
  });

  it("rejects duplicate candidates when geometry cannot distinguish them", () => {
    assert.throws(
      () =>
        resolveDomSelectionToEngineTarget({
          pageIndex: 0,
          elements: [
            element("John Smith", 72, 700, 80, 12),
            element("John Smith", 72, 700, 80, 12),
          ],
          selectedText: "John Smith",
          selectionRects: [rect(72, 700, 80, 12)],
        }),
      (error) => error instanceof DirectClickEditError && error.code === "TARGET_AMBIGUOUS",
    );
  });
});
