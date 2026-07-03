---
id: redact
title: Redact — remove text for good
group: legal
summary: Permanently take confidential text out of a PDF, so it's gone — not just hidden behind a black box.
order: 40
---

# Redact — remove text for good

Redaction removes confidential text from a document for good: Social Security
numbers, a client's name, a privileged paragraph, a bank account. When you're
done, the words aren't hidden — they're **gone**.

## Why this matters

A common and costly mistake is drawing a black box over text and assuming it's
gone. It isn't — the box is just a graphic sitting on top, and the words are
still underneath, where anyone can copy them out or find them in a search.
That's how confidential information ends up in a public filing. Real redaction
removes the text itself.

RaioPDF's **Redact** tool removes it, then double-checks its own work.

## How to do it

1. Open the PDF.
2. In the **Legal** tools, choose **Redact**.
3. Drag a box over each thing you want removed. Add as many boxes as you need.
4. Click **Apply Redactions**. RaioPDF tells you how many areas will be
   permanently removed — confirm, and it removes them and checks its work.
5. **Save** the file — or use **Save As** to write the redacted version to a new
   file and keep your original untouched.

Applying redactions changes the document you have open. Nothing is written to
disk until you save, so you decide whether to replace the original or keep both.

## What "verified" means

After it removes the text, RaioPDF re-reads the whole document to make sure the
words can't be pulled back out. It also checks the redacted pages' images, any
hidden notes attached to those pages, and the file's hidden info (the details a
PDF quietly carries about how it was made). If anything you redacted still shows
up, RaioPDF tells you instead of pretending it worked.

When you see **Verified**, the content is actually gone.

## What to know

- **Your original is safe until you save.** Applying redactions changes the
  document you have open, not the file on your disk. To keep the unredacted original, use
  **Save As** and give the redacted version a new name — then you have both.
- **The removed text is gone for good.** Once you save the redacted version,
  the words are deleted from that file, not hidden. There's no recovering them
  from it later — which is exactly what you want in a document you're producing.
- **If it can't be verified, nothing changes.** If RaioPDF can't confirm the
  text is truly gone, it leaves your document exactly as it was and tells you
  what failed — it won't hand you a file it isn't sure about.
- **Catch what you missed first.** Run the **2.425 Scanner** before you file to
  flag Social Security and account numbers you might have overlooked.

## Related

- [2.425 Scanner](tool:scanner-2425) — find sensitive numbers before you file
- [Scrub Metadata](tool:scrub-metadata) — remove the hidden info a file carries
- [Prepare for Filing](tool:prepare-for-filing) — get the file ready for the portal
