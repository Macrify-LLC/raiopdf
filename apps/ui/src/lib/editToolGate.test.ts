import { describe, expect, it } from "vitest";
import {
  editToolStreamedGateMessage,
  streamedAnnotationPlanGateMessage,
  STREAMED_ANNOTATION_UPDATE_GATE_MESSAGE,
  STREAMED_FORM_AUTHORING_GATE_MESSAGE,
  STREAMED_SIGNATURE_GATE_MESSAGE,
} from "./editToolGate";
import {
  buildAnnotationSavePlan,
  pendingEditsFromRaioAnnotations,
  type PendingEdit,
  type PendingExhibitStamp,
} from "./edits";

describe("editToolStreamedGateMessage", () => {
  it("gates signatures on streamed documents with the staged-ship message", () => {
    expect(editToolStreamedGateMessage("sign", true)).toBe(STREAMED_SIGNATURE_GATE_MESSAGE);
  });

  it("gates form authoring before edits are staged on streamed documents", () => {
    expect(editToolStreamedGateMessage("formText", true)).toBe(
      STREAMED_FORM_AUTHORING_GATE_MESSAGE,
    );
    expect(editToolStreamedGateMessage("formCheckbox", true)).toBe(
      STREAMED_FORM_AUTHORING_GATE_MESSAGE,
    );
  });

  it("does not gate byte-backed documents or supported streamed edit tools", () => {
    expect(editToolStreamedGateMessage("sign", false)).toBeNull();
    expect(editToolStreamedGateMessage("formText", false)).toBeNull();
    expect(editToolStreamedGateMessage("formCheckbox", false)).toBeNull();
    expect(editToolStreamedGateMessage("highlight", true)).toBeNull();
    expect(editToolStreamedGateMessage("textBox", true)).toBeNull();
    expect(editToolStreamedGateMessage("comment", true)).toBeNull();
  });
});

describe("streamedAnnotationPlanGateMessage", () => {
  const placedStamp: PendingExhibitStamp = {
    kind: "stamp",
    id: "stamp-1",
    pageIndex: 0,
    rect: { x: 40, y: 60, w: 115.2, h: 72 },
    lines: ["Plaintiff's Exhibit", "1"],
    fontSizePt: 14,
  };

  function importedStamp(): PendingEdit {
    const [imported] = pendingEditsFromRaioAnnotations([
      {
        pageIndex: 0,
        annotId: "stamp-annot",
        edit: {
          type: "stamp",
          annotId: "stamp-annot",
          pageIndex: 0,
          rect: { x: 40, y: 60, w: 115.2, h: 72 },
          lines: ["Plaintiff's Exhibit", "1"],
          fontSizePt: 14,
        },
      },
    ]);

    if (!imported) {
      throw new Error("The imported stamp was dropped.");
    }

    return imported;
  }

  it("lets a new exhibit stamp through — the streamed lane appends", () => {
    const plan = buildAnnotationSavePlan([placedStamp], new Set());

    expect(plan.appendEdits).toHaveLength(1);
    expect(streamedAnnotationPlanGateMessage(plan)).toBeNull();
  });

  it("leaves an untouched imported stamp out of the plan entirely", () => {
    const plan = buildAnnotationSavePlan([importedStamp()], new Set(["stamp-annot"]));

    expect(plan.updateEdits).toHaveLength(0);
    expect(streamedAnnotationPlanGateMessage(plan)).toBeNull();
  });

  it("gates a moved imported stamp, which the streamed lane cannot rewrite", () => {
    const moved = { ...importedStamp(), rect: { x: 100, y: 100, w: 115.2, h: 72 } };
    const plan = buildAnnotationSavePlan([moved], new Set(["stamp-annot"]));

    expect(plan.updateEdits).toHaveLength(1);
    expect(streamedAnnotationPlanGateMessage(plan)).toBe(
      STREAMED_ANNOTATION_UPDATE_GATE_MESSAGE,
    );
  });

  it("gates a deleted imported stamp too", () => {
    const plan = buildAnnotationSavePlan([], new Set(["stamp-annot"]));

    expect(plan.deleteAnnotIds).toEqual(["stamp-annot"]);
    expect(streamedAnnotationPlanGateMessage(plan)).toBe(
      STREAMED_ANNOTATION_UPDATE_GATE_MESSAGE,
    );
  });
});
