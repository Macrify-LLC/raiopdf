// Regenerate the deterministic eval fixtures: node eval/make-fixtures.mjs
import { PDFDocument, StandardFonts } from "pdf-lib";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const outDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

async function make(name, pages, widthIn, heightIn) {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i += 1) {
    pdf.addPage([widthIn * 72, heightIn * 72]).drawText(`Page ${i + 1} of ${name}`, {
      x: 20,
      y: 40,
      size: 10,
      font,
    });
  }
  writeFileSync(path.join(outDir, name), await pdf.save());
  console.log("wrote", name);
}

await make("three-pages.pdf", 3, 8.5, 11);
await make("five-pages.pdf", 5, 8.5, 11);
await make("letter-portrait.pdf", 1, 8.5, 11);
await make("legal-size.pdf", 2, 8.5, 14);
