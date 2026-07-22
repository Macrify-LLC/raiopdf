/**
 * Shared WebDriver helpers: app readiness and the small set of UI drivers the
 * specs reuse. These lean on stable accessibility hooks (`aria-label`, `role`,
 * `data-testid`) rather than brittle geometry.
 */

/**
 * The app is booted once the always-present command-bar "Open" button shows.
 * Each spec file is its own session (a fresh app launch), so waiting for this
 * per test is enough — no webview reload between flows is needed.
 */
export async function waitForAppReady(): Promise<void> {
  await $('[aria-label="Open"]').waitForDisplayed({ timeout: 60_000 });
}

/** A document is open once page 1 and its canvas are on screen. */
export async function waitForDocumentOpen(): Promise<void> {
  await $('[aria-label="Page 1"]').waitForDisplayed({ timeout: 60_000 });
  await $('[data-testid="pdf-page-canvas"]').waitForDisplayed({ timeout: 60_000 });
}

/** Click the command-bar Open button — invokes `open_pdf_dialog` for real. */
export async function clickOpen(): Promise<void> {
  await $('[aria-label="Open"]').click();
}

/** Open a document via the stubbed picker and wait for it to render. */
export async function openDocument(): Promise<void> {
  await clickOpen();
  await waitForDocumentOpen();
}

/** Open the app menu and pick an item, e.g. `openMenu("File", "Save As...")`. */
export async function openMenu(menu: string, item: string): Promise<void> {
  await $(`//button[@role="menuitem" and normalize-space(.)=${xpathLiteral(menu)}]`).click();
  await $(
    `//div[@role="menu" and @aria-label=${xpathLiteral(menu)}]` +
      `//button[@role="menuitem" and normalize-space(.)=${xpathLiteral(item)}]`,
  ).click();
}

/** Locate a FloatingDialog by its visible title (the h2 it is labelled by). */
export function dialogByTitle(title: string): ReturnType<typeof $> {
  return $(`//div[@role="dialog"][.//h2[normalize-space(.)=${xpathLiteral(title)}]]`);
}

/** Assert a titled dialog fully closed — the "no stuck / focus-trapped modal" check. */
export async function expectDialogClosed(title: string): Promise<void> {
  await dialogByTitle(title).waitForExist({ reverse: true, timeout: 20_000 });
}

/**
 * Wrap `value` as an XPath string literal. Double-quote by default; fall back to
 * single-quote for the rare value that contains a double quote. (Titles here are
 * quote-free; a value containing both quote kinds is not expected.)
 */
export function xpathLiteral(value: string): string {
  return value.includes('"') ? `'${value}'` : `"${value}"`;
}
