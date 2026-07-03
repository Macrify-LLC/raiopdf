const STORAGE_KEY = "raiopdf.productionLastUsedByPrefix.v1";

export type ProductionLastUsedMap = Record<string, number>;

export function readProductionLastUsed(prefix: string): number | null {
  const key = normalizePrefix(prefix);
  if (!key) {
    return null;
  }

  const map = readProductionLastUsedMap();
  const value = map[key];

  if (value === undefined) {
    return null;
  }

  return Number.isInteger(value) && value >= 0 ? value : null;
}

export function writeProductionLastUsed(prefix: string, lastUsedNumber: number): void {
  const key = normalizePrefix(prefix);
  if (!key || !Number.isInteger(lastUsedNumber) || lastUsedNumber < 0) {
    return;
  }

  const map = readProductionLastUsedMap();
  map[key] = lastUsedNumber;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

export function productionHintMessage(prefix: string): string | null {
  const lastUsed = readProductionLastUsed(prefix);
  if (lastUsed === null) {
    return null;
  }

  return `last production ended at ${prefix}${String(lastUsed).padStart(6, "0")}`;
}

function readProductionLastUsedMap(): ProductionLastUsedMap {
  if (typeof window === "undefined") {
    return {};
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : {};

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const output: ProductionLastUsedMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Number.isInteger(value) && value >= 0) {
        output[key] = value;
      }
    }

    return output;
  } catch {
    return {};
  }
}

function normalizePrefix(prefix: string): string {
  return prefix.trim().toUpperCase();
}
