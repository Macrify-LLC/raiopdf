// Synthetic multi-hundred-MB PDF generator for the streamed-open smoke/canary
// scenario (large-pdf-handling plan, test plan section).
//
// The REAL canary fixtures (283 MB appendix / 59 MB agenda) are sensitive
// client documents that live only in gitignored `fixtures.local/` dirs. When
// they are absent, this script builds a stand-in with the same shape: many
// pages, each carrying ~1 MB of incompressible image data (random DeviceGray
// noise) plus a unique searchable text marker ("MARKER-<page>"), so streamed
// open, lazy page rendering, and windowed search are all exercisable.
//
//   node smoke/generate-large-fixture.mjs [pages] [outPath]
//
// Defaults: 270 pages (~283 MB) → smoke/fixtures.local/synthetic-large.pdf
// (kept out of git alongside the real canary fixtures).

import { randomFillSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE_WIDTH = 1024;
const IMAGE_HEIGHT = 1024; // 1 MiB of raw 8-bit gray per page.

export function buildSyntheticLargePdf(pageCount) {
  const chunks = [];
  const offsets = [0]; // object number → byte offset (index 0 unused)
  let position = 0;

  const push = (chunk) => {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk, "latin1") : chunk;
    chunks.push(buffer);
    position += buffer.length;
  };
  const beginObject = () => {
    offsets.push(position);
  };

  push("%PDF-1.7\n%âãÏÓ\n");

  // Object numbering: 1 catalog, 2 pages, 3 font, then per page i (0-based):
  // page object 4+3i, content 5+3i, image 6+3i.
  const pageObjectNumber = (index) => 4 + index * 3;
  const totalObjects = 3 + pageCount * 3;

  beginObject();
  push("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");

  beginObject();
  const kids = Array.from({ length: pageCount }, (_, index) => `${pageObjectNumber(index)} 0 R`);
  push(`2 0 obj\n<< /Type /Pages /Count ${pageCount} /Kids [ ${kids.join(" ")} ] >>\nendobj\n`);

  beginObject();
  push("3 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");

  for (let index = 0; index < pageCount; index += 1) {
    const pageNumber = pageObjectNumber(index);
    const contentNumber = pageNumber + 1;
    const imageNumber = pageNumber + 2;

    beginObject();
    push(
      `${pageNumber} 0 obj\n` +
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 3 0 R >> /XObject << /Im0 ${imageNumber} 0 R >> >> ` +
        `/Contents ${contentNumber} 0 R >>\nendobj\n`,
    );

    const content =
      `q 468 0 0 648 72 72 cm /Im0 Do Q\n` +
      `BT /F1 18 Tf 72 744 Td (MARKER-${index + 1} synthetic large fixture page ${index + 1} of ${pageCount}) Tj ET\n`;
    beginObject();
    push(`${contentNumber} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}endstream\nendobj\n`);

    const pixels = Buffer.allocUnsafe(IMAGE_WIDTH * IMAGE_HEIGHT);
    randomFillSync(pixels);
    beginObject();
    push(
      `${imageNumber} 0 obj\n` +
        `<< /Type /XObject /Subtype /Image /Width ${IMAGE_WIDTH} /Height ${IMAGE_HEIGHT} ` +
        `/ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n`,
    );
    push(pixels);
    push("\nendstream\nendobj\n");
  }

  const xrefOffset = position;
  let xref = `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`;
  for (let objectNumber = 1; objectNumber <= totalObjects; objectNumber += 1) {
    xref += `${String(offsets[objectNumber]).padStart(10, "0")} 00000 n \n`;
  }
  push(xref);
  push(
    `trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
  );

  return Buffer.concat(chunks);
}

const isDirectRun = process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const pageCount = Number(process.argv[2] ?? 270);
  const outPath = process.argv[3] ??
    path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures.local", "synthetic-large.pdf");

  mkdirSync(path.dirname(outPath), { recursive: true });
  const started = Date.now();
  const pdf = buildSyntheticLargePdf(pageCount);
  writeFileSync(outPath, pdf);
  process.stdout.write(
    `wrote ${outPath} — ${pageCount} pages, ${(pdf.length / (1024 * 1024)).toFixed(1)} MB in ${Date.now() - started} ms\n`,
  );
}
