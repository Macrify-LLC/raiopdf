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
2. Click **Add PDF** and select one or more documents (add again for more), or
   click **Add Folder** to take every PDF in a folder at once — it tells you what
   it found, lets you leave subfolders out, and adds nothing until you say yes.
   Then use the up and down arrows to put them in production order.
3. For any document, set a **Designation** — none, **Confidential**,
   **Confidential - Attorneys' Eyes Only**, or your own custom text. Once a
   designation is set, its **Pages** field lets you restrict it to part of that
   document — see "Restricting a designation to certain pages" below.
4. Set the Bates format: a **Prefix**, a **Start** number, and how many **Digits**.
5. Choose an empty **Package root folder**, pick any extras (below), and click
   **Build Production**.

## The options

- **Production index PDF and CSV** — a table of what's in the production, as both a
  PDF and a spreadsheet file.
- **Filename column in index** — include each document's filename in that index.
- **Combined production PDF** — also produce a single merged PDF of the whole set.
- **Volume folders** — split the production into volumes under a size you set.
- **Litigation load file (DAT)** — see "Load file" below.

## Load file

Check **Litigation load file (DAT)** and RaioPDF writes a `production.dat`
file into the package alongside the index — a standard format that most
review platforms (Relativity and others that accept a Concordance-style
load file) can read to import the whole production in one step, with the
Bates range, confidentiality designation, page count, and file location for
every document already filled in.

- It only lists documents that were actually produced — a combined PDF, a
  duplicate you chose to skip, or a document you withheld never appears in it.
- If **Filename column in index** is off, the load file's filename field
  stays blank too, matching the index.
- This version doesn't include a separate image-level cross-reference file
  some platforms also accept (an "OPT" file) — RaioPDF's production PDFs
  aren't split into individual page images yet, which that format requires.
  The full technical notes are in this project's repository, in
  `docs/PRODUCTION-SETS.md`, if you or your vendor want the specifics.

## Restricting a designation to certain pages

By default, a document's designation covers every page. Once you've chosen a
designation for a document, its **Pages** field (placeholder **all**) lets you
stamp it on only part of that document instead — enter a page range like
`1-3,7` (page numbers, 1-based, commas and hyphens, in any order). Bates
numbers still cover every page regardless; only the designation is affected.

- If RaioPDF already knows the document's page count, an out-of-range or
  malformed range (e.g. a page past the end, or `5-2` backwards) is flagged
  right there in the list, and **Build Production** stays disabled until it's
  fixed.
- For a very large document RaioPDF hasn't counted yet, the field shows a note
  that it'll be checked once you build instead of guessing — the build itself
  always verifies the range against the real page count before writing
  anything.
- The range you typed is recorded in the production's index and manifest, so
  the other side (and future-you) can see exactly which pages carried the
  designation.

## Stamp placement

Open **Stamp placement** (in the Bates numbering section) to change where the
Bates number and the designation land on the page — pick from six positions
(header or footer, crossed with left, center, or right) for each, and set a
shared font size from 6 to 24 points. The defaults — Bates in the footer at
the right, the designation in the header, centered — are unchanged from
before this existed.

Bates numbers and the designation can't be set to the same page edge; put one
in the header and the other in the footer. RaioPDF also refuses to build a
production if your chosen text and font size wouldn't fit legibly (at least
6pt once fully rendered) on the narrowest page in the set — pick a smaller
font, shorter text, or a different placement, and try again.

## Duplicate documents

If two or more files in your production order have identical content, RaioPDF
badges each one **duplicate** as you add them, and shows a line like "2 duplicate
files in this production." You choose what happens to them:

- **Produce all (cross-referenced)** — the default. Every copy is Bates-stamped
  and produced with its own range, just like any other document. Nothing is ever
  silently left out of a discovery production.
- **Produce once** — only the first copy (in your production order) is stamped
  and produced; later copies are skipped and use none of the Bates numbers they
  would otherwise have taken, so the sequence stays unbroken for the documents
  that follow.

Either way, the cross-reference between the duplicate copies is recorded in the
production's manifest for later review — it's never added as an extra column in
the production index, which only ever lists what was actually produced.

