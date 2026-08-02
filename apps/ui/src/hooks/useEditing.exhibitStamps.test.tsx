// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

function stampEdit(id: string, index: number): PendingEdit {
  return {
    kind: "stamp",
    id,
    pageIndex: 0,
    rect: { x: 10, y: 10, w: 115.2, h: 72 },
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
