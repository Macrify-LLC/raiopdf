import { describe, expect, it } from "vitest";
import {
  isWordPresent,
  shouldRefuseWord,
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
      "Microsoft Word isn't available.",
    );
  });
});
