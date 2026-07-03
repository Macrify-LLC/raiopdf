# RaioPDF landing page — approved copy

Source of truth for all landing-page options. Content, not layout — the three
design options (Dawn Break / Clearing Storm / Golden Hour Minimal) each render
this copy with a different visual treatment, but the words themselves don't
change between options. Derived from `sales-positioning.md` (RaioPDF section)
and `business-lines.md` (product line 12). Do not add claims not listed here.

## Product name

Always the full "RaioPDF" — never shortened to "Raio" in body copy. (The nav
wordmark / hero lockup may style "Raio" and "PDF" as two visual weights of one
word, but the word itself is always "RaioPDF.")

## Status banner (always visible, small, near the top)

**Pre-alpha — under active development.** Nothing to download yet. Watch the
repo for the first release.

This is not hidden or soft-pedaled. It sits near the top on every option.

## One-liner (hero headline)

Everything you use Acrobat for, day to day — free, full-featured, and it
never leaves your computer.

Sub-headline: Plus the legal workflows Acrobat never bothered building.

## Positioning frame (short paragraph, upper page)

Adobe has spent years pushing Acrobat toward pricier tiers and more features
nobody asked for, while locking a fundamentally local task — editing a file
that already lives on your machine — behind a mandatory account and a cloud
round-trip. RaioPDF is the opposite bet: free, full-featured for daily use,
entirely on-device, and honest that it collects nothing.

Never say "kills Adobe," "Adobe killer," or anything reading as an attack on
Adobe the company. Never run a feature-by-feature comparison table against
Acrobat by name. The pitch is the model — free/local/no-account vs.
subscription/cloud/bloat — not a spec fight.

## Concrete inputs (a "how you'd actually use it" section — 3–4 items)

- **Download the installer, open it, use it.** No account screen, no sign-in,
  no "create a free account to continue."
- **Drop in a scanned PDF, hit Make Searchable.** OCR runs entirely offline —
  no upload, no wait on a server.
- **One click, "Prepare for Filing."** Normalizes every page to letter-size
  portrait and splits an oversized file into properly labeled, sequential,
  portal-compliant parts.
- **"Combine with Exhibits."** Assemble a motion or brief with exhibit files
  in order, auto-stamped ("Exhibit A," configurable) and auto-bookmarked.

## Outcomes (feature grid / list)

- Full day-to-day Acrobat replacement — view, organize (merge, split,
  reorder, extract, insert, rotate, crop), annotate, fill forms, sign — at
  $0, permanently, no watermarks or nag screens.
- **True redaction** — content is actually removed and verified by
  re-extraction, not a black box drawn over text that's still there
  underneath.
- **Bates numbering** across an entire document set in one pass.
- **Sensitive-info scanner** — assistive detection of SSNs and account
  numbers per Fla. R. Jud. Admin. 2.425, before a filing goes out.
- **Metadata scrubbing** before production or filing.
- **e-filing preflight report** with the actual rule citations (Fla. R. Jud.
  Admin. 2.520/2.525) attached.

## Why now (short section, can double as a pull-quote)

Adobe has spent years pushing Acrobat toward pricier tiers and features
nobody asked for, while a task that's fundamentally local — editing your own
file — now requires an account and a cloud round-trip. RaioPDF is the
opposite bet: free, full-featured, on-device, nothing collected.

## What it is NOT (small, honest, near the download panel or footer)

- Not "AI-powered." No AI runs anywhere in RaioPDF — that's a selling point,
  not a gap.
- Not released yet. Pre-alpha, no promised date.
- Windows first. macOS later — no date promised.
- Not a feature-by-feature Acrobat killer. A different bet on the same job.

## Download panel copy

**Before a release exists** (`available: false` from the GitHub API):
> RaioPDF is in active development. The first signed Windows installer ships
> here first. [Watch the repo on GitHub →]

**Once a release exists** (`available: true`):
- Primary button: "Download for Windows" → the evergreen release asset URL
- Small print under the button: version, file size, published date — all
  pulled live from GitHub, never hand-typed
- A secondary link to the SHA-256 checksum for anyone who wants to verify the
  download themselves
- Windows only today; macOS later

## Download counter

Total downloads across every published release, summed client-side from the
GitHub Releases API. Hidden entirely in the pre-release state (a "0" counter
before there's a product to download reads as broken, not honest).

## No-telemetry line (footer or near the download panel)

This page runs no analytics, sets no tracking cookies, and profiles no one.
The only thing it fetches on its own is a single anonymous, unauthenticated
call to GitHub's public API for the current release — the same thing your
browser would show if you visited the repo directly.

(Accurate scope: this promise is about analytics/tracking/cookies, not "zero
third-party requests" — the page does load its own typefaces the normal way.
Don't overclaim past what's actually true.)

## License / footer

- GPL-3.0. Bundles the MIT-licensed Stirling-PDF engine and other
  third-party components under their own licenses.
- "Published as a public service to the legal community by Macrify LLC."
  Link to macrify.me. Wordmark per `logo-system.md` — the Macrify wordmark
  file, never hand-typed next to a block mark.
- Support: GitHub Issues (primary) and support@macrify.me (best-effort,
  free/community-supported software — say so plainly, don't imply an SLA).

## Legal/tone guardrails

- No dollar/time/hour estimates that aren't backed by measured data. "Free"
  and "$0" are fine (factual). Never "saves you X hours."
- No superlatives ("game-changing," "revolutionary," "best-in-class").
- No fear framing ("never miss a redaction"). Lead with what the software
  does, not what goes wrong without it.
- RaioPDF is not tier-scoped — it's a free public download and brand/lead-gen
  asset, not a paid Macrify engagement. Don't pitch Tier 1/2/3 anywhere on
  this page.
