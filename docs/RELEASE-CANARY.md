# RaioPDF Release Canary — Feature Acceptance Runbook

> **What this is.** A prerelease runbook that drives the **real, packaged app against the
> real bundled engine** and confirms every advertised feature actually does what the
> marketing says — OCR makes a scan readable, the sensitive-data scanner catches an SSN,
> Prepare for Filing regulates page size and splits by file size, the exhibit binder
> stamps and bookmarks, and so on.
>
> It is **not** the mocked smoke suite. The fast [`test:smoke`](../apps/ui/smoke/app.smoke.ts)
> suite mocks the desktop engine and proves the UI logic on every PR. This canary boots the
> **real** engine-host (the Rust auth-proxy in front of the bundled Stirling-PDF and the
> offline OCR toolchain) and exercises the paths a mock can't see — HTTP, auth token, CORS,
> and the actual PDF processing. It is the layer that catches packaged-build-only
> regressions before a build ships.

## Why it exists

RaioPDF's whole pitch is "everything you use Acrobat for, and it never leaves your
computer." That promise is only as good as the packaged build. Bugs like a sidecar fetch
being invoked with the wrong receiver, an engine endpoint silently disabled in the payload,
or an OCR toolchain that isn't wired up **only appear once the real bits are assembled** —
and the mocked suite is structurally blind to them. The canary is how we prove, every
release, that the advertised features work in the artifact a lawyer will actually download.

## How it works

```
Playwright (real Chromium)  ──► vite preview @ http://localhost:4180   (the real UI build)
        │  the app's engine bridge, unmocked
        ▼
  window.__RAIOPDF_TEST_TAURI_INVOKE__ → hands back the LIVE proxy port + token
        │  real browser fetch (X-RaioPDF-Auth + CORS preflight)
        ▼
  raiopdf-engine-host  ──►  Rust auth-proxy  ──►  bundled Stirling-PDF  +  OCRmyPDF/Tesseract/Ghostscript
   (scripts/boot-payload-engine.mjs boots it from apps/shell/src-tauri/payload/)
```

Two load-bearing details:

- **The page is served from `localhost`, never `127.0.0.1`.** The engine's auth-proxy
  CORS-allowlists `localhost` / `tauri.localhost` origins only; a `127.0.0.1` origin would
  fail preflight and every engine call would break on CORS instead of on a real defect.
- **Only `engine_start` is faked** (to return the live port/token). The HTTP fetch seam is
  left unset, so real requests hit the real proxy — token check, CORS, and all.

## Prerequisites

The canary needs the assembled desktop payload and the built engine-host binary — the same
artifacts a release produces. On a clean checkout:

```bash
pnpm install --frozen-lockfile
pnpm prepare:shell-bundle      # assembles apps/shell/src-tauri/payload/ + builds engine-host
```

`prepare:shell-bundle` downloads the JRE, Stirling JAR, and the OCR toolchain (~hundreds of
MB, cached under `installer/.payload-cache/`). It only needs to run when the payload is
missing or the pins change.

> **Windows / disk note.** Playwright installs Chromium to `PLAYWRIGHT_BROWSERS_PATH` if
> set, otherwise to `%LOCALAPPDATA%\ms-playwright` (the C drive). On the maintainer's
> machine `PLAYWRIGHT_BROWSERS_PATH` is set to `D:\ms-playwright` to keep browsers off C.

## Running it

```bash
pnpm canary
```

That builds the UI, boots the real payload engine, runs the runbook, and shuts the engine
down. Expect ~20–60s once the payload exists (first run also builds the UI). A green run
looks like:

```
Running 10 tests using 1 worker
  ✓ OCR: force-OCR turns an unreadable scan into genuinely SEARCHABLE text
  ✓ Redact: really removes searched text via the engine (verified by re-extraction)
  ✓ Sensitive-data scanner: finds and masks a planted SSN, offers one-click redaction
  ✓ Prepare for Filing: normalizes landscape to letter-portrait AND splits by file size
  ✓ Exhibit binder: assembles a combined PDF with each exhibit stamped and bookmarked
  ...
  10 passed
```

To boot just the engine and poke it by hand (or point your own AI agent / MCP client at it):

