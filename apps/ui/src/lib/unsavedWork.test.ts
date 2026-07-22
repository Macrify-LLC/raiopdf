import { describe, expect, it } from "vitest";
import { hasUnsavedWork, tabCloseNeedsConfirm } from "./unsavedWork";

const cleanWindow = {
  tabDirtyFlags: [false, false],
  tabTempBackedUnsavedFlags: [false, false],
  activeTabHasPendingEdits: false,
  activeTabPendingRedactionCount: 0,
  stashedBackgroundTabCount: 0,
} as const;

describe("hasUnsavedWork", () => {
  it("reports clean when no tab is dirty and nothing is pending", () => {
    expect(hasUnsavedWork(cleanWindow)).toBe(false);
    expect(hasUnsavedWork({ ...cleanWindow, tabDirtyFlags: [] })).toBe(false);
  });

  it("flags a dirty tab anywhere, not just the active one", () => {
    expect(
      hasUnsavedWork({ ...cleanWindow, tabDirtyFlags: [false, true, false] }),
    ).toBe(true);
  });

  it("flags the active tab's pending annotation edits", () => {
    expect(
      hasUnsavedWork({ ...cleanWindow, activeTabHasPendingEdits: true }),
    ).toBe(true);
  });

  it("flags the active tab's unapplied redaction marks", () => {
    expect(
      hasUnsavedWork({ ...cleanWindow, activeTabPendingRedactionCount: 1 }),
    ).toBe(true);
  });

  it("flags a background tab whose pending work is stashed even when no dirty flag is set", () => {
    // Redaction-only pending state never marks the document dirty, so the
    // stashed switch-away snapshot is the only signal for background tabs.
    expect(
      hasUnsavedWork({ ...cleanWindow, stashedBackgroundTabCount: 1 }),
    ).toBe(true);
  });

  it("flags a clean, temp-backed-but-never-saved tab (derived/imported doc)", () => {
    // A derived doc staged to a temp file is clean (no pending edits) but was
    // never saved to a real file — closing must still confirm, from any tab.
    expect(
      hasUnsavedWork({
        ...cleanWindow,
        tabTempBackedUnsavedFlags: [false, true],
      }),
    ).toBe(true);
  });
});

const cleanTab = {
  tabDirty: false,
  isActiveTab: false,
  activeTabHasPendingEdits: false,
  activeTabPendingRedactionCount: 0,
  tabHasStashedWork: false,
  tabTempBackedUnsaved: false,
} as const;

describe("tabCloseNeedsConfirm", () => {
  it("closes a clean tab without confirmation", () => {
    expect(tabCloseNeedsConfirm(cleanTab)).toBe(false);
    expect(tabCloseNeedsConfirm({ ...cleanTab, isActiveTab: true })).toBe(false);
  });

  it("confirms a dirty tab regardless of which tab is active", () => {
    expect(tabCloseNeedsConfirm({ ...cleanTab, tabDirty: true })).toBe(true);
    expect(
      tabCloseNeedsConfirm({ ...cleanTab, tabDirty: true, isActiveTab: true }),
    ).toBe(true);
  });

  it("confirms the active tab when annotation edits or redaction marks are pending", () => {
    expect(
      tabCloseNeedsConfirm({
        ...cleanTab,
        isActiveTab: true,
        activeTabHasPendingEdits: true,
      }),
    ).toBe(true);
    expect(
      tabCloseNeedsConfirm({
        ...cleanTab,
        isActiveTab: true,
        activeTabPendingRedactionCount: 2,
      }),
    ).toBe(true);
  });

  it("ignores active-tab pending state when closing a background tab", () => {
    // The background tab's own pending work is represented by its snapshot,
    // not by the visible document's editing state.
    expect(
      tabCloseNeedsConfirm({
        ...cleanTab,
        activeTabHasPendingEdits: true,
        activeTabPendingRedactionCount: 3,
      }),
    ).toBe(false);
  });

  it("confirms a background tab whose pending work is stashed", () => {
    expect(
      tabCloseNeedsConfirm({ ...cleanTab, tabHasStashedWork: true }),
    ).toBe(true);
  });

  it("confirms a clean, temp-backed-but-never-saved tab from any position", () => {
    expect(
      tabCloseNeedsConfirm({ ...cleanTab, tabTempBackedUnsaved: true }),
    ).toBe(true);
    expect(
      tabCloseNeedsConfirm({
        ...cleanTab,
        tabTempBackedUnsaved: true,
        isActiveTab: true,
      }),
    ).toBe(true);
  });
});
