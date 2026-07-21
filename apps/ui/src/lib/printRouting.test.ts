import { describe, expect, it } from "vitest";
import { chooseNonStreamedPrintRoute } from "./printRouting";

describe("chooseNonStreamedPrintRoute", () => {
  it("prints natively when a desktop file grant is available", () => {
    for (const platform of ["macos", "windows"] as const) {
      expect(chooseNonStreamedPrintRoute({ platform, hasFileGrant: true })).toBe(
        "native",
      );
    }
  });

  it("asks to save first for an in-memory document on macOS (no window.print)", () => {
    expect(
      chooseNonStreamedPrintRoute({ platform: "macos", hasFileGrant: false }),
    ).toBe("save-first");
  });

  it("falls back to window.print() on the web and on Windows without a grant", () => {
    expect(
      chooseNonStreamedPrintRoute({ platform: "web", hasFileGrant: false }),
    ).toBe("dom");
    expect(
      chooseNonStreamedPrintRoute({ platform: "windows", hasFileGrant: false }),
    ).toBe("dom");
  });
});
