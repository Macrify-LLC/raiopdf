/**
 * Prepare for Filing flow: a landscape document plus a small custom split cap
 * makes the filing output split into multiple parts. A multi-part filing save
 * routes through the real `pick_output_directory` command (stubbed to a canned
 * folder) followed by `save_pdf_into_dir` for each part — so the assertion is
 * that several real PDF parts land in the folder.
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { setDialogControl } from "../support/dialogControl";
import { createHeavyLandscapePdf, writePdfFixture } from "../support/fixtures";
import { outputsDir } from "../support/paths";
import { dialogByTitle, openDocument, xpathLiteral } from "../support/app";

const FILING_TITLE = "Prepare for Filing";

describe("Prepare for Filing", () => {
  it("splits an oversize filing into multiple parts saved to a folder", async () => {
    const source = writePdfFixture("filing-landscape.pdf", await createHeavyLandscapePdf(100));
    const filingOut = path.join(outputsDir, "filing");
    rmSync(filingOut, { recursive: true, force: true });
    mkdirSync(filingOut, { recursive: true });
    setDialogControl({ open_pdf_dialog: source, pick_output_directory: filingOut });

    await openDocument();

    // The command-bar CTA opens the same dialog as the Legal sidebar row.
    await $(".command-bar__filing-cta").click();
    const dialog = dialogByTitle(FILING_TITLE);
    await dialog.waitForDisplayed({ timeout: 30_000 });

    // Expand the "Split by upload cap" step (checked by default for Florida)
    // and set a tiny custom cap so the output must split into several parts.
    const splitRow = dialog.$(
      `.//article[contains(@class,"filing-prep-row")]` +
        `[.//span[normalize-space(.)=${xpathLiteral("Split by upload cap")}]]`,
    );
    await splitRow.$(".filing-prep-row__expand").click();
    const capInput = splitRow.$(".filing-prep-row__override input");
    await capInput.waitForDisplayed({ timeout: 10_000 });
    await capInput.setValue("0.05");

    await dialog.$(".filing-card__primary-button").click();

    await browser.waitUntil(
      () =>
        existsSync(filingOut) &&
        readdirSync(filingOut).filter((name) => name.toLowerCase().endsWith(".pdf")).length >= 2,
      {
        timeout: 120_000,
        timeoutMsg: "Filing did not produce multiple parts in the output folder",
      },
    );

    // The dialog stays open on the result — prove it is not focus-trapped by
    // closing it through its own close control.
    await dialog.$('[aria-label="Close Prepare for Filing"]').click();
    await dialog.waitForExist({ reverse: true, timeout: 20_000 });
  });
});
