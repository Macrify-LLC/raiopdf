---
id: sanitize
title: Sanitize
group: legal
summary: Strip hidden active content — embedded scripts, attached files, and links — from a PDF.
order: 70
---

# Sanitize

A PDF can carry more than the pages you see: little embedded programs, other
files tucked inside it, and clickable links. Most of the time that's harmless,
but before you send a document out you may want it stripped down to just the
document. **Sanitize** does that.

## What it removes

- **Embedded scripts** — small programs a PDF can carry and run.
- **Embedded files** — other files attached inside the PDF.
- **Links** — clickable web and document links.

## How to do it

1. Open the document.
2. In the **Legal** tools, choose **Sanitize...**.
3. Click **Sanitize PDF**.

RaioPDF tells you what it removed.

## What to know

- **It doesn't change the pages you see.** Sanitize takes out the hidden extras,
  not the visible content.
- **Save to keep the result.** The change applies to the document you have open;
  use **Save** (or **Save As** for a copy) to write it out.
- **If something's still open in the app,** and the document changes underneath
  it, RaioPDF stops rather than finishing on the wrong version — and tells you.

## Related

- [Scrub Metadata](tool:scrub-metadata) — remove the hidden info about who made the file
- [Redact](tool:redact) — remove sensitive text from the pages
