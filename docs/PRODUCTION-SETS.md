# Production Sets: the litigation load file and the draft privilege log

`packages/production-set` can write a litigation load file (`production.dat`)
alongside a Bates production package. This page is the byte-level spec for
that file, and an honest account of what's deliberately not included yet. It
also documents the draft privilege log (`draft-privilege-log.csv`) that gets
written whenever any source is withheld or produced with redactions.

## The DAT profile: "Relativity-compatible Concordance DAT defaults"

Named that way on purpose, and not "universal Concordance" — Concordance DAT
has no single universal spec, and every review platform's importer has its
own tolerances. This is one fixed profile, tuned to what Relativity (and
most Concordance-style importers) expect without custom mapping. It is not
configurable; a platform that needs different field names or order needs a
new profile, not a flag on this one.

- **Field delimiter:** byte `0x14` (ASCII DC4, conventionally shown as `¶`).
- **Text qualifier:** `þ` (U+00FE), wrapping every field, including the
  header row.
- **Embedded newlines** inside a value become `®` (U+00AE).
- **Encoding:** UTF-8 with a byte-order mark (`EF BB BF`).
- **Line endings:** CRLF, on every line including the last.
- **Header row first**, then one row per produced file.

### Field order (fixed)

```
BEGBATES, ENDBATES, BEGATTACH, ENDATTACH, PAGECOUNT, CONFIDENTIALITY,
CUSTODIAN, FILENAME, LINK, SHA256
```

- **`BEGATTACH` / `ENDATTACH`** are always blank. RaioPDF tracks no document
  families (parent/child attachment relationships) — blank is the
  protocol-typical representation for a non-family record. They are never
  self-mirrored to `BEGBATES` / `ENDBATES`.
- **`CONFIDENTIALITY`** is the raw designation text only. A partial-page
  designation's page-range detail is never appended here (no
  `" (pages X-Y)"` suffix) — that detail already lives in the production
  manifest and index.
- **`CUSTODIAN`** comes from a per-source `custodian` input, available at the
  package (`buildProductionSet`) and MCP (`build_production_set`) level. The
  desktop app has no per-file custodian control in v1 — a UI-built
  production's rows are blank in this column.
- **`FILENAME`** is written only when `includeFilenameInIndex` is `true` (the
  same option that gates the Filename column on the production index PDF/CSV)
  — otherwise every row's value is blank, though the column and header stay.
- **`LINK`** is the produced file's path relative to the load file's own
  location (the package root), backslash-separated regardless of which
  platform built the package — that's the load-file convention every review
  platform expects, e.g. `upload\VOL001\SMITH000001 - SMITH000004 -
  contract.pdf`.

Only **produced** files get a row. A combined production PDF (`combinedPdf`)
and any duplicate occurrence omitted under `duplicateHandling: "produce-once"`
never appear here — same rule the production index already follows.

### Sanitization

This format has no escape mechanism: a field delimiter or text qualifier
inside a value would desynchronize every field after it, and a raw newline
would desynchronize every row after it. Every value is sanitized before it's
written:

1. `\r\n`, `\r`, or `\n` inside a value becomes `®` (U+00AE) — the content
   survives, just not as a literal line break.
2. A literal field delimiter (`0x14`) inside a value is replaced with a
   single space.
3. A literal text qualifier (`þ`) inside a value is replaced with a single
   space.

A pre-existing `®` already in a value is never touched — it's not treated as
a marker on the way in, only produced as a substitution on the way out.

### Placement

