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
   (scripts/boot-payload-engine.mjs boots the host platform's namespaced payload)
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
pnpm prepare:shell-bundle      # assembles payload/windows-x64 + builds Windows external bins
```

`prepare:shell-bundle` downloads the JRE, Stirling JAR, and the OCR toolchain (~hundreds of
MB, cached under `installer/.payload-cache/`). It only needs to run when the payload is
missing or the pins change.

> **Windows / disk note.** Playwright installs Chromium to `PLAYWRIGHT_BROWSERS_PATH` if
> set, otherwise to `%LOCALAPPDATA%\ms-playwright` (the C drive). If C: space is tight,
> set `PLAYWRIGHT_BROWSERS_PATH` to a directory on another drive to keep browsers off C.

## Running it

```bash
pnpm canary
```

That builds the UI, boots the real payload engine, runs the runbook, and shuts the engine
down. Expect ~20–60s once the payload exists (first run also builds the UI). A green run
looks like:

```
Running 11 tests using 1 worker
  ✓ OCR: force-OCR turns an unreadable scan into genuinely SEARCHABLE text
  ✓ Redact: really removes searched text via the engine (verified by re-extraction)
  ✓ Sensitive-data scanner: finds and masks a planted SSN, offers one-click redaction
  ✓ Prepare for Filing: normalizes landscape to letter-portrait AND splits by file size
  ✓ Exhibit binder: assembles a combined PDF with each exhibit stamped and bookmarked
  ...
  11 passed
```

To boot just the engine and poke it by hand (or point your own AI agent / MCP client at it):

```bash
node scripts/boot-payload-engine.mjs      # prints the live base URL + token, stays up until Ctrl-C
```

## Running it in CI

The same runbook also runs in GitHub Actions via the **Canary** workflow
([`.github/workflows/canary.yml`](../.github/workflows/canary.yml)), on a `windows-latest`
runner with the identical toolchain the release build uses. It assembles the payload and
external bins (`pnpm prepare:shell-bundle:windows-x64`), verifies the payload, then runs
`pnpm canary` — both the UI and MCP arms. Playwright traces are uploaded as a workflow
artifact when a run fails.

It triggers three ways:

- **Nightly** against `main` (scheduled) — repeated full-suite runs between releases, so
  intermittent failures (like the OCR-stall class below) surface instead of hiding until
  the next release build.
- **Manual dispatch** on any branch, from the Actions tab.
- **Pull requests carrying the `run-canary` label** — the CI path for contributors who
  can't run the canary locally (the payload engine is Windows-first). Adding the label to
  an already-open PR triggers a run.

What it does **not** do: it is not a required check (the payload is far heavier than the
standard CI jobs — required gates remain the `Web` + `Shell` jobs), and it does not
replace the release workflow's own canary step, which stays the release gate. The
packaged-app-environment gaps below (`smoke:packaged-macos`, the manual desktop checks)
are also outside its reach — it drives the engine through the same harness as a local
`pnpm canary`, with the same blind spots.

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
| **Sanitize** | Removes active content (JavaScript, auto-run actions) | A PDF planted with name-tree JavaScript AND an auto-running OpenAction comes back with both removed (structural check, not a byte scan) and the script body gone from the saved bytes | `engine-ops` · real engine |
| **Metadata scrub — engine seam** | The payload engine's scrub endpoint strips document metadata | Planted Info-dict + XMP sentinel markers are all absent after a scrub through the production sidecar client — this doubles as the enablement probe for the payload's update-metadata endpoint (the same silently-disabled-endpoint class as the PDF/A finding below) | `engine-ops` · real engine |
| **Metadata scrub — in-app** | The Scrub Metadata dialog clears document metadata | The same planted Info + XMP markers are absent from the saved bytes after the user-facing dialog flow (client-side scrub) | `features` · real build |
| **PDF/A export** | Produces a genuine PDF/A for e-filing | Output carries a PDF/A OutputIntent + embedded ICC profile + `pdfaid:part=2` XMP, and opens in the app | `engine-ops` · real engine (bundled Ghostscript) |
| Engine error handling | Fails loud, never silent | Unreachable engine → user-facing error, no blank-app hang | `engine-ops` · real engine |
| **Sensitive-data scanner** | Catches SSNs/account numbers that court rules keep out of filings (in Florida, Fla. R. Jud. Admin. 2.425) | Planted SSN detected, shown masked, one-click redaction offered | `features` · real build |
| **Case caption & cover page** | Renders caption pages locally with selectable styles | The UI saves valid caption PDFs in at least two styles, and the bytes differ by style | `features` · real build |
| **Table of Authorities** | Builds a grouped, reviewed authority table from a brief | A brief with planted case/statute/rule citations produces a saved ToA PDF with grouped headings and citation rows | `features` · real build |
| **Bates numbering** | Sequential numbers stamped across a set | `SMITH000001/2/3` stamped into each page's content bytes | `features` · real build |
| **Prepare for Filing — page size** | Normalizes to letter-portrait | Every page of every output part is letter-portrait (612×792) | `filing-binder` · real build |
| **Prepare for Filing — split by size** | Splits oversized filings into portal-compliant parts | Output is ≥2 files, each named "… Part N of M" | `filing-binder` · real build |
| **Exhibit binder** | Properly named, stamped, bookmarked | Each exhibit stamped ("Exhibit A/B") + bookmarked in order | `filing-binder` · real build |
| **Restricted-but-not-secured** (synthetic, always runs) | Opens an owner-restricted PDF without treating it as locked | A generated RC4-40 owner-restricted PDF (empty user password, real `/Encrypt` dict) opens, renders, and is fully usable | `real-fixtures` · generated fixture |
| **Lossless decrypt** (synthetic, always runs) | Engine decrypt preserves the text layer | The generated restricted PDF, decrypted through the sidecar client with an empty password, loses `/Encrypt`, keeps `/Font`, and renders its known planted sentence **verbatim** in the app | `real-fixtures` · generated fixture |
| **Split-by-size over the portal cap** (synthetic, always runs) | Splits oversized filings into portal-compliant parts | A generated ~28 MB incompressible-noise PDF splits through the real split engine into ≥2 parts, every part under the FL portal cap | `split-oversize` · generated fixture |
| **Garble → readable** (real doc) | Force-OCR rebuilds a broken/font-mismatch text layer into readable text | A real garbled scan becomes **searchable in the app** after Force re-OCR (hits for "the" go from ~0 to many) | `real-fixtures` · local fixture |
| **Restricted-but-not-secured** (real doc) | Opens an owner-restricted PDF without treating it as locked | The PDF opens (via the engine Repair path), renders, and is fully editable | `real-fixtures` · local fixture |

### Synthetic always-run tier (generated fixtures)

The restricted-open, lossless-decrypt, and oversized-split acceptances used to be
gated **entirely** on the private local fixtures below — so on any machine without
them (including the release runner) those safety-critical checks silently skipped.
They now run a synthetic tier first, on every canary run, driven by generators in
[`smoke/real-engine/synthetic-fixtures.ts`](../apps/ui/smoke/real-engine/synthetic-fixtures.ts)
(unit-tested in CI by `synthetic-fixtures.test.ts`):

- **Restricted PDF** — a deterministic, hand-assembled RC4-40 (V1/R2) PDF with an
  owner password and permission restrictions but an **empty user password**, plus a
  real Helvetica text layer of known content. Validated against qpdf, the engine's
  own decrypt flags, and pdf.js.
- **Oversized-noise PDF** — a deterministic ~28 MB PDF of incompressible
  pseudo-random raster pages (4 MiB per page, single-digit page count so the
  O(n²) split stays fast). Generated in well under a second; never committed.

The real-document tier below remains as an **additional maintainer-local layer** —
the synthetic tier proves the mechanism, the real tier proves field documents.

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

# 2b. Memory ceiling probe — samples peak JS heap (CDP) while opening +
#     paging + searching the fixture, asserts it stays under the streamed
#     target and far below the file size:
pnpm exec playwright test smoke/streamed-memory.smoke.ts

# 3. Path-op acceptance (selected-page extract, page-range split,
#    split-by-max-bytes parts passing qpdf --check, and prepare_filing
#    normalize+split with per-part facts preflight):
RAIOPDF_ENGINE_PAYLOAD_DIR=<repo>/apps/shell/src-tauri/payload/windows-x64 \
RAIOPDF_LARGE_FIXTURE=<repo>/apps/ui/smoke/fixtures.local/synthetic-large.pdf \
  cargo test -p engine-sidecar-core -- --ignored large_fixture --nocapture

# 4. Node-lane large-file canary (large binder under aggregate cap,
#    aggregate-cap rejection, and large overlay apply/save):
RAIOPDF_LARGE_FIXTURE=<repo>/apps/ui/smoke/fixtures.local/synthetic-large.pdf \
  pnpm --filter @raiopdf/mcp test:canary --run test/large-file.canary.ts
```

When the REAL 283 MB / 2,556-page appendix or 59 MB agenda fixtures are on
disk, point `RAIOPDF_LARGE_FIXTURES_DIR` at your own local, private fixture folder
instead — the synthetic file is the stand-in, not the goal:

```powershell
$env:RAIOPDF_ENGINE_PAYLOAD_DIR = "<repo>\apps\shell\src-tauri\payload"
$env:RAIOPDF_LARGE_FIXTURES_DIR = "<private-fixtures-dir>"
pnpm canary:large
```

`canary:large` scans the folder recursively for PDFs at least 40 MB by default,
then runs selected-page extraction, page-range split, and the path-based filing
pipeline (`normalize-pages` + `split-by-size`) against each one. That folder is
maintainer-local, contains real legal examples, and must never be committed. If
`RAIOPDF_LARGE_FIXTURE` or
`RAIOPDF_LARGE_FIXTURES_DIR` is set but no matching PDFs are found, the canary
fails instead of silently passing.

**Recorded run (2026-07-04, v1.1 Phase 4 validation, synthetic 270 MB / 270 pp):**

| Scenario | Result |
|---|---|
| Path-op split-by-max-bytes | 283,263,942 B / 270 pp → 6 parts in ~65 s, every part ≤ 50 MB cap, all `qpdf --check` clean |
| Path-op prepare_filing (scrub+split) | 6 parts + 6 facts rows in ~11 s, preflight all within-cap |
| Browser streamed open + render + windowed search | passed; page 1 rendered from the range transport, `MARKER-1` visible, lazy search hit |
| **Memory ceiling (CDP JSHeapUsedSize)** | **peak 10.9 MB heap, 5.5 MB attributable to the doc** — vs. a whole-file-in-memory approach that would sit at 2–3× the 270 MB file. The streaming architecture holds. |

**Recorded run (2026-07-08, large parity canaries, synthetic 60 MB / 60 pp):**

| Scenario | Result |
|---|---|
| Path-op selected-page extract | 3 selected pages in ~98 ms, output passed `qpdf --check` |
| Path-op page-range split | 2 requested range groups / 5 pages in ~190 ms, every output passed `qpdf --check` |
| Path-op split-by-max-bytes | 62,947,498 B / 60 pp -> 2 parts in ~11 s |
| Path-op prepare_filing (normalize+split) | 2 parts + 2 facts rows in ~5 s, preflight all within-cap |
| Node-lane large binder/apply-edits | `large-file.canary.ts`: binder under aggregate cap, aggregate-cap rejection, and overlay apply/save all passed |

**Measured vs. not.** These ran in **real Chromium** driving the **browser-runtime**
range transport (`File.slice`-backed `RaioPdfRangeTransport`) — the same transport class
the Tauri grant path uses, exercising the streaming architecture end to end. The memory
figure is **main-thread JS heap** (CDP `Performance.getMetrics`), the load-bearing proxy
for "is the file being materialized" — it excludes canvas bitmap memory and the pdf.js
worker heap, which live off the main heap by design. **Still not exercised headlessly:**
packaged-Tauri over real **WebView2 IPC** ranged reads, and full renderer-process RSS
sampling — both require a live desktop session and are the one honest gap remaining from
the streamed-viewer validation. Native print of large PDFs is also a desktop/WebView
acceptance item; the automated large canaries cover the extract/apply primitives but do
not drive an operating-system print dialog.

### Covered by the mocked breadth suite (CI, every PR)

These advertised features run in [`app.smoke.ts`](../apps/ui/smoke/app.smoke.ts) against the
same commit and don't need the real engine, so the canary doesn't duplicate them: view/render,
organize (merge/split/reorder/extract/insert/rotate/crop), annotations (text box, highlight,
comment, callout), zoom, search, insert-image, and the filing-dialog choreography.

Two client-side legal outcomes are byte-level-asserted in the mocked lane too, so a
regression fails per-PR CI rather than waiting for the release canary:

- **Bates apply** — the mocked suite types an explicit prefix, applies, and asserts
  the sequential numbers are stamped into each page's content bytes (previously the
  per-PR check stopped at the preview string, so an actual stamping regression
  passed CI).
