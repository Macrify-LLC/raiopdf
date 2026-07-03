---
id: scanner-2425
title: 2.425 Scanner
group: legal
summary: Scan a document for sensitive personal information — Social Security and account numbers, and the like — before you file.
order: 30
---

# 2.425 Scanner

Courts require you to keep certain personal information out of public filings.
The 2.425 Scanner — named for a court rule on protecting that information — reads
through a document and flags likely sensitive data so you can catch it before it
goes out.

## What it looks for

- Social Security numbers
- Bank and financial account numbers
- Credit and debit card numbers
- Driver's license numbers
- Dates of birth

When it lists a possible match, it masks it — showing only the last few
characters — so the scan results don't themselves expose the information.

## How to do it

1. Open the document.
2. In the **Legal** tools, choose **2.425 Scanner**.
3. Click **Scan Document**.
4. Review the list. Each item shows what kind of data it is and the page it's on.
5. Click **Mark for redaction** on anything that should come out. That switches
   you to **Redact** with the area already marked, ready to confirm.

## What to know

- **This is a helper, not the final word.** The scanner points you at likely
  matches — it can miss things and it can flag things that are fine. Always read
  the document yourself before you rely on it. It never removes anything on its
  own.
- **It reads text.** The scanner works on text it can pull from the document. If
  your PDF is a scan (a picture of a page), run **Make Searchable** first so
  there's text to read.

## Related

- [Redact](tool:redact) — remove what the scanner finds
- [Make Searchable (OCR)](tool:make-searchable) — add a text layer to a scanned PDF first
