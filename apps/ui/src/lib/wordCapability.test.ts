import { describe, expect, it } from "vitest";
import {
  isWordPresent,
  shouldRefuseWord,
  wordOperationGuidance,
  wordUnavailableMessage,
  type WordCapabilityState,
} from "./wordCapability";

describe("isWordPresent", () => {
  it("treats Word as present when it is registered or launched", () => {
    for (const state of ["detected", "available"] satisfies WordCapabilityState[]) {
      expect(isWordPresent({ state, reason: null })).toBe(true);
    }
  });

  it("treats Word as absent for every non-present state", () => {
    for (const state of [
      "notApplicable",
      "notDetected",
      "unavailable",
    ] satisfies WordCapabilityState[]) {
      expect(isWordPresent({ state, reason: null })).toBe(false);
    }
  });
});

describe("shouldRefuseWord", () => {
  it("only allows a conversion when Word actually launched (available)", () => {
    expect(shouldRefuseWord({ state: "available", reason: null })).toBe(false);
    for (const state of [
      "detected",
      "notApplicable",
      "notDetected",
      "unavailable",
    ] satisfies WordCapabilityState[]) {
      expect(shouldRefuseWord({ state, reason: null })).toBe(true);
    }
  });
});

describe("wordUnavailableMessage", () => {
  it("includes the probe reason when there is one", () => {
    expect(
      wordUnavailableMessage({ state: "unavailable", reason: "Word could not start." }),
    ).toBe("Microsoft Word isn't available: Word could not start.");
  });

  it("uses a computer-specific message when Word is not applicable", () => {
    expect(wordUnavailableMessage({ state: "notApplicable", reason: null })).toBe(
      "Microsoft Word isn't available on this computer.",
    );
  });

  it("falls back to a plain message when there is no reason", () => {
    expect(wordUnavailableMessage({ state: "notDetected", reason: null })).toBe(
      "Microsoft Word isn't available. Install Microsoft Word, then sign in with a license that allows desktop apps.",
    );
  });

  it("explains how to recover from denied macOS Automation permission", () => {
    expect(
      wordUnavailableMessage({
        state: "unavailable",
        reason: "macOS Automation permission to control Microsoft Word was denied.",
      }),
    ).toBe(
      "macOS denied RaioPDF permission to control Microsoft Word. In System Settings, go to Privacy & Security > Automation and allow RaioPDF to control Microsoft Word. Retrying before you allow it will not show the macOS permission prompt again; allow it there, then retry.",
    );
  });

  it("turns Word version and license reasons into actionable guidance", () => {
    expect(
      wordUnavailableMessage({ state: "unavailable", reason: "Microsoft Word version is too old." }),
    ).toBe(
      "Microsoft Word needs a supported version to work with RaioPDF: Microsoft Word version is too old.",
    );
    expect(
      wordUnavailableMessage({ state: "unavailable", reason: "Microsoft Word license is not active." }),
    ).toBe(
      "Microsoft Word needs to be signed in and licensed before RaioPDF can use it: Microsoft Word license is not active.",
    );
  });

  it("uses the typed conversion error when macOS denied Automation", () => {
    expect(wordOperationGuidance({
      code: "WORD_AUTOMATION_DENIED",
      message: "Application isn't allowed to send Apple events to Microsoft Word. (-1743)",
    })).toContain("System Settings, go to Privacy & Security > Automation");
  });
});
