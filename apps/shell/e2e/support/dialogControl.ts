/**
 * Writes the native-dialog control file the Rust `e2e_dialog` stub reads.
 *
 * The stub (`apps/shell/src-tauri/src/e2e_dialog.rs`, behind the `e2e-webdriver`
 * feature) reads this JSON on every picker invocation and returns the canned
 * ABSOLUTE path for the matching command instead of showing the native OS
 * picker — the real Rust command body (grant creation, file writes, validation)
 * still runs. A key that is absent falls back to the real picker.
 *
 * Because the stub re-reads the file each call, a spec just rewrites this one
 * file before triggering a flow; the app process never restarts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { controlFile } from "./paths";

/** Mirrors the four picker slots the Rust stub covers. All paths absolute. */
export interface DialogControl {
  open_pdf_dialog?: string;
  save_pdf_dialog?: string;
  pick_output_directory?: string;
  pick_pdfs_for_add?: string[];
}

/** Overwrite the control file with `control` (replacing any prior flow). */
export function setDialogControl(control: DialogControl): void {
  mkdirSync(path.dirname(controlFile), { recursive: true });
  writeFileSync(controlFile, JSON.stringify(control, null, 2), "utf8");
}

/** Reset to an empty control so no stale canned path leaks into the next flow. */
export function clearDialogControl(): void {
  setDialogControl({});
}
