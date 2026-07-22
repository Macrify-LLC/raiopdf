/**
 * Unlock flow: opening a real open-password PDF (minted with the bundled qpdf)
 * routes through `open_pdf_dialog` (stubbed path), the app detects encryption and
 * shows the in-app "Unlock PDF" PasswordDialog. Submitting the password runs the
 * real qpdf decrypt path-op and opens an unlocked working copy. The assertion is
 * that the document opens and the modal closes (not focus-trapped).
 */
import { setDialogControl } from "../support/dialogControl";
import { createEncryptedPdfFixture } from "../support/fixtures";
import { clickOpen, dialogByTitle, expectDialogClosed, waitForDocumentOpen } from "../support/app";

const UNLOCK_TITLE = "Unlock PDF";
const PASSWORD = "raiopdf-e2e";

describe("Unlock PDF", () => {
  it("prompts for the open password and unlocks the document", async () => {
    const encrypted = await createEncryptedPdfFixture("unlock-sealed.pdf", PASSWORD);
    setDialogControl({ open_pdf_dialog: encrypted });

    await clickOpen();

    const dialog = dialogByTitle(UNLOCK_TITLE);
    await dialog.waitForDisplayed({ timeout: 30_000 });

    await dialog.$('input[type="password"]').setValue(PASSWORD);
    await dialog.$(".password-dialog__primary-button").click();

    await waitForDocumentOpen();
    await expectDialogClosed(UNLOCK_TITLE);
  });
});
