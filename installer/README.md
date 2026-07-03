# Installer Payload

Release builds MUST build the MCP workspace output, then run `installer/assemble-payload.sh` before `tauri build`. `pnpm build:shell` handles that sequence.

CI enforces this by running `installer/assemble-payload.sh --verify`, which fails unless the Windows payload contains the bundled JRE, engine jar, pinned Node runtime, bundled MCP entrypoint, pdf.js assets, OCRmyPDF Python runtime, generated Python third-party notices, Tesseract, tessdata, and Ghostscript markers.
