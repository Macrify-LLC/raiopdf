import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readFilingPreferences,
  selectDefaultPack,
  setPrepStepDefaultOverrides,
  writeFilingPreferences,
} from "./filingPreferences";

beforeEach(() => {
  vi.stubGlobal("window", {
    localStorage: createMemoryStorage(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("filing preferences", () => {
  it("defaults missing step overrides to an empty map", () => {
    window.localStorage.setItem("raiopdf.filingPreferences.v1", JSON.stringify({
      courtProfiles: [],
      lastCourtProfileByPack: {},
    }));

    expect(readFilingPreferences().stepDefaultOverridesByPack).toEqual({});
  });

  it("leaves the default pack unset until one is chosen", () => {
    expect(readFilingPreferences().defaultPackId).toBeUndefined();
  });

  it("round-trips the default jurisdiction pack", () => {
    const next = selectDefaultPack(readFilingPreferences(), "federal-cmecf");

    writeFilingPreferences(next);

    expect(readFilingPreferences().defaultPackId).toBe("federal-cmecf");
  });

  it("round-trips per-pack prep step default overrides", () => {
    const next = setPrepStepDefaultOverrides(readFilingPreferences(), "florida", {
      "convert-pdfa": false,
      "flatten-forms": true,
    });

    writeFilingPreferences(next);

    expect(readFilingPreferences().stepDefaultOverridesByPack.florida).toEqual({
      "convert-pdfa": false,
      "flatten-forms": true,
    });
  });
});

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();

  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    key(index: number) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key: string) {
      values.delete(key);
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
  };
}
