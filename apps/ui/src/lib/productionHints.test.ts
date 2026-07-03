import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  productionHintMessage,
  readProductionLastUsed,
  writeProductionLastUsed,
} from "./productionHints";

beforeEach(() => {
  vi.stubGlobal("window", {
    localStorage: createMemoryStorage(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("production last-used hints", () => {
  it("stores and reads the last used Bates number by prefix", () => {
    writeProductionLastUsed("smith", 482);

    expect(readProductionLastUsed("SMITH")).toBe(482);
    expect(productionHintMessage("SMITH")).toBe("last production ended at SMITH000482");
  });

  it("ignores invalid hints instead of throwing", () => {
    window.localStorage.setItem("raiopdf.productionLastUsedByPrefix.v1", "{broken");

    expect(readProductionLastUsed("SMITH")).toBeNull();
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
