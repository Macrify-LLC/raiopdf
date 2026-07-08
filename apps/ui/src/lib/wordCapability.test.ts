import { describe, expect, it } from "vitest";
import { isWordPresent, type WordCapabilityState } from "./wordCapability";

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
