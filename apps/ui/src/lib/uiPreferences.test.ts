import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readUiPreferences, writeUiPreferences } from "./uiPreferences";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) };
}

beforeEach(() => vi.stubGlobal("window", { localStorage: storage() }));
afterEach(() => vi.unstubAllGlobals());

describe("UI preferences", () => {
  it("defaults experimental features off and round-trips the opt-in", () => {
    expect(readUiPreferences().experimentalFeaturesEnabled).toBe(false);
    writeUiPreferences({ experimentalFeaturesEnabled: true });
    expect(readUiPreferences().experimentalFeaturesEnabled).toBe(true);
  });

  it("safely ignores malformed stored values and reports unavailable storage writes", () => {
    window.localStorage.setItem("raiopdf.uiPreferences.v1", "not-json");
    expect(readUiPreferences().experimentalFeaturesEnabled).toBe(false);
    vi.stubGlobal("window", { localStorage: { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } } });
    expect(readUiPreferences().experimentalFeaturesEnabled).toBe(false);
    expect(writeUiPreferences({ experimentalFeaturesEnabled: true })).toBe(false);
  });

  it("reports a successful persisted write", () => {
    expect(writeUiPreferences({ experimentalFeaturesEnabled: true })).toBe(true);
  });
});
