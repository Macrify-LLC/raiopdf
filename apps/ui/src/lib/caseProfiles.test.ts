// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteCaseProfile,
  readCaseProfiles,
  readLastUsedCaseProfile,
  upsertCaseProfile,
} from "./caseProfiles";

const STORAGE_KEY = "raio.caseProfiles.v1";

beforeEach(() => {
  vi.stubGlobal("window", {
    localStorage: createMemoryStorage(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("caseProfiles", () => {
  it("round-trips CRUD and tracks the last used profile", () => {
    const first = upsertCaseProfile({
      name: "Smith v. Jones",
      preferredStyleId: "classic-boxed",
      caption: {
        courtName: "Circuit Court",
        county: "Orange County, Florida",
        parties: [{ role: "Plaintiff", names: ["Jane Smith"] }],
        caseNumber: "2026-CA-1234",
        documentTitle: "Motion to Compel",
      },
    });
    const second = upsertCaseProfile({
      name: "Acme matter",
      caption: {
        courtName: "United States District Court",
        parties: [{ role: "Defendant", names: ["Acme Corp."], etAl: true }],
        documentTitle: "Notice of Filing",
      },
    });

    expect(readCaseProfiles()).toEqual([first, second]);
    expect(readLastUsedCaseProfile()).toEqual(second);

    const updated = upsertCaseProfile({
      ...first,
      name: "Smith matter",
    });

    expect(readCaseProfiles()).toEqual([second, updated]);
    expect(readLastUsedCaseProfile()).toEqual(updated);

    deleteCaseProfile(updated.id);

    expect(readCaseProfiles()).toEqual([second]);
    expect(readLastUsedCaseProfile()).toEqual(second);
  });

  it("returns an empty list for malformed stored blobs", () => {
    window.localStorage.setItem(STORAGE_KEY, "{not json");

    expect(readCaseProfiles()).toEqual([]);
    expect(readLastUsedCaseProfile()).toBeNull();

    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ profiles: [{ id: "bad" }] }));

    expect(readCaseProfiles()).toEqual([]);
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
