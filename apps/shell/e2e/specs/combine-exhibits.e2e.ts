/**
 * Combine with Exhibits flow: adding exhibits in the desktop runtime invokes the
 * real `pick_pdfs_for_add` command (stubbed to canned paths), and Build Binder
 * assembles the real binder. The assertion is that the document grows to the
 * expected page count (main + index + exhibits) and the workspace closes cleanly.
 */
import { setDialogControl } from "../support/dialogControl";
import { createPdf, writePdfFixture } from "../support/fixtures";
import { openDocument, xpathLiteral } from "../support/app";

describe("Combine with Exhibits", () => {
  it("adds picked exhibits and builds a binder", async () => {
    const main = writePdfFixture("binder-main.pdf", await createPdf([200, 210]));
    const exhibitA = writePdfFixture("binder-exhibit-a.pdf", await createPdf([300, 310]));
    const exhibitB = writePdfFixture("binder-exhibit-b.pdf", await createPdf([350]));
    setDialogControl({ open_pdf_dialog: main, pick_pdfs_for_add: [exhibitA, exhibitB] });

    await openDocument();

    // Legal accordion is open by default; the row opens the binder workspace.
    await $(
      `//button[contains(@class,"tool-row__select")]` +
        `[normalize-space(.)=${xpathLiteral("Combine with Exhibits")}]`,
    ).click();
    const workspace = $(".binder-workspace");
    await workspace.waitForDisplayed({ timeout: 30_000 });

    // The desktop Add button routes through pick_pdfs_for_add (not the DOM input).
    await $(".binder-workspace__add").click();
    await $('[aria-label="Move binder-exhibit-a.pdf down"]').waitForDisplayed({ timeout: 30_000 });

    await $(".binder-workspace__primary").click();

    // main(2) + exhibit index(1) + A(2) + B(1) = 6 pages, and the workspace closes.
    await $('[aria-label="Page 6"]').waitForDisplayed({ timeout: 60_000 });
    await expect($('[aria-label="Unsaved changes"]')).toBeDisplayed();
    await workspace.waitForExist({ reverse: true, timeout: 20_000 });
  });
});
