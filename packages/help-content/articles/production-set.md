---
id: production-set
title: Production Set
group: legal
summary: Build a Bates-numbered discovery production from a set of documents, with confidentiality designations and an index.
order: 55
---

# Production Set

Production Set builds a discovery production from a set of documents. It puts them
in the order you choose, stamps sequential Bates numbers across the whole set,
adds confidentiality designations where you need them, and writes an index — all
into one organized package.

## Why you'd use it

Producing documents means every page numbered in sequence, the right
confidentiality stamps, and an index the other side can follow. Assembling that
by hand across many files is slow and easy to get wrong. This does it in one pass
— and it remembers where your numbering left off, so your next production doesn't
reuse numbers.

## How to do it

1. In the **Legal** tools, choose **Production Set**.
2. Click **Add PDF** for each document, and use the up and down arrows to put them
   in production order.
3. For any document, set a **Designation** — none, **Confidential**,
   **Confidential - Attorneys' Eyes Only**, or your own custom text.
4. Set the Bates format: a **Prefix**, a **Start** number, and how many **Digits**.
5. Choose an empty **Package root folder**, pick any extras (below), and click
   **Build Production**.

## The options

- **Production index PDF and CSV** — a table of what's in the production, as both a
  PDF and a spreadsheet file.
- **Filename column in index** — include each document's filename in that index.
- **Combined production PDF** — also produce a single merged PDF of the whole set.
- **Volume folders** — split the production into volumes under a size you set.

## What to know

- **It picks up where you left off.** For a given prefix, Production Set remembers
  the last number used and starts the next run after it.
- **Give yourself enough digits.** If the last page's number wouldn't fit the
  digits you chose, it stops and asks you to raise the digit width or lower the
  start number.
- **It writes to a new folder.** Choose an empty package folder; your source files
  aren't changed.

## Related

- [Bates Numbering](tool:bates-numbering) — number a single document
- [Batch Cleanup](tool:batch-cleanup) — clean the files before you produce them
- [Redact](tool:redact) — remove privileged content before production
