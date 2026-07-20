/**
 * Open flow: clicking the command-bar Open button invokes the real
 * `open_pdf_dialog` Rust command, which (under the e2e stub) returns a canned
 * absolute path instead of showing the native picker. The rest of the open path
 * — grant creation, byte read, pdf.js render — runs for real.
 */
import { setDialogControl } from "../support/dialogControl";
import { createTextPdf, writePdfFixture } from "../support/fixtures";
import { openDocument } from "../support/app";

describe("Open", () => {
  it("opens the canned PDF and renders page 1", async () => {
    const fixture = writePdfFixture("open-basic.pdf", await createTextPdf("WebDriver open canary"));
    setDialogControl({ open_pdf_dialog: fixture });

    await openDocument();
  });
});