`production.dat` is written at the **package root** (via the package
writer's `addRootDocument`), a sibling of `upload/` and `raio-manifest/` —
never inside `upload/`. Vendors and review-platform importers expect the
load file outside the document tree, and `upload/` stays PDF-only.

## The draft privilege log

`packages/production-set` writes `draft-privilege-log.csv` at the package
root (a sibling of `production-index.csv`, never inside `upload/`) whenever
any source's `status` is `"produce-redacted"` or `"withhold"`. Two per-source
inputs drive it, both distinct from the confidentiality `designation`:
`privilegeAsserted` (the claimed basis, e.g. "Attorney-client privilege") and
`basis` (free-text description, the `Description` column). `privilegeAsserted`
is REQUIRED — a pre-output validation error naming the file — when `status`
is `"withhold"`; both fields are optional (encouraged, not required) for
`"produce-redacted"`.

### Columns (fixed)

```
RowId, Status, PrivilegeAsserted, Description, Filename, Pages,
Date, DocType, Author, Recipients
```

- **`RowId`** — stable, e.g. `"P-001"`, zero-padded to 3 digits and widening
  naturally past 999 rows. Assigned by production order (each row's source's
  position in the overall `sources` input), so rebuilding the identical input
  reproduces identical row ids.
- **`Status`** — `"Withheld"` or `"Produced with redactions"`. A `"produce"`
  source never gets a row.
- **`Filename`** — the produced, Bates-stamped output name for a
  `"Produced with redactions"` row (matching the production index); the
  SOURCE filename for a `"Withheld"` row, since it was never produced and has
  no output name. Blanked (column and header stay) when
  `includeFilenameInPrivilegeLog` is `false` — independent of the load
  file's/index's own filename option.
- **`Date`, `DocType`, `Author`, `Recipients`** — **always blank.** These are
  manual columns for a human to complete. RaioPDF never guesses at them: a
  wrong autopopulated privilege log entry is worse than a sparse one that
  visibly needs review.

### This is a draft, not a filing

Nothing about `draft-privilege-log.csv` is ready to serve or file as
written. It exists to save the mechanical work of listing every withheld or
redacted document with its asserted basis — completeness in the
Fla. R. Jud. Admin. 2.425 / Rule 26(b)(5) sense (privilege-by-privilege,
document-by-document, enough detail for the other side to assess the claim)
is the requester's responsibility, not something RaioPDF verifies. Review and
complete every row — especially the four blank manual columns — before any
use.

### Interaction with duplicate detection

Duplicate sources (matching content hash) run through the same detection as
the production index and load file. Two rules specific to the privilege log:

- **Conflicting statuses are a pre-output error.** Two byte-identical sources
  can't be given different `status` values (e.g. one `"produce"`, the other
  `"withhold"`) — RaioPDF refuses, naming both files, before anything is
  written. The same document can't simultaneously be handed over and
  withheld.
- **A uniformly-withheld duplicate group collapses to one row.** When every
  occurrence of a duplicate group shares `status: "withhold"`, only the
  canonical (first, by source order) occurrence gets a privilege log row; the
  rest are cross-referenced in the manifest's `productionDuplicates` detail
  only, the same way a `duplicateHandling: "produce-once"`-omitted occurrence
  is. This collapse happens regardless of `duplicateHandling`, since neither
  occurrence is ever produced either way.

### Not yet included: slip sheets

A withheld source is currently a clean **omission** — it simply doesn't
appear in `upload/`, the index, or the load file, and its planning hash is
recorded only in the `privilegeLog` manifest detail. It does **not** insert a
placeholder page ("slip sheet") into the produced set showing where the
withheld document would have sat, and there is no Bates-numbered slip-sheet
option. That — along with the zero-produced-output edge case it implies — is
deliberately deferred to a follow-up release; this release's package types
(`ProductionSourceStatus`, the `privilegeLog` manifest detail) are shaped to
leave room for it without a breaking change.

## Evaluated and deferred: OPT / Opticon

An OPT (Opticon) image cross-reference file was evaluated for this same
release and deliberately not shipped.

OPT is a **page-level** format by spec: one row per image, addressing a
single-page TIFF or a single page within a multi-page image. RaioPDF's
production output is multi-page PDFs — a conforming OPT needs
page-addressable output (one image per page, or an offset/page-number
scheme into a multi-page image) that the current production pipeline
doesn't produce. Shipping an OPT that doesn't actually conform to the
format review platforms expect would be worse than not shipping one: it
would silently corrupt an import rather than fail loudly. This is deferred
until production output is page-addressable, not ruled out permanently.

LFP (the Summation-family load-file format) was also considered and
declined — its installed base has been shrinking for years in favor of
Concordance-style DAT, and building a second format's worth of
field-mapping and sanitization logic for a shrinking ecosystem isn't a good
trade against building it once, well, for the format that's still the
common denominator.

## Related

- [`packages/production-set/src/loadFiles.ts`](../packages/production-set/src/loadFiles.ts)
  — the load-file implementation this page documents; its module docstring
  carries the same spec in comment form, kept in sync with this page.
- [`packages/production-set/src/index.ts`](../packages/production-set/src/index.ts)
  — the privilege-log implementation (`formatPrivilegeLogCsv`,
  `ProductionSourceStatus`, the withhold/produce-redacted plumbing).
- The in-app help article for Production Set covers the "Litigation load
  file (DAT)" checkbox and the "Withholding documents and the draft
  privilege log" section in plain terms.