- **AcroForm fill + flatten** — fills a real AcroForm text field through the form
  layer, saves, and asserts the interactive field is flattened away with the typed
  value drawn into the saved bytes.

### Auto-update (partly automated, partly manual acceptance)

The signed auto-updater can't be exercised end-to-end in CI: the real check/download/install
path runs through the Tauri updater plugin in the packaged **WebView2** runtime, which the
Playwright/Node harness can't drive (the same webview blind spot the canary exists for).

**Automated (CI, every PR):**
- `apps/ui/src/lib/appUpdates.test.ts` locks the load-bearing contract — `downloadSignedUpdate`
  downloads but **never** installs; `installDownloadedUpdate` installs only. This guards against
  the "downloads then auto-installs" behavior the pill redesign removed.
- `apps/ui/src/components/UpdatePill.test.tsx` covers the pill surface — it shows only when an
  update is in flight, renders the right action per phase (Download → Install now → Restart),
  and each action calls the matching handler.
- `pnpm validate:release-assets --tag vX --github` verifies the **published** `latest.json` +
  updater `.sig` against the app's embedded key (run at release time — see `SIGNING.md`).

**Manual acceptance (once per release, on the real installer):** install the previous
signed release, launch it, confirm the top-bar update pill appears; click **Download in
background** → progress → **Install now** → **Restart RaioPDF**; confirm it relaunches on the
new version and the pill is gone. Nothing should install without an explicit click, and the
pill should reappear on every launch until the update is installed.

