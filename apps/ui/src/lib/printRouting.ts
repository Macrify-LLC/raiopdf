import type { RuntimePlatform } from "./runtimePlatform";

/**
 * How to print a normal-size (non-streamed) document.
 *
 * - `native`: the desktop shell has the document on disk (a path-ops grant),
 *   so print it through the native pipeline — CUPS `lp` on macOS, Ghostscript
 *   on Windows — which prints the file at full fidelity, any length, via the
 *   Print dialog. Replaces `window.print()`, which only ever captured the
 *   handful of pages the virtualized viewer keeps mounted.
 * - `save-first`: an in-memory-only document on macOS. The packaged WKWebView
 *   has no working `window.print()`, so there is nothing to fall back to —
 *   ask the user to save first, which gives the document a path and the
 *   `native` route.
 * - `dom`: web, or an in-memory document on Windows — hand the rendered page
 *   to the webview's own `window.print()`.
 */
export type NonStreamedPrintRoute = "native" | "save-first" | "dom";

export function chooseNonStreamedPrintRoute(input: {
  platform: RuntimePlatform;
  /** Desktop runtime AND a resolved on-disk file grant for the open document. */
  hasFileGrant: boolean;
}): NonStreamedPrintRoute {
  if (input.hasFileGrant) {
    return "native";
  }
  return input.platform === "macos" ? "save-first" : "dom";
}
