# Offline Legal Workflows — Blueprint (v3)

Date: 2026-07-03
Supersedes: v2 of this file and `docs/plans/offline-legal-workflows-plan-2026-07-03.md` (v1, Codex-drafted).
v3 incorporates the Codex adversarial critique (2026-07-03, scratchpad `codex-critique-out.md`) and Jacob's decisions. All open questions are resolved; none remain.

Repo: `Macrify-LLC/raiopdf`. Baseline: `origin/main` at `303cfc2`.
NOTE: the working checkout at `~/workspace/raiopdf` was found parked on a stale branch (`macro/readme-landing-copy-sync`, upstream deleted). All claims in this plan are verified against `origin/main`, not the working tree. Phase 0 includes resetting the checkout.

## Decisions log (what changed since v2 and why)

- **Compliance never blocks.** Every compliance check is warn-only (Jacob, 2026-07-03). There is no hard-fail path anywhere in preflight; "portal will reject this" is still just a warning with strong copy. This collapses the planned `enforcement: hard|warn` axis.
- **Technical prep is a do-it checklist.** The pack resolves to an action plan of prep steps, pre-checked per pack defaults; the user can uncheck any step before running. Destructive steps show their detected impact inline. Unchecks are recorded in the manifest. Save always succeeds; the manifest discloses remaining warnings. (Replaces v2's "save only on preflight pass" and Codex finding #12's block-on-fix policy.)
- **Florida stays at 25 MB.** The research's 50 MB trial / 200 MB appellate envelope numbers are recorded as pack metadata notes, but the shipping default remains the current conservative 25 MB — Jacob practices in Florida and wants the conservative chunk size. Instead, the split-size cap is **user-overridable per run everywhere**: a custom MB cap field on every split/chunk operation, defaulting to the pack value.
- **Encrypted inputs: prompt for password and remove encryption** as a prep step (qpdf; fully local). Wrong/unknown password → that file goes to a warn state, never silently skipped.
- **Bates continuation: trimmed.** No manifest parsing in v1. Raio locally remembers the last Bates number used per prefix and pre-fills it as a hint; the user confirms manually. Manifest-based continuation deferred.
- **Packs update only with app releases.** No side-loading, no separate pack download channel — anything else fights the no-cloud posture. `lastVerified` staleness surfacing covers the gap honestly.
- **Constraint model widened** (Codex finding #3): flat five-value stances can't express "required only when confidential content exists" (Indiana metadata) or "accepted but automation-skipped for conversion risk" (eFileGA PDF/A). Constraints are now `{ stance, condition?, prepDefault }` — see Phase 1a.
- **Phase 3 is a rewrite, not orchestration of existing behavior** (Codex finding #11): current Prepare for Filing is hard-wired to the Florida pack and unconditionally PDF/A-converts.
- **Phase 0 is harvest-and-delete** for `macro/raio-pdfa-gating`: the branch's five-value PDF/A stance model is superseded by the wider constraint shape, but its impact-warning logic gets lifted into Phase 1b/3.
- **Detector honesty** (Codex findings #7–#10): detectors report presence signals, not verdicts — "active content possibly present," "signature fields present; conversion may invalidate them," "possible unapplied redaction annotations." Detector failure is itself a first-class fact.

## Context

RaioPDF ships one real jurisdiction pack (Florida) and a Prepare for Filing flow that normalizes pages, optionally appends a certificate of service, splits by size, converts to PDF/A, and re-runs preflight. The e-filing research (`packages/rules/research/efiling-technical-limits-2026-07-02.md`) establishes that PDF/A conversion is unsafe as an unconditional default and that per-portal specs diverge enough that "one pack per state" is wrong for fragmented states like Georgia. This blueprint turns Prepare for Filing into a jurisdiction-aware policy pipeline, adds four new packs, and builds three sibling workflows (filing packet builder, production set builder, batch cleanup queue) plus exhibit-binder upgrades on top of the engine primitives already on `main`. The MCP server on `main` already registers 14 tools including exhibit binder, Bates (single + folder), page numbers, split, and extract (`apps/mcp/src/index.ts` — verified against `origin/main`; the Codex critique's contrary claim came from the stale working tree).

Everything stays fully local: no cloud, no account, no telemetry, no AI in-product. Checks are assistive guidance, never legal judgment.

## Cross-cutting rules (apply to every phase)

**R1 — Portal-ready files live alone in `upload/`.** Every workflow that emits a package folder writes filing/production-ready PDFs into an `upload/` subfolder containing *nothing else*. The user-facing manifest/index PDF sits at the package root; machine artifacts (`manifest.json`, `checksums.txt`, JSON reports) live in a `raio-manifest/` sibling folder. Bulk-selecting `upload/` into a portal can never grab a non-filing artifact. (Revised from v2's `_raio/` underscore convention per Codex #14 — a folder boundary, not a sorting trick.)

**R2 — Source-path hygiene.** Local filesystem paths never appear in any shareable artifact (production index PDF/CSV, filing manifest PDF, exhibit index page) — they reveal work-product organization. Full paths live only in `raio-manifest/manifest.json`. Shareable artifacts reference source *filenames* at most, and the production index's filename column is a per-run checkbox.

**R3 — Never overwrite originals.** All workflows write new outputs. No in-place mutation, ever.

**R4 — Compliance checks warn; they never block.** Preflight statuses are `pass | warn | unknown`. A confirmed portal-rejection rule gets emphatic warning copy and citation, not a gate. Recommended/unverified limits (eFileGA 5 MB/25 MB) warn with the source cited.

**R5 — Destructive-step impact confirmation.** PDF/A conversion and form flattening can destroy annotations, signatures, form data, and unapplied redaction marks. Any destructive step in the prep checklist displays what will be lost in *this specific document* (from detected facts, not generic copy). Copy uses presence language ("3 annotations, 1 signature field detected — conversion may invalidate them").

**R6 — Provenance + staleness.** Every emitted package records pack id, `packVersion`, per-constraint `lastVerified` dates, and the confirm-current-requirements reminder. Pack staleness (oldest `lastVerified` > 180 days) surfaces in the picker. Packs update only with app releases.

**R7 — User overrides are always available and always recorded.** Any prep step can be unchecked; any split-size cap can be overridden with a custom MB value per run. Every override is recorded in the manifest ("user skipped metadata scrub"; "user set split cap 40 MB, pack default 25 MB").

## Phase 0 — Repo hygiene + harvest `macro/raio-pdfa-gating`

1. Reset the `~/workspace/raiopdf` checkout to `origin/main`; delete the stale `macro/readme-landing-copy-sync` local branch (upstream is gone). All build work branches from fresh `main`.
2. Harvest-and-delete `macro/raio-pdfa-gating` (at `1f64a0c`): lift its PDF/A impact-warning logic (annotation/signature/form detection feeding warnings) into the Phase 1b detector work and Phase 3 checklist copy; its five-value PDF/A-only stance model is superseded by Phase 1a's wider constraint shape. Delete the branch when harvested so no parallel universe survives.

Effort: quick.

## Phase 1 — Pack schema v2, fact extractors, package writer

Three workstreams. The schema declares checks; the fact extractors make them computable; the package writer is the shared plumbing every downstream workflow emits through. Every check added must have a working detector or be explicitly `unknown` with honest UI copy ("Raio cannot verify this yet").

### 1a. Schema v2 + preflight rework

- `schemaVersion` (int, starts at 2) distinct from per-pack `packVersion`. Loader rejects packs with newer `schemaVersion` than the app supports ("update Raio" message); accepts-and-ignores unknown optional fields at the same version. `packIntegrity` checksums unchanged.
- Identity fields: `jurisdiction`, `courtSystem`, `portal`, `scopeNote` (rendered in the picker so "Georgia — eFileGA (Tyler)" vs "Georgia — PeachCourt" is self-explaining).
- **Constraint shape** (replaces flat booleans and the v2 five-value-only plan): each constraint is
  `{ stance: required | preferred | accepted | prohibited | unknown, condition?: string, prepDefault: on | off | n/a, authority, lastVerified, note? }`
  - `stance` = what the court/portal says.
  - `condition` = scope qualifier, surfaced in UI copy ("required when the filing contains confidential/redacted content" — Indiana metadata; "for scanned documents" — Indiana OCR).
  - `prepDefault` = what Raio's checklist does about it by default (the automation axis). This is how eFileGA PDF/A is modeled: stance `accepted`, `prepDefault: off`, note citing the JBIG font Format Error risk. Not "prohibited."
- Constraint set: `pdfa` (+ `flavor`, default `pdfa-2b`; the research's 2a-for-born-digital note carried as pack metadata, no auto-switching), `activeContent`, `encryption`, `embeddedFiles`, `metadataScrub`, `ocr`, `flattenForms`.
- Limits: `maxFileBytes`, `recommendedMaxFileBytes`, `maxEnvelopeBytes`, `filenameMaxChars`, `filenameCharset`. All limit checks warn-only (R4). Split-size cap is user-overridable per run (R7); pack value is the default.
- **Preflight rework**: delete the `toRuleStatus`/`toPortalStatus` coercion (`preflight.ts:294–298` on `main` coerces every rule `fix`→`warn` and every portal `warn`→`fix`). New status vocabulary: `pass | warn | unknown` for everything, per R4. Preflight report gains a selection-level section (envelope size, filename collisions) alongside per-document checks.
- Default posture where a pack is silent (`unknown` stance): safe-and-reversible steps (sanitize, metadata scrub) `prepDefault: on` — the research found scrubbing safe as a default everywhere checked; risky/destructive steps (PDF/A, flatten, OCR) `prepDefault: off` unless stance is required/preferred.

### 1b. Fact extractors (extend `DocumentFacts`)

All local, each with fixture PDFs + tests in `packages/rules/test/fixtures/`. Detector failure is a first-class fact (`facts.errors[]`), rendered as `unknown`, never as `pass`.

- `encryptionState` — via a qpdf/byte-level adapter, *not* pdf-lib (pdf-lib may fail to load encrypted files before inspection is possible). States: none / encrypted / usage-restricted / detector-failed.
- `activeContentSignals` — conservative "possibly present" detector: catalog `OpenAction`, `/AA`, page + annotation actions, JavaScript name tree. Presence signal, not a proven-clean verdict; a full object-graph walker is deferred.
- `embeddedFileCount` — names tree + file-annotation scan.
- `formFields` — count + any-filled flag (AcroForm inspection); feeds R5.
- `annotationCount`, `signatureFieldCount` — presence only; validity/DocMDP verification is out of scope (copy: "signature fields present; conversion may invalidate them").
- `possibleUnappliedRedactions` — `/Redact` annotations plus opaque-rectangle heuristics; copy says "possible," and true redaction assurance stays with the existing redaction verifier.
- `textLayerCoverage`, `imageOnlyPages`, `mixedPages` — per-page text-layer stats; gates batch OCR (Phase 7) and the 1.202 no-text-layer state (Phase 4).
- `filenameLength`/charset — computed at check time.
- `envelopeBytes` — selection-level fact over a multi-file selection.

### 1c. Package writer library

Shared plumbing consumed by Phases 4, 6, 7: creates the package folder layout (R1 — `upload/`, root manifest PDF, `raio-manifest/`), writes `manifest.json` + `checksums.txt` (SHA-256), records overrides (R7) and provenance (R6). One implementation, one test suite; no per-workflow reinvention.

Effort: large (1b is the largest hidden chunk; budget it as its own workstream).

## Phase 2 — Jurisdiction packs

Five packs; Florida stays default.

- **Florida** — migrate to schema v2, preserving existing constraints, the clerk-stamp-space check, and the PDF/A `pdfcreator` scrub caveat (enforced when scrub + PDF/A are both queued). **Size cap stays 25 MB** (deliberate conservative default; the research's 50 MB trial / 200 MB appellate envelope figures are recorded in pack notes). Custom per-run MB override covers users who want bigger chunks.
- **Federal CM/ECF baseline** — honest national baseline, not a fake universal pack: PDF-only; active content, encryption, embedded attachments all `prohibited` stance (warn-only per R4, emphatic copy); flatten-forms `preferred` with `prepDefault: on` (PACER's own troubleshooting names un-flattened forms as a common rejection cause); PDF/A `accepted`, `prepDefault: off`. File-size cap has no national number — the user is prompted once and it persists as a named local court profile ("S.D. Fla. — 50 MB") in `courtProfiles.json` (app data, survives pack updates). `scopeNote` states plainly that local rules and general orders may add requirements.
- **Georgia — eFileGA (Tyler)** — PDF or PDF/A accepted; PDF/A `prepDefault: off` (documented JBIG font-embedding Format Error risk); OCR `prepDefault: off` (the portal's own docs list OCR'd files among Format Error causes); 5 MB/doc + 25 MB/envelope as warnings citing the Tyler FAQ; encryption `prohibited` (documented outright rejection — warn with emphatic copy).
- **Georgia — PeachCourt** — thin pack: PDF only; ~25 MB total recommended (warn); PDF/A, metadata, OCR stances `unknown`; `scopeNote` says exactly that the published spec is thin.
- **Indiana (IEFS)** — PDF-only; 50 MB/doc, 75 MB/envelope; encryption/password/access restrictions `prohibited`; embedded files `prohibited`; OCR `required` with `condition: "for scanned documents"`; filename ≤ 100 chars including `.pdf`; PDF/A `unknown` (guide is silent); metadata scrub `required` with `condition: "when the filing contains confidential/redacted content"` and `prepDefault: on` (safe default everywhere). Appellate appendix workflow deferred.

Each constraint carries `authority` + `lastVerified` as Florida does today. Effort: medium (research done; transcription + review).

## Phase 3 — Prepare for Filing as policy pipeline (rewrite)

This is a rewrite of the orchestration, not a wrapper: current Prepare for Filing is hard-wired to `FLORIDA_PACK`, force-sets input `pdfaCompliant: false`, splits on the Florida recommended cap, and converts every part unconditionally (`apps/ui/src/App.tsx` on `main`).

New flow:

1. User picks pack (+ court profile where applicable) and files.
2. Facts are extracted (Phase 1b); compliance checks render as warn-only report.
3. **Prep checklist renders**: every applicable step, pre-checked per `prepDefault`, each with citation and — for destructive steps — the detected R5 impact inline. User unchecks freely; unchecks are manifest-recorded (R7).
4. Steps run in order: remove encryption (password prompt — wrong/unknown password → file goes to warn state, never silently dropped) → normalize page size/orientation → sanitize active/embedded content → scrub metadata (Florida `pdfcreator` caveat enforced when PDF/A also queued) → flatten forms → PDF/A convert → split by doc/envelope cap (pack default, per-run custom MB override) → final preflight.
5. **Save always succeeds.** The output manifest discloses every remaining warning and every skipped step. No gate.

Prohibited-stance steps render as unchecked-with-reason, visible not hidden — the attorney sees *why* Raio defaults eFileGA PDF/A off. No separate "court-safe sanitizer" tool exists; this is the one pipeline. Effort: large.

## Phase 4 — Filing Packet Builder (mode inside Prepare for Filing)

Multi-document mode of the Phase 3 pipeline, emitting through the Phase 1c package writer.

- Filing-ready PDFs in `upload/`, prefix-plus-preserve names: `01 - Motion to Compel.pdf`, `02 - Exhibit A - Email Chain.pdf`.
- Root manifest PDF: pack + version + last-verified dates, source→output filename map (filenames only, R2), page ranges, byte sizes, checks/warnings, PDF/A + sanitize/scrub/flatten status per file, overrides, timestamp, confirm-requirements reminder.
- `raio-manifest/manifest.json` + `checksums.txt`.
- Layouts: separate upload files (default) | single combined PDF | hybrid grouping (deferred). Preference sets the default; per-packet override.

**Florida Rule 1.202 check (deterministic, warn-only):**

- Applicability gate: "motion" appears in the filename OR in the first-page heading text (caps/title-case line scan of extracted text). No document classifier, no AI.
- Detection: normalize whitespace/case; search for the literal phrase `"certify that prior to filing this motion"` (both prescribed form blocks open with this language) OR a `"1.202"` citation.
- Found → pass. Not found → warn: "Certificate of conferral possibly missing — Fla. R. Civ. P. 1.202 requires a certificate (that conferral occurred, or that it is not required) at the end of the motion, above the signature block." No text layer → `unknown`: "Can't verify — no searchable text; run Make Searchable first."
- Never auto-insert (placement above the signature block can't be done mechanically); never judge applicability beyond the motion gate. Paraphrased certificates may false-positive; acceptable at warn severity with "possibly" copy.

Effort: large.

## Phase 5 — Exhibit binder upgrades

- **Generated exhibit index page** after the main document, before Exhibit A: exhibit label, description, page count, binder page range, optional source filename (off by default, R2 posture). Descriptions editable, default from filename, not required.
- **Layout iterates until stable** (not naive two-pass): fixed-width range columns; lay out the index, compute ranges, re-render, repeat until the index page count stops changing; assert a max-iteration bound in tests. Stamping and bookmarks consume final-iteration numbers.
- Global binder presets (v1). Slip sheets off by default; preset can flip.
- Binder stays combined-output-focused. **Extract labeling/index/stamping as shared functions** — Phase 4 reuses them, so this lands before Phase 4 finishes.
- Bookmarks v1 flat (Main document, Exhibit A, B, …); nested source bookmarks deferred.

Effort: medium.

## Phase 6 — Production Set Builder

Discovery productions on existing Bates/split/extract engine primitives + the Phase 1c package writer. Independent of packs; parallel to Phases 2–4 after 1c.

- Inputs: ordered source PDFs; production prefix; starting number — pre-filled from a locally-stored last-used-number-per-prefix hint, manually confirmed (no manifest parsing in v1); whole-document confidentiality designation per file; output folder; optional volume size cap.
- Outputs: one stamped PDF per input (default) in `upload/` (or `VOL001/`… inside it when capped) | optional combined PDF; production index PDF + CSV at root (Bates Start, Bates End, Filename [per-run checkbox], Pages, Designation — no source paths, R2); `raio-manifest/manifest.json` (full detail incl. source paths + SHA-256) + `checksums.txt`.
- After a run, the per-prefix last-used number updates locally.
- v1 bounds: whole-document confidentiality only; page-range designations, load files (`.dat`/`.opt`/Relativity/Concordance), and manifest-based continuation all deferred.

Effort: medium.

## Phase 7 — Batch OCR / cleanup queue

Local worklist. Depends on Phase 1b (`imageOnlyPages`/`textLayerCoverage` gate OCR); pack-aware bits after Phase 2.

- v1 ops: OCR/make searchable, compress, sanitize, scrub metadata, repair, split by size cap (custom MB override, R7), normalize pages (pack-selected only). Excluded: redaction, page-range edits, legal-judgment ops.
- Conservative default preset. OCR defaults on only for files whose facts say image-only; skip-text OCR available for mixed docs, not the headline default.
- Naming `filename - cleaned.pdf`; operation suffixes only in advanced runs.
- Serial execution v1 (OCR/Ghostscript/JVM memory pressure); per-file status pending/running/done/failed/skipped; one failure never stops the queue; originals never overwritten (R3). Encrypted inputs prompt for password (Phase 3 behavior reused).
- Outputs: `batch-report.pdf` at root, `raio-manifest/batch-report.json` + `checksums.txt` via the package writer.
- Pack-aware mode warns per pack; PDF/A only when stance required/preferred *and* checked in the plan (R5).

Effort: medium.

## Sequencing

```
Phase 0 (repo hygiene + harvest)
  → Phase 1 (1a schema/preflight, 1b extractors, 1c package writer)
      → Phase 2 (packs) → Phase 3 (pipeline rewrite) → Phase 4 (packet builder)
      → Phase 5 (exhibit binder — after 1c; must land before Phase 4 finishes, 4 reuses its shared functions)
      → Phase 6 (production sets — after 1c; parallel to 2–4)
      → Phase 7 (batch queue — after 1b/1c; pack-aware bits after 2)
```

## Deferred

Broadened redaction report; visual PDF diff; page-range confidentiality designations; litigation load files; manifest-based Bates continuation; Indiana appellate appendix (unless filing-type selection lands); nested exhibit bookmarks; hybrid packet layout; save-beside-originals batch option; full PDF object-graph active-content walker; signature validity/DocMDP verification; side-loaded jurisdiction packs; MCP tool exposure for the new workflows (packet builder, production sets, batch queue — follow-on after UI ships); anything macOS — Windows-first holds.
