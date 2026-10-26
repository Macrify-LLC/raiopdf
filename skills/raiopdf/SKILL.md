---
name: raiopdf
description: Use RaioPDF's local connector for legal PDF work that has to be exact — preparing a document for e-filing (letter-size pages, split under the court's file-size cap), verified redaction, Bates numbering, discovery productions, exhibit binders, and OCR of scans. Use whenever the user asks to file, redact, Bates-stamp, produce, or assemble exhibits from PDFs and the RaioPDF tools (raiopdf_health, prepare_for_filing, build_filing_packet, ...) are available.
---

# RaioPDF legal PDF workflows

RaioPDF is a free desktop PDF app that runs entirely on the user's computer. Its
connector gives you tools that do the legal-critical parts of PDF work with tested,
repeatable code: e-filing preparation, verified redaction, Bates numbering,
productions, and exhibit binders. Use these tools for those jobs instead of writing
your own PDF code, and follow the workflows below.

## Ground rules

- **Everything stays on the user's computer.** RaioPDF processes files locally. If
  this conversation runs somewhere that can't reach the user's computer (a cloud
  sandbox or web chat), the tools won't be available — say so; don't upload client
  documents anywhere as a workaround.
- **Check the connection first.** Call `raiopdf_health`. If a tool returns
  `MCP_DISABLED`, ask the user to open RaioPDF → Settings → "Open Raio to AI" and
  turn on "Let your AI operate Raio".
- **Absolute paths only, and nothing is overwritten.** Every output path must be new.
  Tools that build a package (`build_filing_packet`, `build_production_set`,
  `batch_cleanup`) need an output folder that is new or empty — pick one next to the
  source, such as `<source folder>\<name> - filing`.
- **Ask, don't guess, on legal choices**: the court, the per-file size limit, the
  Bates prefix and starting number, confidentiality designations, what to redact,
  and what to withhold as privileged.
- **The attorney has the final word.** These tools check against published rules and
  verify their own output, but they don't give legal advice. Report what was checked,
  what wasn't, and anything the tools flagged, plainly.
- **If something fails**, call `raiopdf_diagnostics` (pass the error's correlation id
  if there is one) rather than reading RaioPDF's log files.

## Prepare a document for e-filing

Use this whenever a document is going to a court's e-filing portal. The goal is
letter-size portrait pages, split into parts that each fit under the portal's
per-file size limit.

1. **Ask which court**, and map it to a rule pack: `florida` (Florida e-Portal),
   `federal-cmecf` (federal CM/ECF), `georgia-efilega`, `georgia-peachcourt`,
   `indiana-iefs`. If none fits, say so and use the closest pack only for page-size
   checks.
2. **Ask for the size cap.** "What's the largest file the portal accepts, in MB?"
   If the user doesn't know, leave the cap out and the pack's own limit is used —
   tell them which limit that was. `federal-cmecf` has no limit of its own (each
   court sets one), so for that pack the cap is required: without it the document
   can't be split or checked against the court's limit — say so plainly.
3. **Preflight.** Call `prepare_for_filing` with `input` and `pack`. It is
   read-only. Note every warning and its rule citation, especially pages that
   aren't letter-size portrait and pages with no searchable text.
4. **Prepare.** Call `build_filing_packet` with:
   - `sources`: `[{ path }]` (several documents in upload order also works)
   - `outputDir`: a new folder
   - `pack`: the pack from step 1
   - `splitSizeMb` and `maxFileBytes`: the user's cap from step 2, if they gave
     one — `splitSizeMb` in MB, `maxFileBytes` as the same cap in bytes
     (MB × 1,048,576)
   - `skippedStepIds`: `["make-searchable"]` only if the preflight found every
     page already searchable

   Don't pass `selectedStepIds`. It replaces the pack's default steps rather than
   adding to them, so it would skip steps the court's pack turns on — removing
   active content and embedded files, scrubbing metadata, flattening forms. The
   defaults always include page normalization, and splitting once a cap is set.
