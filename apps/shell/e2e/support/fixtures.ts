/**
 * Fixture PDFs for the WebDriver dialog suite, written to disk so the native
 * dialog stub can hand their ABSOLUTE paths to the real shell commands.
 *
 * The plain-PDF generators mirror the ones in
 * `apps/ui/smoke/real-engine/helpers.ts` (kept as thin pdf-lib wrappers here so
 * this suite doesn't pull in the Playwright-flavored helper module). The
 * encrypted fixture is minted with the bundled qpdf — pdf-lib has no encrypt
 * API — so the Unlock flow drives a genuine open-password document.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { fixturesDir, payloadQpdf } from "./paths";

/** Write `bytes` into the fixtures dir and return the absolute path. */
export function writePdfFixture(name: string, bytes: Uint8Array): string {
  mkdirSync(fixturesDir, { recursive: true });
  const filePath = path.join(fixturesDir, name);
  writeFileSync(filePath, Buffer.from(bytes));
  return filePath;
}

/** A small, single-page text PDF — the default "open something" fixture. */
export async function createTextPdf(text: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([200, 300]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 24, y: 240, size: 12, font });
  return pdf.save();
}

/** A simple multi-page PDF with the given page widths (portrait, 300 tall). */
export async function createPdf(pageWidths: readonly number[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  for (const width of pageWidths) {
    pdf.addPage([width, 300]);
  }
  return pdf.save();
}

/**
 * A dense landscape multi-page PDF — landscape trips the filing "letter
 * portrait" normalization, and the dense text makes each page's content stream
 * large so a padded copy splits into several portal-compliant parts.
 */
export async function createHeavyLandscapePdf(pages: number): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let p = 0; p < pages; p += 1) {
    const page = pdf.addPage([792, 612]);
    for (let line = 0; line < 34; line += 1) {
      page.drawText(
        `Page ${p + 1} line ${line + 1}: Motion for summary judgment and certificate of service.`,
        { x: 40, y: 560 - line * 16, size: 10, font },
      );
    }
  }
  return pdf.save();
}

/**
 * Mint an open-password ("user password") encrypted PDF via the bundled qpdf,
 * returning its absolute path. Opening this fixture must trigger the in-app
 * "Unlock PDF" PasswordDialog. AES-256; the user and owner passwords are the
 * same so a single password both opens and fully unlocks it.
 */
export async function createEncryptedPdfFixture(
  name: string,
  password: string,
  sourceText = "Sealed exhibit — open password required.",
): Promise<string> {
  if (!existsSync(payloadQpdf)) {
    throw new Error(
      `qpdf not found at ${payloadQpdf}. Run \`pnpm prepare:shell-bundle:windows-x64\` (or set ` +
        "RAIO_E2E_PAYLOAD_DIR) so the Unlock fixture can be encrypted.",
    );
  }
  const plain = writePdfFixture(`${name}.plain.pdf`, await createTextPdf(sourceText));
  const encrypted = path.join(fixturesDir, name);
  // qpdf --encrypt <user> <owner> 256 -- in.pdf out.pdf
  execFileSync(
    payloadQpdf,
    ["--encrypt", password, password, "256", "--", plain, encrypted],
    { stdio: "pipe" },
  );
  return encrypted;
}
