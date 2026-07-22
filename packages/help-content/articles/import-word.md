---
id: import-word
title: Import Word Document
group: organize
summary: Convert a Word document into a PDF on your computer, then open it in RaioPDF.
order: 26
---

# Import Word Document

Import Word Document turns a `.docx` file into a PDF and opens that PDF in
RaioPDF. It uses your installed copy of Microsoft Word, so the conversion stays
on your computer.

## How to do it

1. Choose **File > Import Word Document (.docx, experimental)**.
2. Pick the Word document.
3. If RaioPDF finds tracked changes or comments, choose whether the PDF should
   show markup or the final version.
4. RaioPDF opens the converted PDF as a new document. Save it where you want to
   keep it.

## Adding several Word documents

Where an add-file picker accepts Word documents, you can select `.docx` files
alongside PDFs. RaioPDF converts the Word documents one at a time and shows
their progress. A tracked-changes choice applies to the Word documents in that
pick.

## What to know

- **Experimental — check the PDF before relying on it.** Complex Word layouts,
  fonts, comments, and tracked changes can look different after conversion.
- **Microsoft Word is required.** Word must be installed, signed in, and
  licensed. If RaioPDF says Word needs an update, install a supported version
  before trying again.
- **On a Mac, allow Automation if asked.** The first use may ask to let
  RaioPDF control Microsoft Word. If you deny that request, macOS does not show
  it again when you retry. Open **System Settings > Privacy & Security >
  Automation**, allow RaioPDF to control Microsoft Word, then retry.
- **Word is visible on a Mac.** Word may launch and briefly show RaioPDF's
  private conversion copy. A batch reuses the same Word session. RaioPDF does
  not close or save documents you already had open.
- **Your original Word file is not changed.** RaioPDF creates a separate PDF;
  it does not save over the `.docx` file.

## Related

- [PDF -> Word](tool:pdf-to-word) — create an editable Word copy from a PDF
- [Combine with Exhibits](tool:combine-exhibits) — add converted documents to a binder