### Preview release channel

Use a preview release when an advanced build should be available from GitHub Releases
without becoming the stable auto-update target:

```bash
git tag vX.Y.Z-beta.N
pnpm build:shell:signed
pnpm prepare:release-assets -- --tag vX.Y.Z-beta.N
pnpm validate:release-assets -- --tag vX.Y.Z-beta.N --prerelease
gh release upload vX.Y.Z-beta.N release-assets/signed/windows-x64/* --clobber
pnpm validate:release-assets -- --tag vX.Y.Z-beta.N --github --prerelease
```

Mark the GitHub Release as **Prerelease**. Preview users download the installer manually
from that release page. Stable users are not auto-updated to preview builds because the
desktop updater reads GitHub's `/releases/latest/download/latest.json`, and GitHub's
latest-release endpoint skips prereleases.

## The MCP connector canary

The same "prove the advertised feature works in the real artifact" discipline applies to
the **MCP connector** — the optional "Open Raio to AI" bridge that lets an AI client drive
RaioPDF's local tools (see [`MCP.md`](./MCP.md)). The connector is its own shipped artifact:
an esbuild-bundled Node runtime (`payload/mcp/app/index.mjs`) that the `raiopdf-mcp` launcher
runs, spawning its **own** engine host on the first engine-backed call. A mocked unit suite
(`apps/mcp/test/*.test.ts`, in CI) can't see the stdio protocol, the access gate, or the
bundled runtime booting a real engine — the same blind spot the UI canary exists to close.

