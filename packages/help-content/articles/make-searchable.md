---
id: make-searchable
title: Make Searchable (OCR)
group: comment-ocr
summary: Turn a scanned PDF into one you can search and select text in — entirely on your computer.
order: 10
---

# Make Searchable (OCR)

A scanned document is really just a picture of a page. You can see the words, but
the computer can't — so you can't search it or select its text. **Make
Searchable** fixes that with OCR (optical character recognition — the computer
reading the text in the image) and adds an invisible text layer, all on your own
machine.

## How to do it

1. Open the scanned PDF.
2. Click **Make Searchable (OCR)** in the Tools panel.
3. Wait while it works — you'll see it move through **Starting**,
   **Processing**, and **Verifying**.
4. When it says **Searchable — verified**, use **Save** (or **Save As**) to keep
   the searchable version.

## What to know

- **It runs on your computer.** The text recognition happens locally, with a
  built-in toolchain. Your pages are never uploaded.
- **The page looks the same.** OCR adds a hidden text layer behind the image — it
  doesn't alter how the document looks. Afterward you can search it and select
  text.
- **It checks its own work.** RaioPDF confirms a real, readable text layer was
  actually added. If OCR comes up empty, it leaves your document unchanged and
  tells you, rather than handing you a file that isn't really searchable.
- **You only need it for scans.** A PDF that already has real text is searchable
  as-is.

## Related

- [2.425 Scanner](tool:scanner-2425) — after OCR, scan for sensitive information
- [Your data never leaves your computer](tool:data-stays-local) — why OCR is offline
