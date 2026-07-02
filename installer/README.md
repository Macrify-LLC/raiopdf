# Installer Payload

Release builds MUST run `installer/assemble-payload.sh` before `tauri build`.

CI enforces this by running `installer/assemble-payload.sh --verify`, which fails unless the Windows payload contains the bundled JRE, engine jar, OCRmyPDF Python runtime, generated Python third-party notices, Tesseract, tessdata, and Ghostscript markers.