`apps/mcp/test/mcp-e2e.canary.ts` drives the **real bundled connector over stdio, as an AI
client does** (via `@modelcontextprotocol/sdk`), with the "Open Raio to AI" gate flipped on,
and asserts each tool's OUTPUT against a known answer for a known input. It reuses the
committed, non-sensitive `apps/mcp/eval/fixtures/` PDFs.

```bash
pnpm canary        # runs the UI canary AND the MCP canary
pnpm canary:mcp    # just the MCP end-to-end canary
```

`canary:mcp` **rebuilds the bundled connector first** (`pnpm build:mcp-runtime` — tsc + esbuild
into `payload/mcp/`) so it never tests a stale bundle when `apps/mcp/src` or a bundled workspace
package changed since the last `prepare:shell-bundle`. That rebuild is cheap (~seconds); the heavy
**engine** payload (Stirling JAR + OCR toolchain + bundled Node) remains the `prepare:shell-bundle`
prerequisite. Point `RAIOPDF_ENGINE_HOST_BIN` / `RAIOPDF_ENGINE_PAYLOAD_DIR` at an assembled payload
to run from a worktree — and set `RAIOPDF_PAYLOAD_DIR` to the same dir so the rebuild lands where the
canary reads.

| Advertised claim | Pass criteria | Tool |
|---|---|---|
| **Access gate is real** | With "Open Raio to AI" off, every tool call returns `MCP_DISABLED` (discovery still lists them) | gate |
| **Tool surface is stable** | `tools/list` returns exactly the documented set (drift guard for the count in `MCP.md`) | listing |
| Engine reachable | `raiopdf_health` returns `ok` through the connector's own spawned engine | `raiopdf_health` |
| Counts pages | `pdf_page_count` on a 3-page fixture returns 3 | `pdf_page_count` |
| Merges in order | `merge_pdfs` of a 3- and 5-page file yields a valid 8-page PDF | `merge_pdfs` |
| Extracts pages | `extract_pages` of indexes [0,2] yields 2 pages | `extract_pages` |
| Rotates | `rotate_pages` by 90° preserves count and sets page rotation to 90 | `rotate_pages` |
| Compresses | `compress_pdf` writes a valid, same-page-count PDF via the real engine | `compress_pdf` |
| Assembles a binder | `build_exhibit_binder` (main + one exhibit) yields an 8-page binder | `build_exhibit_binder` |
| Bates stamps | `bates_stamp` writes a stamped copy, page count preserved | `bates_stamp` |
| **Verified redaction** | `redact_terms` writes only after confirming no term is extractable (`survivingTerms: []`) | `redact_terms` |
| Honest preflight | `prepare_for_filing` returns cited checks and is not `confirmedReady` while any check is unverifiable locally | `prepare_for_filing` |
| Locates text | `locate_text` finds a known word and returns match rects via pdf.js through the bundled connector | `locate_text` |
| Annotates text | `highlight_text` annotates located text and preserves the page count | `highlight_text` |

