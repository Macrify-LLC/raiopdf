---
id: pdf-to-word
title: PDF -> Word
group: organize
summary: Convert one PDF into an editable Word document.
order: 25
---

# PDF -> Word

PDF -> Word creates a `.docx` copy from a PDF. It uses Microsoft Word to do the
conversion, so Word must be installed.

## How to do it

1. In the **Organize** tools, choose **PDF -> Word**.
2. Pick one PDF.
3. If the PDF looks scanned, choose whether to run OCR first.
4. Save the generated Word document.

## What to know

- **Experimental — formatting may be approximate.** Read the Word file before
  relying on it.
- **Microsoft Word is required.** If Word is not available, RaioPDF explains
  that at the point of action and does not convert the file.
- **On a Mac, allow Automation if asked.** The first use may ask to let
  RaioPDF control Microsoft Word. If you deny that request, macOS does not show
  it again when you retry. Open **System Settings > Privacy & Security >
  Automation**, allow RaioPDF to control Microsoft Word, then retry.
- **Word must be current and licensed.** Update Word if RaioPDF says its
  version is unsupported. If Word asks you to sign in or activate, finish that
  in Word before retrying.
- **OCR is offered only for scans.** PDFs that already have a searchable text
  layer convert directly.

## Related

- [Make Searchable (OCR)](tool:make-searchable) — add real text to a scan first
- [Import Word Document](tool:import-word) — turn a `.docx` into a PDF
- [Organize Pages](tool:pages)
