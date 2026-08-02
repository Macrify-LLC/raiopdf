// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PdfEditRect } from "@raiopdf/engine-api";
import type { PendingEdit } from "../lib/edits";
import {
  listExhibitStampTemplates,
  resetExhibitStampCacheForTests,
} from "../lib/exhibitStamps";
import { useEditing, type EditingState } from "./useEditing";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PLAINTIFF = "plaintiffs-exhibit";

describe("useEditing exhibit stamps", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    window.localStorage.clear();
    resetExhibitStampCacheForTests();
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }

    container?.remove();
    root = null;
    container = null;
    vi.restoreAllMocks();
  });

  it("opens the gallery when the stamp tool is chosen with nothing armed", async () => {
    const getEditing = renderHookValue();

    await act(async () => {
      getEditing().setTool("stamp");
      await Promise.resolve();
    });

    expect(getEditing().stampCardOpen).toBe(true);
    expect(getEditing().armedExhibitStamp).toBeNull();

    // Arming closes the gallery, and coming back to the tool leaves it closed
    // because there is already something to place.
    await act(async () => {
      getEditing().armExhibitStamp(PLAINTIFF);
      await Promise.resolve();
    });
    expect(getEditing().stampCardOpen).toBe(false);

    await act(async () => {
      getEditing().setTool("stamp");
      await Promise.resolve();
    });
    expect(getEditing().stampCardOpen).toBe(false);
  });

  it("previews the next label without consuming it, then advances on placement", async () => {
    const getEditing = renderHookValue();

    await act(async () => {
      getEditing().armExhibitStamp(PLAINTIFF);
      await Promise.resolve();
    });

    expect(getEditing().armedExhibitStamp?.label).toBe("Plaintiff's Exhibit 1");
    // Arming alone must not burn an exhibit number.
    expect(nextIndex()).toBe(0);

    let allocation: Awaited<
      ReturnType<EditingState["allocateExhibitStampIdentifier"]>
    > = null;
    await act(async () => {
      allocation = await getEditing().allocateExhibitStampIdentifier();
    });

    expect(allocation).toMatchObject({
      label: "Plaintiff's Exhibit 1",
      lines: ["Plaintiff's Exhibit", "1"],
      sequence: { index: 0 },
    });
    expect(nextIndex()).toBe(1);
    // The ghost now previews the number the NEXT click will use.
    expect(getEditing().armedExhibitStamp?.label).toBe("Plaintiff's Exhibit 2");
  });

  it("places nothing and explains itself when the counter can't be saved", async () => {
    const getEditing = renderHookValue();

    await act(async () => {
      getEditing().armExhibitStamp(PLAINTIFF);
      await Promise.resolve();
    });

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    let allocation: Awaited<
      ReturnType<EditingState["allocateExhibitStampIdentifier"]>
    > = null;
    await act(async () => {
      allocation = await getEditing().allocateExhibitStampIdentifier();
    });

    expect(allocation).toBeNull();
    expect(getEditing().message).toContain("could not be saved");
    expect(nextIndex()).toBe(0);
  });

  it("gives the number back for the newest stamp only, whichever delete path is used", async () => {
    const getEditing = renderHookValue();

    await act(async () => {
      getEditing().armExhibitStamp(PLAINTIFF);
      await Promise.resolve();
    });

    await act(async () => {
      const first = await getEditing().allocateExhibitStampIdentifier();
      getEditing().addEdit(stampEdit("stamp-1", first!.sequence.index));
      const second = await getEditing().allocateExhibitStampIdentifier();
      getEditing().addEdit(stampEdit("stamp-2", second!.sequence.index));
    });

    expect(nextIndex()).toBe(2);

    // Deleting the older stamp leaves the counter alone: the number after it is
    // already on a page and must never be handed out twice.
    await act(async () => {
      getEditing().removeEdit("stamp-1");
      await Promise.resolve();
    });
    expect(nextIndex()).toBe(2);

    // Deleting the newest one returns its number.
    await act(async () => {
      getEditing().removeEdit("stamp-2");
      await Promise.resolve();
    });
    expect(nextIndex()).toBe(1);
  });

  it("never returns an imported stamp's number", async () => {
    const getEditing = renderHookValue();

    await act(async () => {
      getEditing().armExhibitStamp(PLAINTIFF);
      await Promise.resolve();
    });

    await act(async () => {
      const allocation = await getEditing().allocateExhibitStampIdentifier();
      getEditing().addEdit({
        ...stampEdit("imported", allocation!.sequence.index),
        annotId: "annot-1",
        status: "applied",
      });
    });

    expect(nextIndex()).toBe(1);

    await act(async () => {
      getEditing().removeEdit("imported");
      await Promise.resolve();
    });

    // The number belongs to the saved file, not to this session's counter.
    expect(nextIndex()).toBe(1);
  });

  it("discarding two just-placed stamps returns both numbers so the next allocation reuses them", async () => {
    const getEditing = renderHookValue();

    await act(async () => {
      getEditing().armExhibitStamp(PLAINTIFF);
      await Promise.resolve();
    });

    await act(async () => {
      const first = await getEditing().allocateExhibitStampIdentifier();
      getEditing().addEdit(stampEdit("stamp-1", first!.sequence.index));
      const second = await getEditing().allocateExhibitStampIdentifier();
      getEditing().addEdit(stampEdit("stamp-2", second!.sequence.index));
    });

    expect(nextIndex()).toBe(2);

    await act(async () => {
      await getEditing().discardPendingEdits();
    });

    expect(nextIndex()).toBe(0);
    expect(getEditing().pendingEdits).toHaveLength(0);

    await act(async () => {
      const reused = await getEditing().allocateExhibitStampIdentifier();
      expect(reused).toMatchObject({ sequence: { index: 0 } });
    });
  });

  it("does not roll back anything when discard runs after the edits were already saved", async () => {
    const getEditing = renderHookValue();

    await act(async () => {
      getEditing().armExhibitStamp(PLAINTIFF);
      await Promise.resolve();
    });

    await act(async () => {
      const first = await getEditing().allocateExhibitStampIdentifier();
      getEditing().addEdit(stampEdit("stamp-1", first!.sequence.index));
    });

    expect(nextIndex()).toBe(1);

    // A real save flow clears the pending list once the edit is baked into
    // the file — the number was spent, not abandoned, so no rollback door
    // should touch it.
    await act(async () => {
      getEditing().clearPending();
    });

    await act(async () => {
      await getEditing().discardPendingEdits();
    });

    expect(nextIndex()).toBe(1);
  });

  it("rolls back only the draft stamps in a mixed placed+imported discard", async () => {
    const getEditing = renderHookValue();

    await act(async () => {
      getEditing().armExhibitStamp(PLAINTIFF);
      await Promise.resolve();
    });

    await act(async () => {
      // An imported stamp already lives in the saved file (annotId set,
      // arbitrary provenance index) sitting alongside a freshly placed draft.
      getEditing().addEdit({
        ...stampEdit("imported", 5),
        annotId: "annot-1",
        status: "applied",
      });
      const placed = await getEditing().allocateExhibitStampIdentifier();
      getEditing().addEdit(stampEdit("stamp-1", placed!.sequence.index));
    });

    expect(nextIndex()).toBe(1);

    await act(async () => {
      await getEditing().discardPendingEdits();
    });

    // The draft's number comes back; the imported stamp's number was never
    // touched — it belongs to the saved file, not this session's counter.
    expect(nextIndex()).toBe(0);
    expect(getEditing().pendingEdits).toHaveLength(0);
  });

  it("disarms when the tool changes or another document's state is restored", async () => {
    const getEditing = renderHookValue();

    await act(async () => {
      getEditing().armExhibitStamp(PLAINTIFF);
      await Promise.resolve();
    });
    expect(getEditing().armedExhibitStamp).not.toBeNull();

    await act(async () => {
      getEditing().setTool("highlight");
      await Promise.resolve();
    });
    expect(getEditing().armedExhibitStamp).toBeNull();

    await act(async () => {
      getEditing().setTool("stamp");
      getEditing().armExhibitStamp(PLAINTIFF);
      await Promise.resolve();
    });
    expect(getEditing().armedExhibitStamp).not.toBeNull();

    await act(async () => {
      getEditing().restoreDocumentState({
        pendingEdits: [],
        importedAnnotIds: new Set(),
        formValues: {},
      });
      await Promise.resolve();
    });

    expect(getEditing().armedExhibitStamp).toBeNull();
    expect(getEditing().stampCardOpen).toBe(false);
  });

  it("renumbers a design's drafts and imported stamps in one pass, then moves the counter", async () => {
    const getEditing = renderHookValue();

    await act(async () => {
      // An imported stamp (already in the file) and two drafts placed this
      // session, deliberately out of reading order down the page.
      getEditing().loadImportedAnnotations([
        {
          annotId: "annot-1",
          pageIndex: 0,
          edit: {
            type: "stamp",
            pageIndex: 0,
            rect: { x: 10, y: 300, w: 115.2, h: 72 },
            lines: ["Plaintiff's Exhibit", "9"],
            fontSizePt: 14,
            templateId: PLAINTIFF,
            sequence: {
              schemaVersion: 1,
              identifierStyle: "numbers",
              prefix: "Plaintiff's Exhibit",
              layout: "stacked",
              index: 8,
            },
          },
        },
      ]);
      getEditing().addEdit(stampEdit("draft-low", 5, { x: 10, y: 100, w: 115.2, h: 72 }));
      getEditing().addEdit(stampEdit("draft-high", 3, { x: 10, y: 600, w: 115.2, h: 72 }));
    });

    let result: Awaited<ReturnType<EditingState["renumberExhibitStamps"]>> = null;
    await act(async () => {
      result = await getEditing().renumberExhibitStamps(PLAINTIFF, 0);
    });

    expect(result).toMatchObject({ count: 3, lastIndex: 2, counterError: null });
    // Top of the page down: the draft at y=600, the imported one at y=300,
    // then the draft at y=100.
    expect(
      getEditing().pendingEdits.map((edit) => [edit.id, (edit as { lines?: string[] }).lines?.[1]]),
    ).toEqual([
      ["annot-annot-1", "2"],
      ["draft-low", "3"],
      ["draft-high", "1"],
    ]);
    // The counter continues the set rather than colliding with it.
    expect(nextIndex()).toBe(3);

    // The imported stamp changed, so it goes down the save plan's UPDATE lane
    // (rewriting the annotation in the file), while the drafts are appends.
    const plan = getEditing().collectMarkupAnnotationSavePlan();
    expect(plan.updateEdits.map((entry) => entry.annotId)).toEqual(["annot-1"]);
    expect(plan.deleteAnnotIds).toEqual([]);
    expect(plan.appendEdits).toHaveLength(2);
  });

  it("renumbers from the identifier the caller starts at", async () => {
    const getEditing = renderHookValue();

    await act(async () => {
      getEditing().addEdit(stampEdit("stamp-1", 0));
      getEditing().addEdit(stampEdit("stamp-2", 1));
    });

    await act(async () => {
      await getEditing().renumberExhibitStamps(PLAINTIFF, 11);
    });

    expect(
      getEditing().pendingEdits.map((edit) => (edit as { lines?: string[] }).lines?.[1]),
    ).toEqual(["12", "13"]);
    expect(nextIndex()).toBe(13);
  });

  it("renumbers nothing when the design has no stamps on the page", async () => {
    const getEditing = renderHookValue();

    let result: Awaited<ReturnType<EditingState["renumberExhibitStamps"]>> = null;
    await act(async () => {
      getEditing().requestExhibitStampRenumber(PLAINTIFF);
      result = await getEditing().renumberExhibitStamps(PLAINTIFF, 0);
    });

    expect(result).toBeNull();
    // Nothing to confirm, so no confirmation is raised.
    expect(getEditing().exhibitStampRenumberRequest).toBeNull();
    expect(nextIndex()).toBe(0);
  });

  function nextIndex(): number {
    resetExhibitStampCacheForTests();

    return (
      listExhibitStampTemplates().find((template) => template.id === PLAINTIFF)?.nextIndex ?? -1
    );
  }

  function renderHookValue(): () => EditingState {
    let latest: EditingState | null = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    act(() => {
      root?.render(<Harness onValue={(value) => { latest = value; }} />);
    });

    return () => {
      if (!latest) {
        throw new Error("useEditing was not rendered.");
      }

      return latest;
    };
  }
});

function Harness({ onValue }: { onValue: (value: EditingState) => void }): ReactNode {
  const editing = useEditing(null);
  onValue(editing);
  return null;
}

function stampEdit(
  id: string,
  index: number,
  rect: PdfEditRect = { x: 10, y: 10, w: 115.2, h: 72 },
): PendingEdit {
  return {
    kind: "stamp",
    id,
    pageIndex: 0,
    rect,
    lines: ["Plaintiff's Exhibit", String(index + 1)],
    fontSizePt: 14,
    templateId: PLAINTIFF,
    sequence: {
      schemaVersion: 1,
      identifierStyle: "numbers",
      prefix: "Plaintiff's Exhibit",
      layout: "stacked",
      index,
    },
  };
}