5. **Report the result.** The files are in the package's `upload` folder. A
   document over the cap comes out as numbered parts — "Part 1 of 3", "Part 2 of
   3", and so on — to upload in that order. Every page is letter-size portrait.
   Mention the manifest (`filing-packet-manifest.pdf`), which records what was
   checked.
6. **Check each part's size against the user's cap.** The packet JSON
   (`packetJson` in the result) records each file's `bytes` and an `oversized`
   flag. A single page bigger than the cap can't be split further and comes out
   as an oversized part: name it and don't call it upload-ready.
7. **Re-check.** Run `prepare_for_filing` on each output file and report anything
   still flagged. It checks against the pack's own size limit, not the user's
   cap, which is why step 6 comes first. `confirmedReady: false` means at least
   one check couldn't be confirmed automatically — say which, so the attorney can
   look.

Bookmarks carry over: each prepared file keeps the bookmarks for its own pages.
For a document of 50 MB or more, ask the user to check each part's bookmarks before
filing.

## Redact

1. Get the exact terms from the user (names, account numbers, SSNs, and so on).
2. **Make sure the document has searchable text first.** `redact_terms` finds
   terms in the text layer, so on a scan with no text it finds nothing, and its
   check passes while the SSN is still visible on the page. Run
   `prepare_for_filing` (read-only) and look for pages without searchable text;
   if there are any, run `ocr_pdf` first and redact the OCR'd copy.
3. Call `redact_terms` with `input`, a new `output` path, and `terms`; use
   `wholeWord: true` for short terms that appear inside other words.
4. `redact_terms` removes the text itself and only writes the file after confirming
   none of the terms survive. Never "redact" by drawing boxes or highlights.
5. Confirm with `locate_text` on the output for each term — expect no matches.
   For a scan, also ask the user to look over the redacted pages: OCR can misread
   a term, and a misread term is neither found nor redacted.

## Bates numbering

- One document: `bates_stamp` with `input`, `output`, `prefix`, and optionally
  `start` and `digits` (default 6, zero-padded).
- A set that needs one continuous sequence: `bates_stamp_folder` with the files in
  order, an existing `outputDir`, and the same numbering options.
- Ask for the prefix and starting number; for a follow-on production, ask where the
  last one ended.

## Discovery production

Call `build_production_set` with the sources in production order, a new
`outputDir`, the Bates `prefix`, and per-document choices from the user:
`designation` (for example "CONFIDENTIAL"), `custodian`, and `status` —
`"produce"`, `"produce-redacted"` (redact first with `redact_terms`), or
`"withhold"` with `privilegeAsserted`. Withheld documents get a Bates-stamped slip
sheet and a row in `draft-privilege-log.csv`; tell the user that log is a draft to
complete and review before serving. To continue an earlier production's numbering,
pass its package folder as `continueFrom` together with the same `prefix`, the
same `digits`, and `start` set to the next number after the last one produced —
all three must match the earlier package exactly, or nothing is written. If the
start doesn't match, the error names the expected next number. Ask before turning on `includeLoadFiles`
or `combinedPdf`.

## Exhibit binder

Call `build_exhibit_binder` with the `main` document, `exhibits` in order (each
`{ path, label }`, such as "Exhibit A"), and a new `output`. Each exhibit is
stamped and bookmarked and an exhibit index is added. Offer `slipSheets: true` for
a labeled cover page before each exhibit. For a caption page, `build_cover_page`
builds one from case details the user provides.

## Scanned documents

Call `ocr_pdf` with `input` and a new `output` to make a scan searchable. It runs
fully offline. For many files at once, `batch_cleanup` can OCR, compress, and scrub
metadata in one queue.

## Everyday operations

Merging, splitting by size, extracting, rotating, and compressing are also
available (`merge_pdfs`, `split_pdf`, `extract_pages`, `rotate_pages`,
`compress_pdf`). For anything headed to a court, use the e-filing workflow above
rather than splitting by hand.