### Adding a tool keeps the docs honest

The tool-surface check asserts the **exact** current tool set, and `MCP.md` quotes the count.
Adding an MCP tool therefore means updating both the `EXPECTED_TOOLS` list in
`mcp-e2e.canary.ts` **and** the count/table in `MCP.md` in the same change — that coupling is
intentional. Ideally add an output check for the new tool while you're there, as the annotation
tools below do.

## Known gaps & findings

- **The canary cannot see the packaged app's own environment — `pnpm smoke:packaged-macos`
  closes part of it.** The canary boots the engine through `scripts/boot-payload-engine.mjs`,
  which *exports* `RAIOPDF_ENGINE_PAYLOAD_DIR` and the per-tool overrides, and drives a
  `vite preview` from a shell that already has a normal environment. The packaged app has
  none of that: it resolves its own payload from inside the bundle and spawns its tools with
  a curated environment. Anything that only works because the harness supplied it therefore
  passes here and fails for the user. The first macOS build shipped three failures in exactly
  that gap, with the canary fully green:
  - **Payload discovery.** A `.app` keeps executables in `Contents/MacOS` and resources in
    `Contents/Resources`, so the payload is not a sibling of the executable the way an
    installed Windows tree makes it. Every caller resolving without a Tauri `resource_dir` —
    all the loopback `/local/*` handlers use `discover(None)` — found nothing, came up with an
    empty toolchain, and OCR failed for every document.
  - **Ghostscript resolution.** `resolve_ghostscript()` read only `RAIOPDF_ENGINE_*`, which
    nothing but the canary's own boot script sets, so `/local/pdfa` answered 422 in the bundle.
  - **A stale bundle.** `tauri build` copies the external bins; only `build:external-bins`
    rebuilds them. A bundle can ship an hours-old `raiopdf-engine-host` while the shell is
    current — and then "I rebuilt and retested" proves nothing.

  `pnpm smoke:packaged-macos` boots the bundle's own engine-host with every `RAIOPDF_ENGINE_*`
  variable stripped and drives the loopback handlers: it fails if the packaged binaries cannot
  find their own payload, if OCR does not return a PDF, or if PDF/A comes back without its
  markers. Run it after `pnpm build:shell:macos-arm64`, before shipping a macOS build.

