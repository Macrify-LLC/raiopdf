import { describe, expect, it } from "vitest";
import { reorderPagesForDrop } from "./organizePages";

describe("reorderPagesForDrop", () => {
  const pages = [0, 1, 2, 3];

  it("drops a page after its immediate neighbour (the forward-drag no-op bug)", () => {
    // Dragging page 0 onto the right half of page 1 must actually move it.
    expect(reorderPagesForDrop(pages, [0], 1, "after")).toEqual([1, 0, 2, 3]);
  });

  it("dropping before the immediate next neighbour is a genuine no-op", () => {
    expect(reorderPagesForDrop(pages, [0], 1, "before")).toEqual([0, 1, 2, 3]);
  });

  it("moves a page backward, honouring the drop side", () => {
    expect(reorderPagesForDrop(pages, [2], 0, "before")).toEqual([2, 0, 1, 3]);
    expect(reorderPagesForDrop(pages, [3], 0, "after")).toEqual([0, 3, 1, 2]);
  });

  it("keeps a multi-page selection contiguous at the drop point", () => {
    expect(reorderPagesForDrop(pages, [0, 1], 3, "after")).toEqual([2, 3, 0, 1]);
    expect(reorderPagesForDrop(pages, [2, 3], 0, "before")).toEqual([2, 3, 0, 1]);
  });

  it("appends when the target is itself part of the moving set", () => {
    expect(reorderPagesForDrop(pages, [1, 2], 2, "after")).toEqual([0, 3, 1, 2]);
  });
});