The badge you see while adding files is a quick heads-up, not the final word: the
build itself re-checks every file's content right before it writes anything, so
what actually gets produced is always correct even if a file changed after you
added it.

## Withholding documents and the draft privilege log

Every document in your production order has a **Status**, next to its
Designation:

- **Produce** — the default. Nothing changes.
- **Produce with redactions** — the document is still produced normally, in the
  same place as any other document. RaioPDF does **not** apply or verify any
  redaction as part of building a production — if the document needs content
  removed, do that first with the [Redact](tool:redact) tool, then add the
  already-redacted file here. This status only tells RaioPDF to log the document
  as redacted.
- **Withhold** — the document is left out of the production entirely. It's never
  Bates-stamped, never copied into the upload folder, never listed in the
  production index or the load file, and it uses none of the Bates numbers, so
  the numbering stays unbroken for the documents around it.

Choosing **Withhold** or **Produce with redactions** reveals two more fields:

- **Privilege asserted** — the basis you're claiming, e.g. "Attorney-client
  privilege" or "Work product." **Required to withhold a document** — RaioPDF
  won't build the production until every withheld file has one. Optional (but
  worth filling in) for a redacted document.
- **Description** — a short free-text note about why. Always optional.

As soon as any file in the order has a non-Produce status, RaioPDF writes
`draft-privilege-log.csv` at the package root, alongside the production index,
and shows a warning that a draft privilege log will be written.

**This is a draft, not something you can file or serve as-is.** The log has a
row for every withheld document and every document produced with redactions,
with these columns: Row ID, Status, Privilege Asserted, Description, Filename,
Pages, Date, Doc Type, Author, and Recipients. **The last four columns —
Date, Doc Type, Author, Recipients — are always left blank.** RaioPDF doesn't
guess at them: a privilege log entry with a wrong autopopulated date or author
is worse than one with a blank you know to fill in yourself. Treat the whole
log the way you'd treat a Rule 26(b)(5)-style privilege log draft — review and
complete every row before it's ever used or shared. The **Filename column in
privilege log** option controls whether the Filename column is filled in or
left blank (the column itself always exists either way) — it's independent of
the production index's own filename option.

If two or more files in your order have identical content (see "Duplicate
documents" above), they all need the **same** Status — RaioPDF stops and names
the files if you give identical documents conflicting statuses, since a
document can't be simultaneously handed over and withheld. If you withhold the
same document more than once, the log gets exactly one row for it, not one per
copy.

**Not yet included:** withheld documents don't get a placeholder page ("slip
sheet") in the produced set showing where they were removed from — that's
planned for a future release.

## Continuing from a prior production

Click **Continue from prior production…** and choose the folder of an earlier
production package. RaioPDF reads that package's own record of what it produced
— not a guess, a verified reading of the package itself — and fills in the
Prefix, Start, and Digits for you, with a line like "Continuing SMITH from
SMITH000123, produced Jul 14." Those fields lock while a continuation is
active, so the new production can't accidentally reuse or skip numbers.

- **What's verified:** the prior package's Bates report is checked against its
  own manifest (so an edited or replaced report is caught), and its file
  ranges are checked for gaps or overlaps. If anything doesn't check out,
  RaioPDF tells you plainly instead of prefilling a number it can't stand
  behind.
- **Detach** (the **×**) to stop continuing and edit the fields freely again.
- **Adjust start…** is for a deliberate gap or a change in digit width — a
  reserved range, a supplemental production, digits changing between
  matters. It asks for a one-line reason (required) before Start or Digits
  become editable again; the Prefix always stays locked, since continuing a
  different prefix isn't the same series. The reason is recorded on the new
  package.

This replaces the older, quieter "last used" hint — that still fills in a
starting number automatically from your last run in this app, but only
**Continue from prior production…** actually checks the earlier package
before committing to a number.

## What to know

- **Give yourself enough digits.** If the last page's number wouldn't fit the
  digits you chose, it stops and asks you to raise the digit width or lower the
  start number.
- **It writes to a new folder.** Choose an empty package folder; your source files
  aren't changed.

## Related

- [Bates Numbering](tool:bates-numbering) — number a single document
- [Batch Cleanup](tool:batch-cleanup) — clean the files before you produce them
- [Redact](tool:redact) — remove privileged content before production