```bash
node scripts/boot-payload-engine.mjs      # prints the live base URL + token, stays up until Ctrl-C
```

## The runbook — advertised claim → acceptance check

Each row is a feature RaioPDF advertises and the check that proves it does the job. "Real
engine" rows exercise the bundled Stirling/OCR stack; "Real build" rows are client-side
(pdf-lib) but still verified in the packaged UI.

| Advertised feature | The claim | Pass criteria | Covered by |
|---|---|---|---|
| **Force OCR** | Turns an unreadable scan into searchable text | An image-only scan, after OCR, is **searchable in the app** (Tesseract recovered the words) and carries a real text layer | `engine-ops` · real engine |
| OCR — already-text edge | Re-running OCR on a text PDF is safe | No crash, no error state, resolves cleanly | `engine-ops` · real engine |
| **Verified redaction** | Content is actually removed, not just covered | Searched text is gone from the saved bytes (re-extraction) | `engine-ops` · real engine |
| Redaction — no-match edge | Honest when nothing matches | "No matching text was found." | `engine-ops` · real engine |
| **Compression** | Shrinks a PDF for filing | Real compress pass runs, saves a valid PDF | `engine-ops` · real engine |
| **PDF/A export** | Produces a genuine PDF/A for e-filing | Output carries a PDF/A OutputIntent + embedded ICC profile + `pdfaid:part=2` XMP, and opens in the app | `engine-ops` · real engine (bundled Ghostscript) |
| Engine error handling | Fails loud, never silent | Unreachable engine → user-facing error, no blank-app hang | `engine-ops` · real engine |
| **Sensitive-data scanner** | Catches SSNs/account numbers (Fla. R. Jud. Admin. 2.425) | Planted SSN detected, shown masked, one-click redaction offered | `features` · real build |
| **Bates numbering** | Sequential numbers stamped across a set | `SMITH000001/2/3` stamped into each page's content bytes | `features` · real build |
| **Prepare for Filing — page size** | Normalizes to letter-portrait | Every page of every output part is letter-portrait (612×792) | `filing-binder` · real build |
| **Prepare for Filing — split by size** | Splits oversized filings into portal-compliant parts | Output is ≥2 files, each named "… Part N of M" | `filing-binder` · real build |
| **Exhibit binder** | Properly named, stamped, bookmarked | Each exhibit stamped ("Exhibit A/B") + bookmarked in order | `filing-binder` · real build |
| **Garble → readable** (real doc) | Force-OCR rebuilds a broken/font-mismatch text layer into readable text | A real garbled scan becomes **searchable in the app** after Force re-OCR (hits for "the" go from ~0 to many) | `real-fixtures` · local fixture |
| **Restricted-but-not-secured** (real doc) | Opens an owner-restricted PDF without treating it as locked | The PDF opens (via the engine Repair path), renders, and is fully editable | `real-fixtures` · local fixture |

### Local regression fixtures (real, uncommitted PDFs)

Some failures only reproduce on *specific real documents* — a font-mismatch garble,
an owner-restricted PDF. Those files are real, often-sensitive client documents, so
they are **never committed**. They live in `apps/ui/smoke/real-engine/fixtures.local/`
(gitignored) — or wherever `$RAIOPDF_CANARY_FIXTURES_DIR` points — and the tests
`test.skip()` when they're absent (e.g. a fresh contributor checkout).

To enable them locally, drop your files in with these logical names:

| Name | What it should be |
|---|---|
| `fixtures.local/garble-*.pdf` | One or more PDFs with a broken/font-mismatch text layer (text you see doesn't come back from search). One test is generated per file. |
| `fixtures.local/restricted-not-secured.pdf` | A PDF with owner restrictions (an `/Encrypt` dict) but **no** user password — opens without prompting. |

The `.gitignore` blocks `fixtures.local/` and `*.local.pdf`; a `git add -n` over the
canary dir stages only source files. These real-fixture tests are maintainer-run
regressions — contributors without the files still run everything else.

### Streamed large-PDF scenario (synthetic fixture, opt-in)

The large-pdf-handling acceptance (multi-hundred-MB filings that used to OOM on
open) runs in two opt-in pieces, both driven by a fixture that is **generated,
never committed**:

```bash
# 1. Generate the synthetic fixture (~270 pages / ~270 MB of incompressible
#    noise images + per-page "MARKER-n" text) into smoke/fixtures.local/:
cd apps/ui && node smoke/generate-large-fixture.mjs

# 2. Browser streamed-open scenario (range transport, lazy search, honest
#    gates) — part of the regular smoke config, skips when the fixture is
#    absent:
pnpm exec playwright test smoke/streamed-large.smoke.ts

# 3. Path-op acceptance (split-by-max-bytes parts pass qpdf --check;
#    prepare_filing scrub+split with per-part facts preflight):
RAIOPDF_ENGINE_PAYLOAD_DIR=<repo>/apps/shell/src-tauri/payload \
RAIOPDF_LARGE_FIXTURE=<repo>/apps/ui/smoke/fixtures.local/synthetic-large.pdf \
  cargo test -p engine-sidecar-core -- --ignored large_fixture --nocapture
```

When the REAL 283 MB / 2,556-page appendix or 59 MB agenda fixtures are on
disk, point `RAIOPDF_LARGE_FIXTURE` (and the smoke test's env var of the same
name) at them instead — the synthetic file is the stand-in, not the goal.

### Covered by the mocked breadth suite (CI, every PR)

These advertised features run in [`app.smoke.ts`](../apps/ui/smoke/app.smoke.ts) against the
same commit and don't need the real engine, so the canary doesn't duplicate them: view/render,
organize (merge/split/reorder/extract/insert/rotate/crop), annotations (text box, highlight,
comment, callout), zoom, search, insert-image, and the filing-dialog choreography.

## Known gaps & findings

- **PDF/A conversion runs on the bundled Ghostscript — RESOLVED at the engine layer.** The
  canary surfaced `Stirling PDF request failed: This endpoint is disabled` on
  `/api/v1/convert/pdf/pdfa`. Root cause: **Stirling-PDF 2.14.0 gates that endpoint behind
  the LibreOffice dependency group** (`soffice`), not Ghostscript — the startup log reads
  `Missing dependency: soffice - Disabling group: LibreOffice (Affected features: ... PDF To
  Pdfa ...)`. RaioPDF doesn't bundle LibreOffice (anti-bloat), and Stirling 2.14.0 has no
  `ghostscript` custom-path key to redirect it, so the endpoint is unconditionally disabled in
  the payload. Fix: `SidecarPdfEngine.convertToPdfA` now posts to `POST /local/pdfa`,
  intercepted in the Rust auth-proxy, which converts with the **already-bundled Ghostscript**
  (the same engine Stirling uses under the hood — `PDFA_def.ps` + `iccprofiles/srgb.icc`).
  Output carries a real PDF/A OutputIntent, embedded ICC, and `pdfaid` XMP. The `PDF/A:
  converts a real PDF to a genuine PDF/A` canary guards this. Because it's at the engine layer,
  every caller — Prepare for Filing's "Export PDF/A for ePortal", MCP, batch — gets it.
- **Decrypt is now lossless (qpdf) — FIXED at the engine layer.** The canary found that a
  real owner-restricted PDF (an `/Encrypt` dict, no user password) lost its text layer:
  both the Repair path and Stirling's `/remove-password` stripped `/Encrypt` but gutted the
  text (measured 1298 → 0 words). `SidecarPdfEngine.removeEncryption` is now backed by the
  bundled **qpdf** (`POST /local/decrypt`, intercepted in the Rust auth-proxy) which is
  byte-lossless (1298 → 1298 words, fonts intact). The `Engine decrypt preserves the text
  layer` canary guards this. Because it's at the engine layer, every caller — unlock,
  filing, MCP, batch — gets the lossless path.
- **Follow-up (not yet done):** (a) the open-routing still sends a restricted PDF to the
  Repair detour instead of straight to decrypt; (b) the signature-invalidation confirm must
  be reused on the decrypt path so signed docs still warn; (c) Prepare for Filing should
  accept the empty password for owner-restricted files instead of forcing a prompt. See the
  Codex critique captured for this work.
- **Search quirk:** the app's in-document search returned 0 hits on some real, cleanly-
  rendered PDFs (the text layer renders fine and pdftotext reads it). The canary therefore
  asserts on the rendered text layer, not the search box. Worth a separate look.

## Unfinished — what this playbook does NOT yet cover

Committed as a work-in-progress. Open items, roughly in priority order:

- **Garble re-OCR verification is nondeterministic under load — now split from detection.**
  The check is two independent tests: **`Detects a garbled text layer`** (fast, reliable —
  the app reads the broken text layer and flags it) and **`Force re-OCR rebuilds … readable
  text`** (drives the real OCRmyPDF pass). The re-OCR half occasionally stalls in a
  full-suite run (never returns readable text within the 3-min poll). Likely cause: Stirling
  caps concurrent OCR at `ocrMyPdfSessionLimit` (2), and a slot not yet released by an earlier
  OCR test (`engine-ops` runs two) makes this — the suite's 3rd OCR call — queue. The split
  means a stall reports as exactly that and never masks that detection works. **Determinism
  follow-up (not yet done):** raise `ocrMyPdfSessionLimit` above the suite's OCR-call count in
  `stirling_settings_yaml` (a slot-exhaustion band-aid, cheap), and/or boot the engine on a
  fresh OCR session per call so a leaked slot can't accumulate — verify by looping the full
  canary. Root cause confirmation needs repeated full-suite runs (the stall is intermittent).
- **Separate-files two-parter is verified only at the unit level.** `packages/filing-packet`
  tests prove an oversized exhibit splits into `Part 1 of 2 …` in separate-files mode. The
  **desktop packet builder itself** (`build_filing_packet` Tauri command + its UI, which
  needs real desktop paths + a filesystem output dir) is a Tauri-only flow the browser
  canary can't drive — not end-to-end covered. Would need a Rust-level or manual test.
- **Over-cap split is verified on a small-page file only.** The `Split-by-size` test splits a
  real 34 MB / 7-page plat into two portal-legal parts. Genuinely huge filings (283 MB /
  2,556 pages; 59 MB / 1,461 pages) are **not** run — `LocalPdfEngine.splitByMaxBytes`
  re-serializes per page (O(n²)) and the browser can't open them at all. Tracked in Blueprint
  **`raiopdf-large-pdf-handling`** (viewer range-streaming + delegate heavy ops to qpdf).
- **Decrypt PR2 follow-ups** (open-routing → decrypt not Repair; signature-invalidation
  confirm on the decrypt path; filing empty-password for owner-restricted) — the qpdf backend
  landed; these wiring/UX pieces did not.
- **Review artifacts** are saved for the real-fixture tests (garble, restricted, decrypt) and
  the split test only. The synthetic engine-ops / features / filing-binder tests don't yet
  write their outputs to `test-output/` — add `saveCanaryArtifact` calls as wanted.
- **Metadata scrub** needs its endpoint confirmed enabled in the payload, then a check.
- **Large files as fixtures**: the huge real filings live on the Drive as manual/stress
  objects; there's no automated "slow tier" that runs them.

## Adding a feature check

1. Put UI-driver / fixture helpers in [`smoke/real-engine/helpers.ts`](../apps/ui/smoke/real-engine/helpers.ts).
2. Add a `test(...)` to the file that fits: `engine-ops.canary.ts` (Stirling ops),
   `features.canary.ts` (client-side legal features), or `filing-binder.canary.ts`.
3. Assert the **advertised outcome**, not an HTTP 200 — search finds the OCR'd word, the
   redacted text is gone from the bytes, the parts are named and portrait.
4. Add a row to the runbook table above.
5. `pnpm canary` until green.

## Files

| File | Role |
|---|---|
| `scripts/boot-payload-engine.mjs` | Boots the real engine-host; also runnable standalone |
| `apps/ui/playwright.canary.config.ts` | Canary Playwright config (localhost origin, serial, boots engine) |
| `apps/ui/smoke/real-engine/global-setup.ts` | Boots the engine once per run, publishes its endpoint |
| `apps/ui/smoke/real-engine/helpers.ts` | UI drivers, fixtures, PDF-decode + real-engine bridge |
| `apps/ui/smoke/real-engine/*.canary.ts` | The runbook tests |
