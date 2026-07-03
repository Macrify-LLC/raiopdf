import { afterEach, describe, expect, it } from "vitest";
import {
  isTopDialogStackEntry,
  registerDialogStackEntry,
  resetDialogStackForTests,
} from "./FloatingDialog";

describe("FloatingDialog modal stack", () => {
  afterEach(() => {
    resetDialogStackForTests();
  });

  it("treats the newest registered dialog as the only top entry", () => {
    const unregisterBase = registerDialogStackEntry("base");
    const unregisterNested = registerDialogStackEntry("nested");

    expect(isTopDialogStackEntry("base")).toBe(false);
    expect(isTopDialogStackEntry("nested")).toBe(true);

    unregisterNested();

    expect(isTopDialogStackEntry("base")).toBe(true);

    unregisterBase();

    expect(isTopDialogStackEntry("base")).toBe(false);
  });

  it("can remove a lower dialog without changing the top dialog", () => {
    const unregisterBase = registerDialogStackEntry("base");
    const unregisterMiddle = registerDialogStackEntry("middle");
    const unregisterNested = registerDialogStackEntry("nested");

    unregisterMiddle();

    expect(isTopDialogStackEntry("nested")).toBe(true);
    expect(isTopDialogStackEntry("base")).toBe(false);

    unregisterNested();
    unregisterBase();
  });
});
