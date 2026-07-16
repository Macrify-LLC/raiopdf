// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { PendingEdit } from "../lib/edits";
import { useEditing, type EditingState } from "./useEditing";

describe("useEditing pin state", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }

    container?.remove();
    root = null;
    container = null;
  });

  it("sets a single pending edit status", async () => {
    const getEditing = renderHookValue();

    await act(async () => {
      getEditing().addEdit(textBoxEdit("draft-edit"));
      getEditing().addEdit(textBoxEdit("applied-edit", "applied"));
      await Promise.resolve();
    });

    expect(statuses(getEditing())).toEqual({
      "draft-edit": "draft",
      "applied-edit": "applied",
    });

    await act(async () => {
      getEditing().setEditStatus("draft-edit", "applied");
      await Promise.resolve();
    });

    expect(statuses(getEditing())).toEqual({
      "draft-edit": "applied",
      "applied-edit": "applied",
    });

    await act(async () => {
      getEditing().setEditStatus("applied-edit", "draft");
      await Promise.resolve();
    });

    expect(statuses(getEditing())).toEqual({
      "draft-edit": "applied",
      "applied-edit": "draft",
    });
  });

  it("pins and unpins all pending edits", async () => {
    const getEditing = renderHookValue();

    await act(async () => {
      getEditing().addEdit(textBoxEdit("one"));
      getEditing().addEdit(textBoxEdit("two", "applied"));
      await Promise.resolve();
    });

    expect(getEditing().draftEditCount).toBe(1);
    expect(getEditing().appliedEditCount).toBe(1);

    await act(async () => {
      getEditing().applyPending();
      await Promise.resolve();
    });

    expect(getEditing().draftEditCount).toBe(0);
    expect(getEditing().appliedEditCount).toBe(2);

    await act(async () => {
      getEditing().unapplyPending();
      await Promise.resolve();
    });

    expect(getEditing().draftEditCount).toBe(2);
    expect(getEditing().appliedEditCount).toBe(0);
    expect(statuses(getEditing())).toEqual({ one: "draft", two: "draft" });
  });

  it("captures and restores document-bound state across a reset (tab switch round-trip)", async () => {
    const getEditing = renderHookValue();

    await act(async () => {
      getEditing().addEdit(textBoxEdit("kept-edit"));
      getEditing().setFormValue("client-name", "Smith");
      await Promise.resolve();
    });

    expect(getEditing().hasUnsavedEdits).toBe(true);

    let snapshot: ReturnType<EditingState["captureDocumentState"]> | undefined;
    await act(async () => {
      snapshot = getEditing().captureDocumentState();
      // Simulate switching away to another tab's document.
      getEditing().resetForDocument();
      await Promise.resolve();
    });

    expect(getEditing().pendingEdits).toHaveLength(0);
    expect(getEditing().hasUnsavedEdits).toBe(false);

    await act(async () => {
      // Simulate switching back.
      getEditing().restoreDocumentState(snapshot!);
      await Promise.resolve();
    });

    expect(statuses(getEditing())).toEqual({ "kept-edit": "draft" });
    expect(getEditing().formValues).toEqual({ "client-name": "Smith" });
    expect(getEditing().hasUnsavedEdits).toBe(true);
  });

  it.each(["formText", "formCheckbox"] as const)(
    "clears inherited %s mode when the document resets",
    async (tool) => {
      const getEditing = renderHookValue();

      await act(async () => {
        getEditing().setTool(tool);
        await Promise.resolve();
      });
      expect(getEditing().tool).toBe(tool);

      await act(async () => {
        getEditing().resetForDocument();
        await Promise.resolve();
      });

      expect(getEditing().tool).toBe("select");
    },
  );

  it("keeps authored fields reusable when saving existing form values", async () => {
    const getEditing = renderHookValue();

    await act(async () => {
      getEditing().addEdit(formFieldEdit());
      getEditing().setFormValue("existing.name", "Jane Doe");
      await Promise.resolve();
    });

    const annotationSave = getEditing().collectAnnotationSavePlan();
    const directSave = getEditing().collectEdits();

    expect(annotationSave?.plan.appendEdits.map((edit) => edit.type)).toEqual([
      "formField",
      "formValues",
    ]);
    expect(annotationSave?.flatten).toBe(false);
    expect(directSave?.flatten).toBe(false);
  });

  it("keeps authored fields reusable when a signature is saved with them", async () => {
    const getEditing = renderHookValue();

    await act(async () => {
      getEditing().addEdit(formFieldEdit());
      getEditing().addEdit({
        kind: "signature",
        id: "signature",
        pageIndex: 0,
        rect: { x: 10, y: 10, w: 100, h: 40 },
        bytes: new Uint8Array([1]),
        format: "png",
        dataUrl: "data:image/png;base64,AQ==",
        aspectRatio: 2.5,
      });
      await Promise.resolve();
    });

    expect(getEditing().collectAnnotationSavePlan()?.flatten).toBe(false);
    expect(getEditing().collectEdits()?.flatten).toBe(false);
  });

  function renderHookValue(): () => EditingState {
    let latest: EditingState | null = null;
    render(<Harness onValue={(value) => { latest = value; }} />);

    return () => {
      if (!latest) {
        throw new Error("useEditing was not rendered.");
      }

      return latest;
    };
  }

  function render(element: ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(element);
    });
  }
});

function Harness({ onValue }: { onValue: (value: EditingState) => void }) {
  const editing = useEditing(null);
  onValue(editing);
  return null;
}

function textBoxEdit(id: string, status?: PendingEdit["status"]): PendingEdit {
  return {
    kind: "textBox",
    id,
    pageIndex: 0,
    rect: { x: 10, y: 10, w: 100, h: 40 },
    text: id,
    fontSizePt: 12,
    ...(status ? { status } : {}),
  };
}

function formFieldEdit(): PendingEdit {
  return {
    kind: "formField",
    fieldType: "text",
    id: "client-name",
    name: "client.name",
    pageIndex: 0,
    rect: { x: 20, y: 20, w: 180, h: 24 },
  };
}

function statuses(editing: EditingState): Record<string, PendingEdit["status"]> {
  return Object.fromEntries(editing.pendingEdits.map((edit) => [edit.id, edit.status]));
}
