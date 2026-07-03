---
id: batch-cleanup
title: Batch Cleanup
group: legal
summary: Run many PDFs through the same cleanup steps at once — OCR, compress, sanitize, scrub metadata, and more.
order: 15
---

# Batch Cleanup

When you have a stack of PDFs that all need the same treatment, Batch Cleanup
runs them through it together — no opening each one by hand. Point it at your
files, choose the steps, and it produces a clean set in a new folder along with a
report of what it did to each one.

## Why you'd use it

A production, a client's document dump, a folder of scans — dozens of files that
each need OCR, compression, or their metadata scrubbed. One at a time, that's a
lost afternoon. Batch Cleanup does the whole stack in a single run.

## How to do it

1. In the **Legal** tools, choose **Batch Cleanup**.
2. Click **Add PDF** for each file you want included. (Files need to be opened
   from your computer.)
3. Choose an empty **Package root folder** — where the cleaned files and report
   will go.
4. Turn on the steps you want (below).
5. Click **Run Batch**.

Each file shows its status as it goes — pending, running, done, or skipped.

## The steps you can turn on

- **OCR** — make scanned files searchable. You can OCR only image-only files,
  skip files that already have text, force it on everything, or leave it off.
- **Compress** — shrink large files.
- **Sanitize active content** — strip embedded scripts, attached files, and links.
- **Scrub metadata** — remove the hidden document information.
- **Repair** — fix files that are built in unusual ways.
- **Split by size** — break files over a size you set into parts.
- **Normalize pages** — bring pages to a consistent size.

Sanitize and Scrub metadata are on by default. You can also pick a jurisdiction
pack to apply a court's defaults.

## What to know

- **It writes to a new folder, never over your originals.** Choose an empty
  package folder; your source files are left exactly as they are.
- **You get a report.** Alongside the cleaned files, Batch Cleanup writes a report
  — a PDF and a data file — listing what happened to each one.

## Related

- [Prepare for Filing](tool:prepare-for-filing) — ready a single document for the portal
- [Production Set](tool:production-set) — build a Bates-numbered production
- [Make Searchable (OCR)](tool:make-searchable) — the OCR step, on its own
