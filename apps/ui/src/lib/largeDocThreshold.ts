/**
 * Shared "large document" byte threshold (large-PDF-handling plan, Phase 1).
 *
 * Files at or below this size follow today's in-memory byte paths; files
 * above it must never be fully materialized in the WebView -- they travel as
 * grant descriptors (Tauri) or are honestly gated (browser). See
 * `readFileForAdd.ts` for the add-flow choke point that enforces this.
 *
 * INTEGRATION CONTRACT (Lane A): the shell owns the authoritative default
 * (50 MB) with the env override `RAIOPDF_LARGE_DOC_THRESHOLD_BYTES`, and
 * returns the effective value with every open result so UI and shell cannot
 * drift. When that lands, the open path must call
 * `setLargeDocThresholdBytes(shellReportedThreshold)` once at startup/open;
 * until then this module's default (and the Vite-side env hook below) is the
 * single UI-side source of truth. Keep the default identical to the shell's.
 */
export const DEFAULT_LARGE_DOC_THRESHOLD_BYTES = 52_428_800; // 50 MiB

let runtimeOverrideBytes: number | null = null;

/**
 * Runtime override hook -- called with the shell-reported threshold (Lane A)
 * or `null` to clear back to the default/env value.
 */
export function setLargeDocThresholdBytes(bytes: number | null): void {
  runtimeOverrideBytes = normalizeThreshold(bytes);
}

export function getLargeDocThresholdBytes(): number {
  if (runtimeOverrideBytes !== null) {
    return runtimeOverrideBytes;
  }

  // Dev/browser-build override hook. Mirrors the shell env var name with the
  // Vite client prefix: VITE_RAIOPDF_LARGE_DOC_THRESHOLD_BYTES.
  const fromEnv = normalizeThreshold(readEnvThreshold());
  return fromEnv ?? DEFAULT_LARGE_DOC_THRESHOLD_BYTES;
}

function readEnvThreshold(): number | null {
  const env = import.meta.env as Record<string, unknown> | undefined;
  const raw = env?.["VITE_RAIOPDF_LARGE_DOC_THRESHOLD_BYTES"];

  if (typeof raw === "number") {
    return raw;
  }

  if (typeof raw === "string" && raw.trim() !== "") {
    return Number(raw);
  }

  return null;
}

function normalizeThreshold(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return null;
  }

  return Math.floor(value);
}
