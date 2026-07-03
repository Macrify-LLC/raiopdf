# Offline Legal Workflows Plan

Date: 2026-07-03
Repo checked: `/home/jacob/workspace/raiopdf`
Remote baseline: `origin/main` at `303cfc2` (`P3a: MCP legal tools - exhibit binder, Bates (+folder), page numbers, split, extract`)
Also reviewed: `origin/macro/raio-pdfa-gating` at `1f64a0c`

## Remote State Verified

- `origin/main` has one real bundled jurisdiction pack: Florida.
- `origin/main` has broad e-filing research in `packages/rules/research/efiling-technical-limits-2026-07-02.md`, but not broad JSON packs.
- `origin/main` Prepare for Filing normalizes pages, optionally appends certificate of service, splits by size, converts to PDF/A, re-runs preflight, and saves only if output preflight passes.
- `origin/main` Prepare for Filing does not explicitly run sanitize, metadata scrub, or flatten as named filing-prep steps.
- `origin/macro/raio-pdfa-gating` adds safer PDF/A stance handling and impact warnings, but is not a superset of `origin/main`.
- `origin/main` MCP already includes OCR, merge, rotate, compress, sanitize, scrub metadata, exhibit binder, Bates single/set, page numbers, split, and extract.

## 1. Offline Jurisdiction Packs

Ship these first:

- Florida
- Federal CM/ECF baseline
- Georgia - PeachCourt
- Georgia - eFileGA / Tyler
- Indiana

Florida remains the default first-class pack.

Federal CM/ECF should be a baseline pack, not a fake universal federal-court pack. It can enforce PDF-only, no JavaScript, no encryption/password protection, no embedded/internal attachments, flattening fillable forms as a filing-safety step, and PDF/A accepted but not required/preferred. Federal file-size cap must be user-configured because each court sets its own limit. Persist this as a local court profile.

Georgia must be split by platform. Georgia is not one statewide technical spec. Use separate visible packs for PeachCourt and eFileGA/Tyler. For eFileGA, do not auto-convert to PDF/A and do not auto-OCR as a default because the research flags PDF/A/font/OCR format-error risk. Treat eFileGA 5 MB per-document and 25 MB per-envelope as warnings/recommendations, not hard failures, unless later verification proves otherwise. PeachCourt is thinner: PDF only, total file size recommended under 25 MB, no confirmed PDF/A/metadata/OCR/bookmark rule.

Indiana is a strong statewide pack. Enforce PDF-only, 50 MB per document, 75 MB per envelope, no encryption/password protection/access restrictions, no embedded files, OCR for scanned documents, filename max 100 chars including `.pdf`, and metadata scrub when confidential/redacted information is present. Treat metadata scrub as safe default. Defer Indiana appellate appendix workflow unless filing type becomes part of the selector.

Schema upgrades needed:

- Add pack/profile fields: jurisdiction, court system, portal, scope note, and user-configured max-byte support.
- Add checks for active content, encryption/passwords, embedded files, filename length, metadata stance, OCR stance, envelope size, and PDF/A stance values: `required`, `preferred`, `accepted`, `prohibited`, `unknown`.

## 2. Filing Packet Builder

Make this a mode inside Prepare for Filing, not a competing separate tool.

Output a local filing package folder containing:

- Filing-ready PDFs, using prefix-plus-preserve filenames such as `01 - Motion to Compel.pdf`, `02 - Exhibit A - Email Chain.pdf`.
- User-facing PDF manifest.
- Quiet machine-readable manifest JSON.
- Quiet `checksums.txt`.

Manifest should include jurisdiction/pack, pack version, last verified dates, source filenames, output filenames, page ranges, byte sizes, checks passed/warnings, PDF/A status, sanitize/scrub/flatten status, timestamp, and a reminder to confirm current requirements.

Packet layout must be configurable:

- User preference controls default.
- Initial default is separate upload files.
- Per-packet override is available.
- Supported layout modes: separate upload files, single combined PDF, and later hybrid grouping.

Florida Rule 1.202:

- Add a Florida pack compliance flag for certificate of conferral.
- Verified rule text places the certificate at the end of the motion and above the signature block.
- Do not add a separate sheet.
- Do not try to decide whether the rule applies.
- Check should be "certificate possibly missing" because even if conferral is not required, the motion must certify that conferral is not required under rule 1.202.
- Do not auto-insert because placement must be above the signature block.

