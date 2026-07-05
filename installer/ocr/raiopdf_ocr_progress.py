"""RaioPDF OCRmyPDF wrapper with a tiny progress protocol.

This wrapper intentionally owns the progress contract instead of scraping
OCRmyPDF's human logs. The companion plugin writes prefixed NDJSON records to
stderr; Rust forwards only those records to the WebView.
"""

from __future__ import annotations

import argparse
from pathlib import Path
import sys

from ocrmypdf import ocr


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run OCRmyPDF with RaioPDF progress output.")
    parser.add_argument("--mode", choices=("skip", "force"), default="skip")
    parser.add_argument("--output-type", default="pdf")
    parser.add_argument("--language", action="append", dest="languages")
    parser.add_argument("--pdf-renderer", default=None)
    parser.add_argument("--deskew", action="store_true")
    parser.add_argument("input_pdf")
    parser.add_argument("output_pdf")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    plugin = Path(__file__).with_name("raiopdf_ocr_progress_plugin.py")
    try:
        result = ocr(
            args.input_pdf,
            args.output_pdf,
            language=args.languages or ["eng"],
            output_type=args.output_type,
            mode=args.mode,
            pdf_renderer=args.pdf_renderer,
            deskew=args.deskew,
            progress_bar=True,
            plugins=[plugin],
        )
    except Exception as error:  # noqa: BLE001 - this is a subprocess boundary.
        print(f"RaioPDF OCR failed: {error}", file=sys.stderr, flush=True)
        return 1

    return int(result)


if __name__ == "__main__":
    raise SystemExit(main())
