#!/usr/bin/env python3
"""Build stable PDF fixtures for PDF->DOCX reflow tests."""

from pathlib import Path


ROOT = Path(__file__).resolve().parent


def pdf_object(number: int, body: bytes) -> bytes:
    return b"%d 0 obj\n" % number + body + b"\nendobj\n"


def build_pdf(path: Path, content: bytes) -> None:
    objects = [
        pdf_object(1, b"<< /Type /Catalog /Pages 2 0 R >>"),
        pdf_object(2, b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>"),
        pdf_object(
            3,
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            b"/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
        ),
        pdf_object(4, b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"),
        pdf_object(
            5,
            b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream",
        ),
    ]

    output = bytearray(b"%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")
    offsets = [0]
    for item in objects:
        offsets.append(len(output))
        output.extend(item)
    xref = len(output)
    output.extend(b"xref\n0 %d\n" % (len(objects) + 1))
    output.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        output.extend(b"%010d 00000 n \n" % offset)
    output.extend(
        b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n"
        % (len(objects) + 1, xref)
    )
    path.write_bytes(bytes(output))


def main() -> None:
    build_pdf(
        ROOT / "text-layer.pdf",
        b"BT /F1 18 Tf 72 720 Td (RaioPDF reflow text fixture) Tj ET",
    )
    build_pdf(
        ROOT / "image-only.pdf",
        b"0.95 g 72 640 240 96 re f 0.1 g 100 684 180 18 re f",
    )


if __name__ == "__main__":
    main()
