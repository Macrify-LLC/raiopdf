# Third-Party Notices

This file summarizes third-party components bundled with the RaioPDF Windows engine payload.
Release builds generate the comprehensive installed notice set under `payload/legal/`,
including `THIRD-PARTY-NOTICES.txt`, `COMPONENT-MANIFEST.json`,
`RELEASE-SOURCE-CORRESPONDENCE.md`, license texts, and the Ghostscript source offer.

## Eclipse Temurin JRE 25

- Component: Eclipse Temurin JRE 25, Windows x64
- License: GPL-2.0-only with Classpath Exception
- Source: https://adoptium.net/temurin/
- Use: Bundled Java runtime for the Stirling-PDF sidecar.

## Stirling-PDF Core

- Component: Stirling-PDF core flavor
- License: MIT for the bundled core build
- Source: https://github.com/Stirling-Tools/Stirling-PDF
- Use: Local PDF processing engine. Proprietary and SaaS source trees are scrubbed before build.

## Tesseract OCR

- Component: UB-Mannheim Tesseract OCR Windows build
- License: Apache-2.0
- Source: https://github.com/UB-Mannheim/tesseract
- Use: OCR text recognition binary and runtime libraries.

## Tesseract tessdata_fast

- Component: `eng.traineddata` from `tessdata_fast`
- License: Apache-2.0
- Source: https://github.com/tesseract-ocr/tessdata_fast
- Use: English OCR language data.

## Ghostscript

- Component: Ghostscript Windows x64
- License: AGPL-3.0-only
- Binary source: https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs10071/gs10071w64.exe
- Corresponding source: https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs10071/ghostscript-10.07.1.tar.xz
- Use: Ghostscript command-line tools required by OCRmyPDF and Stirling PDF/A flows.
- Packaging note: Ghostscript is bundled unmodified. `installer/assemble-payload.sh`
  copies upstream `gswin64c.exe` to `gs.exe` as a byte-identical convenience alias,
  and `scripts/generate-legal-notices.mjs --check` verifies that alias.
- Aggregation note: Ghostscript is bundled as a separate executable toolchain
  component and invoked as an external process by OCR/PDF workflows.

## qpdf

- Component: qpdf Windows x64
- License: Apache-2.0
- Source: https://github.com/qpdf/qpdf
- Use: qpdf command-line tool required by Stirling-PDF repair and other structure-preserving PDF workflows.
- License text: bundled at `payload/ocr/qpdf/LICENSE.txt` by `installer/assemble-payload.sh` from the upstream qpdf distribution.

## Python

- Component: Python embeddable package for Windows x86-64
- License: Python Software Foundation License
- Source: https://www.python.org/downloads/windows/
- Use: Embedded Python runtime for OCRmyPDF.

## OCRmyPDF

- Component: OCRmyPDF and pinned Python wheel dependencies
- License: MPL-2.0 for OCRmyPDF; transitive dependencies carry their own upstream licenses
- Source: https://github.com/ocrmypdf/OCRmyPDF
- Use: Searchable PDF OCR pipeline invoked by Stirling-PDF.
- Python dependency notices: generated at `payload/ocr/THIRD-PARTY-PYTHON.md` by `installer/assemble-payload.sh` from each installed wheel's `*.dist-info/METADATA`.
