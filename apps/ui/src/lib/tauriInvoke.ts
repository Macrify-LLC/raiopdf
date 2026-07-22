/**
 * Single source of truth for acquiring the Tauri `invoke` function.
 *
 * Returns the test override (`window.__RAIOPDF_TEST_TAURI_INVOKE__`) when one is
 * installed, otherwise lazily imports the real `invoke` from
 * `@tauri-apps/api/core`. This helper was previously duplicated in
 * `useEngineBridge.ts` and `diagnostics.ts`, and `filePort.ts` imported `invoke`
 * directly at each call site — so the file-dialog commands bypassed the seam.
 * Consolidating here lets every `invoke` call (engine, diagnostics, and file
 * dialogs) resolve through one override point, used by the real-engine Playwright
 * canary and the real-app WebDriver canary.
 */

import type { InvokeArgs, InvokeOptions } from "@tauri-apps/api/core";

/**
 * Mirrors the real `@tauri-apps/api/core` `invoke` signature (including the
 * raw-body form `invoke(cmd, bytes, { headers })` that the save commands in
 * `filePort.ts` use), so routing those calls through this seam type-checks.
 */
export type TauriInvoke = <T>(
  command: string,
  args?: InvokeArgs,
  options?: InvokeOptions,
) => Promise<T>;

declare global {
  interface Window {
    __RAIOPDF_TEST_TAURI_INVOKE__?: TauriInvoke;
  }
}

export async function getTauriInvoke(): Promise<TauriInvoke> {
  if (window.__RAIOPDF_TEST_TAURI_INVOKE__) {
    return window.__RAIOPDF_TEST_TAURI_INVOKE__;
  }

  const { invoke } = await import("@tauri-apps/api/core");
  return invoke;
}

export function hasTestInvoke(): boolean {
  return typeof window.__RAIOPDF_TEST_TAURI_INVOKE__ === "function";
}
