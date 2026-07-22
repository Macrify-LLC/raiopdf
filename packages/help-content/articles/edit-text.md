---
id: edit-text
title: Edit Text — change or replace text in a PDF
group: edit
summary: Change the real text in a typed PDF — find & replace across the whole document, or right-click a selection to replace exactly that text.
order: 15
---

# Edit Text — change or replace text in a PDF

**Experimental feature:** Enable Experimental features in Settings before using Edit Text.

Change the actual words in a PDF. RaioPDF rewrites the text in the document
itself — not a box drawn on top, the real text. There are two ways to use it:
find & replace across the whole document, or replace exactly the text you
select on the page.

## Why you'd use it

A wrong date slipped into a filing. A name is misspelled on every page. A
placeholder like "[CLIENT]" never got filled in. **Edit Text** fixes those
across the whole document at once, so you don't retype or re-export the file
from the program that made it.

It works on **typed (born-digital) PDFs** — documents that already have real,
selectable text. It is **not** for scanned documents (see *What to know*).

## Method 1 — Find & replace across the document

1. Open the PDF.
2. In the **Edit** tools, choose **Edit Text**.
3. Type the text to **Find** and the text to **Replace** it with. Turn on
   **Whole word** if you only want to match the word on its own (so "art"
   doesn't also change "start").
4. Click **Replace all**. This *queues* the change — nothing happens to the
   document yet. Queue as many find/replace pairs as you need.
5. Click **Review**. RaioPDF reads the document and shows you what it found:
   which pages change, before-and-after previews, and any warnings.
6. If it looks right, click **Apply**. If nothing matched, Apply stays off and
   RaioPDF tells you the document wasn't changed.
7. **Save.** RaioPDF leaves your original file untouched and asks for a new file
   name, so you keep both the original and the edited copy.

## Method 2 — Replace exactly the text you select

When you want to change one specific occurrence — not every match in the
document:

1. Select the text on the page with the normal pointer.
2. **Right-click the selection and choose "Replace text..."** — RaioPDF opens
   a focused replacement bar with your selection already captured and the
   cursor in the **Replace with** box.
3. Type the replacement and click **Review replacement**. RaioPDF immediately
   stages that exact occurrence and opens a focused review — there is no
   sidebar step and no **Replace all** action in this flow.
4. Confirm the selected page and before-and-after text, then click **Apply**.
   Only the exact text you selected changes — other occurrences of the same
   words are left alone.

Selection replacement works on **one page and one line at a time**. If the
right-click option is grayed out, the page has no reliable text layer (a scan),
another replacement is still queued or being prepared, or the document is too
large for in-app editing.

## What to know

- **Typed PDFs only — not scans.** A scanned document is a picture of a page,
  so there's no text to edit. RaioPDF turns the tool off for scanned documents
  rather than editing the hidden text layer and leaving the visible scan wrong.
- **The text doesn't reflow.** Replacing a long phrase with a short one (or the
  other way) does not re-wrap the paragraph. The words change; the layout
  around them stays put, so spacing can look tight or loose, and centered text
  can shift. Read the result before you rely on it.
- **Matching is exact and case-sensitive.** "Smith" and "smith" are different,
  and the find is literal text, not a search pattern.
- **Single distinctive words match best.** A multi-word phrase can be missed
  when the words are spaced apart on the page (common in justified text). If a
  phrase doesn't take, search for one unusual word from it instead.
- **Selection replacement is one page, one line.** A selection that spans pages
  or wraps across lines can't be replaced in one go — replace it line by line,
  or use find & replace. Right-to-left text isn't supported for selection
  replacement.
- **The whole document is rewritten when you apply.** Even a one-word change
  re-saves the entire file. Pages you didn't preview may shift very slightly.
- **A substitute font may fill in.** If the document's font can't produce a
  character in your replacement, RaioPDF falls back to a built-in font, so a few
  characters can look a little different from the surrounding text.
- **Pictures are kept as-is.** On a document that mixes text and images, the
  images are carried over exactly — byte for byte — so editing text never
  re-compresses or degrades them.
- **It can invalidate a digital signature.** If the document is digitally
  signed, changing its text breaks that signature. RaioPDF warns you and only
  proceeds if you confirm.
- **It removes a PDF/A marking.** If the file is marked as PDF/A (an archival
  format), editing the text removes that marking. You can convert it to PDF/A
  again afterward.
- **Your original is protected for you.** Applying changes only the document
  open in RaioPDF; the file on your disk isn't touched until you save, and even
  then RaioPDF steers you to a new file rather than over the original.

## Related

- [Redact](tool:redact) — remove confidential text for good, not just replace it
- [Make Searchable (OCR)](tool:make-searchable) — add real text to a scan so it can be searched
- [Getting started](tool:getting-started) — the basics of moving around a document
