# RaioPDF

**A free, fully-local desktop PDF suite for law firms.**

RaioPDF replaces the core day-to-day functionality of Adobe Acrobat — viewing, organizing, OCR, annotation — and adds the legal workflows Acrobat never bothered with: one-click e-filing prep, exhibit binder assembly, Bates numbering, and true verified redaction. Built Florida-first, useful anywhere.

**Your files never leave your computer.** No cloud, no account, no telemetry, no AI, no upsell. Every operation — including OCR — runs locally on your machine. Download it, install it, use it. That's the whole deal.

RaioPDF is published as a public service to the legal community by [Macrify LLC](https://macrify.me).

## Status

**Pre-alpha — under active development.** Nothing to download yet. Watch this repo for the first release.

## Planned features

### Core
- View, search, and print PDFs
- Organize pages: merge, split, reorder, extract, insert, rotate, crop
- **Make Searchable** — fully offline OCR for scanned documents
- Annotate: highlight, comment, draw, stamp
- Add text and images; fill forms; signature stamp + flatten
- Compress, passwords/permissions
- No watermarks, no nags, ever

### Legal
- **Prepare for Filing** — one click: normalizes every page to letter-size portrait, and if the file exceeds the e-portal size limit, splits it into properly-labeled sequential parts exported as PDF/A
- **Combine with Exhibits** — assemble a motion/brief with exhibit files in order, auto-stamped ("Exhibit A" — configurable) and auto-bookmarked
- **True redaction** — content actually removed and verified by re-extraction, not black boxes
- **Bates numbering** across document sets
- **Sensitive-info scanner** — assistive detection of SSNs and account numbers per Fla. R. Jud. Admin. 2.425
- **Metadata scrubbing** before production or filing
- e-filing preflight report with rule citations (Fla. R. Jud. Admin. 2.520/2.525)

## Architecture (short version)

A [Tauri](https://tauri.app) desktop shell with a custom, Acrobat-familiar UI, running the MIT-licensed [Stirling-PDF](https://github.com/Stirling-Tools/Stirling-PDF) backend engine as a bundled localhost sidecar (no Docker, no Java setup — it's all inside the installer), with a bundled Tesseract/Ghostscript/OCRmyPDF toolchain for fully offline OCR. Windows first; macOS later.

## License

RaioPDF is licensed under [GPL-3.0](LICENSE). It bundles third-party components under their own licenses (MIT Stirling-PDF engine, Apache-2.0 Tesseract and PDF.js, AGPL Ghostscript, and others) — see `licenses/` (forthcoming) for full third-party notices.

## Support

- Bugs and feature requests: [GitHub Issues](https://github.com/Macrify-LLC/raiopdf/issues)
- Email: support@macrify.me (best effort — this is free, community-supported software)

---

Built by [Macrify](https://macrify.me) for the legal community.
