/**
 * Save As flow: File → Save As... invokes the real `save_pdf_dialog` command,
 * whose stub returns a canned destination path. The real command body writes the
 * document bytes there, so the assertion is a genuine file on disk.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { setDialogControl } from "../support/dialogControl";
import { createTextPdf, writePdfFixture } from "../support/fixtures";
import { outputsDir } from "../support/paths";
import { openDocument, openMenu } from "../support/app";

describe("Save As", () => {
  it("writes the document to the canned save path", async () => {
    const source = writePdfFixture("save-as-source.pdf", await createTextPdf("Save As canary"));
    const savePath = path.join(outputsDir, "saved-as.pdf");
    rmSync(savePath, { force: true });
    setDialogControl({ open_pdf_dialog: source, save_pdf_dialog: savePath });

    await openDocument();

    await openMenu("File", "Save As...");

    await browser.waitUntil(() => existsSync(savePath), {
      timeout: 30_000,
      timeoutMsg: `Save As did not write ${savePath}`,
    });
    const bytes = readFileSync(savePath);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    // No in-app modal should linger after a native (stubbed) save.
    await expect($('[role="dialog"]')).not.toBeExisting();
  });
});