## 3. Prepare For Filing As Policy Pipeline

Current Prepare for Filing should become the orchestrator for jurisdiction-specific filing cleanup.

For each pack, define which steps are required, recommended, optional, or prohibited:

- Normalize page size/orientation.
- Split by document and/or envelope size.
- Convert to PDF/A only when the pack says required/preferred and the user confirms any destructive impact.
- Sanitize active/embedded content where required or recommended.
- Scrub metadata where required/recommended, with Florida PDF/A metadata caveats preserved.
- Flatten forms where required/recommended.
- Preserve explicit warnings before PDF/A or flattening destroys annotations, signatures, forms, or unapplied redaction marks.

Do not add a new separate "court-safe sanitizer" that competes with Prepare for Filing. Fold this into Prepare for Filing.

## 4. Production Set Builder

Build a production workflow on top of existing Bates, split, extract, and local output primitives.

Inputs:

- Ordered source PDFs.
- Production prefix.
- Manual/custom starting number.
- Optional previous production manifest to continue numbering.
- Whole-document confidentiality designation per file.
- Output folder.
- Optional volume size cap.

Outputs:

- One stamped output PDF per input by default.
- Optional combined production PDF.
- Production index PDF.
- Production index CSV.
- Quiet manifest JSON.
- Quiet `checksums.txt`.
- Optional volume folders if size cap is set.

Defaults and decisions:

- One output per input by default.
- Layout configurable, same philosophy as filing packet layout.
- Whole-document confidentiality only in v1.
- Page-range confidentiality deferred.
- Index columns: `Bates Start`, `Bates End`, `Filename`, `Pages`, `Designation`, `Source Path`, `SHA-256`.
- Support manual start, custom override, and continue-from-manifest.
- Defer formal load files such as `.dat`, `.opt`, Relativity, or Concordance exports.

## 5. Better Exhibit Binder

Remote already supports ordered exhibits, labels, placement, first/all page stamping, optional slip sheets, and bookmarks.

Add:

- Generated exhibit index page.
- Index placement after the main document and before Exhibit A.
- Exhibit label, description/name, page count, binder page range, optional source filename.
- Editable exhibit descriptions, defaulting from filename.
- Descriptions not required.
- Global local binder presets for v1.
- Slip sheets off by default; preference/preset can change it.
- Binder stays focused on combined binder output.
- Packet Builder owns separate-file export but can reuse binder labeling, index, and stamping logic.

Bookmark depth:

- v1: Main document, Exhibit A, Exhibit B, etc.
- Later: nested bookmarks from source PDFs under each exhibit.

## 6. Batch OCR / Cleanup Queue

Add a local worklist for repetitive cleanup.

Inputs:

- Multiple PDFs selected by user.
- Selected output folder by default.
- Advanced option later: save beside originals.
- Optional jurisdiction pack.

Operations for v1:

- OCR / make searchable.
- Compress.
- Sanitize.
- Scrub metadata.
- Repair.
- Split by size cap.
- Normalize page size/orientation if a jurisdiction pack is selected.

Do not include redaction, page-range edits, or legal-judgment operations in the batch queue.

Defaults and behavior:

- Conservative default preset.
- OCR only when the input appears image-only; skip-text OCR is acceptable for mixed docs but should not be the headline default.
- Default output naming: `filename - cleaned.pdf`.
- Operation-specific suffixes only for advanced/custom runs.
- Run one job at a time initially because OCR/Ghostscript/JVM memory is expensive.
- Never overwrite originals.
- One output per input by default.
- Failure on one file does not stop the queue.
- Status per file: pending, running, done, failed, skipped.
- Write `batch-report.pdf`, quiet `batch-report.json`, and quiet `checksums.txt`.
- Pack-aware cleanup is optional; if a pack is selected, apply size/format defaults and produce pack-aware warnings. Do not silently convert to PDF/A unless the pack says required/preferred and the user confirms.

## Deferred

- Broadened redaction report work.
- Visual PDF diff / compare.
- Page-range confidentiality designations.
- Formal litigation-support load files.
- Indiana appellate appendix special workflow unless filing type selection is added.
- Nested source-PDF bookmarks under exhibit bookmarks.