- **Automation cannot launch the app the way a user does — some checks stay manual.** The
  canary drives a headless browser against a dev server; it never launches the packaged app
  through an Apple Event and never opens a native panel. Two macOS defects hid there and were
  found in minutes of clicking: opening a PDF from Finder *aborted* the app (a Rust panic
  crossing tao's non-unwinding `application_open_urls` callback), and every open/pick dialog
  froze it (a synchronous Tauri command calling `blocking_pick_*` on the main thread, which
  deadlocks against the panel it just scheduled there). Before shipping a macOS build, do this
  by hand on a real desktop session — no harness substitutes for it:

  | Check | Why it cannot be automated |
  |---|---|
  | Double-click a PDF in Finder with the app closed | launch-time open-documents Apple Event |
  | File → Open, pick a PDF | native NSOpenPanel, main-thread contract |
  | Make Searchable on a born-digital PDF | packaged spawn environment end-to-end |
  | Save As | native NSSavePanel |
  | Email a report from an error surface | opener ACL + the OS mail handler |

- **The bundled MCP connector was missing pdf.js's worker — FIXED at packaging.** The MCP
  canary caught that `installer/build-mcp-runtime.mjs` bundled `index.mjs` but never shipped
  `pdf.worker.mjs`. `pdfjs-node.ts` uses `pdfjs-dist/legacy/build/pdf.mjs`, which fake-worker-
  imports `./pdf.worker.mjs` relative to the running module — a runtime import esbuild can't
  see. In the packaged connector every pdf.js-backed op therefore threw *"Setting up fake
  worker failed"*: `redact_terms` could never write (its removal verification is a pdf.js
  step) and `prepare_for_filing`'s searchable-text check silently degraded to "unverified".
  The unit suite missed it because it runs against `node_modules`, where the worker resolves.
  Fix: `pdfjs-node.ts` now statically imports the worker and pre-seeds `globalThis.pdfjsWorker`,
  so esbuild bundles it as code and pdf.js skips the fake-worker setup entirely — no separate
  file, no bundle-relative path to resolve. The `redact_terms` canary guards it. The same
  defect hit PR #125's pdf.js-backed annotation tools (now landed); the `locate_text` /
  `highlight_text` canary checks confirm they work once the worker is bundled.
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
  filing, MCP, batch — gets the lossless path. The UI wiring now treats encryption as an
  unlock flow, not a Repair detour; signed unlocks reuse the signature-invalidation
  confirmation on both byte and streamed/path-op decrypt paths; and Prepare for Filing
  accepts the empty password path for owner-restricted files.
- **Search quirk:** the app's in-document search returned 0 hits on some real, cleanly-
  rendered PDFs (the text layer renders fine and pdftotext reads it). The canary therefore
  asserts on the rendered text layer, not the search box. Worth a separate look.

## Unfinished — what this playbook does NOT yet cover

Committed as a work-in-progress. Open items, roughly in priority order:

- **Garble re-OCR verification was nondeterministic under load — split from detection, and
  the session-limit fix is now applied.** The check is two independent tests: **`Detects a
  garbled text layer`** (fast, reliable — the app reads the broken text layer and flags it)
  and **`Force re-OCR rebuilds … readable text`** (drives the real OCRmyPDF pass). The
  re-OCR half occasionally stalled in a full-suite run (never returned readable text within
  the 3-min poll). Likely cause: Stirling capped concurrent OCR at `ocrMyPdfSessionLimit`
  (2), and a slot not yet released by an earlier OCR test (`engine-ops` runs two) made
  this — the suite's 3rd OCR call — queue. The split means a stall reports as exactly that
  and never masks that detection works. **Determinism fix (applied):**
  `stirling_settings_yaml` (`crates/engine-sidecar-core`) now sets
  `ocrMyPdfSessionLimit: 4` — above the suite's OCR-call count (3), with headroom — so the
  suite's OCR calls cannot exhaust the session slots. The heavier alternative (booting the
  engine on a fresh OCR session per call so a leaked slot can't accumulate) remains
  unimplemented. Root-cause confirmation still needs repeated full-suite runs (the stall
  was intermittent). One honest caveat: the garble fixtures live in the maintainer-local
  `fixtures.local/` tier, so the nightly CI canary (see "Running it in CI" above) skips
  this specific test — it loops the suite's other OCR paths (`engine-ops`) nightly, but
  the re-OCR determinism loop itself still needs local runs until a committed synthetic
  garble fixture exists (tracked as a coverage follow-up).
- **Separate-files two-parter is verified only at the unit level.** `packages/filing-packet`
  tests prove an oversized exhibit splits into `Part 1 of 2 …` in separate-files mode. The
  **desktop packet builder itself** (`build_filing_packet` Tauri command + its UI, which
  needs real desktop paths + a filesystem output dir) is a Tauri-only flow the browser
  canary can't drive — not end-to-end covered. Would need a Rust-level or manual test.
- **Browser UI canary still uses small files for split-by-size.** Genuinely huge filings
  are covered by the opt-in `pnpm canary:large` path-op tier because the browser canary
  should not materialize 132-283 MB legal filings into the WebView.
- **Review artifacts** are saved for the real-fixture tests (garble, restricted, decrypt),
  the split test, and the sanitize / engine-scrub checks. The remaining engine-ops /
  features / filing-binder tests don't yet write their outputs to `test-output/` — add
  `saveCanaryArtifact` calls as wanted.
- **Garble re-OCR has no synthetic stand-in.** Unlike restricted-open, lossless-decrypt,
  and oversized-split, the garble → readable acceptance still runs only against real
  `garble-*.pdf` fixtures — on a machine without them, only garble *detection* logic is
  exercised (by its unit tests), not the re-OCR rebuild.

## Adding a feature check

1. Put UI-driver / fixture helpers in [`smoke/real-engine/helpers.ts`](../apps/ui/smoke/real-engine/helpers.ts).
2. Add a `test(...)` to the file that fits: `engine-ops.canary.ts` (Stirling ops),
   `features.canary.ts` (client-side legal features), or `filing-binder.canary.ts`.
3. Assert the **advertised outcome**, not an HTTP 200 — search finds the OCR'd word, the
   redacted text is gone from the bytes, the parts are named and portrait.
4. Add a row to the runbook table above.
5. `pnpm canary` until green.

## Streamed Editing Canary

Streamed annotation editing is covered by the large-fixture tier because the
important behavior is the desktop file-grant path, not small in-memory PDFs.
Set `RAIOPDF_CANARY_FIXTURES_DIR` to the fixture directory used by the large
document canary and run the streamed editing smoke after the desktop payload is
available. The check should open a >50 MiB PDF by path, verify highlight/comment
selection works through the pdf.js range proxy, save pending edits through
`apply_edits`, and confirm the edited copy reopens as a generated document. The
win32 real-engine canary remains the release gate for packaged payload behavior.

## Files

| File | Role |
|---|---|
| `scripts/boot-payload-engine.mjs` | Boots the real engine-host; also runnable standalone |
| `apps/ui/playwright.canary.config.ts` | Canary Playwright config (localhost origin, serial, boots engine) |
| `apps/ui/smoke/real-engine/global-setup.ts` | Boots the engine once per run, publishes its endpoint |
| `apps/ui/smoke/real-engine/helpers.ts` | UI drivers, fixtures, PDF-decode + real-engine bridge |
| `apps/ui/smoke/real-engine/*.canary.ts` | The runbook tests |
| `apps/mcp/test/mcp-e2e.canary.ts` | The MCP connector end-to-end canary (real stdio client + real engine) |
| `apps/mcp/vitest.canary.config.ts` | Canary vitest config (canary-only include, generous timeouts) |
