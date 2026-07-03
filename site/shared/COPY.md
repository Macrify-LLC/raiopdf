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

## Positioning frame (short paragraph, upper page) — updated 2026-07-03

Written in Jacob's own first-person voice, not third-person product copy —
direct, plainspoken, a little wry, not corporate-marketing-serious:

> I didn't build this to pick a fight with anyone's business model. I built
> it because editing a file that's already sitting on your own computer
> shouldn't require an account, a cloud upload, and a little voice in the
> back of your head wondering what happens to the file once it leaves your
> machine. That's a lot of ceremony for a task your laptop can already do by
> itself.
>
> RaioPDF is the other way of doing it: a full, genuinely useful PDF suite —
> including the less-glamorous legal stuff like true redaction and Bates
> numbering — given away for free, running entirely on your own machine,
> permanently.
>
> Turns out you don't need a subscription and a login screen to make solid
> software — you just have to build it. And once someone proves that, "this
> is just how PDF software works now" stops being true. That's really the
> point: not to out-feature any particular vendor, but to show a firm
> doesn't have to just accept whatever terms it's handed for a task this
> basic.

Never say "kills Adobe," "Adobe killer," or anything reading as an attack on
Adobe the company. Never name Adobe/Acrobat as a direct point of comparison
at all — no "Adobe does X, we do Y," even factual ones, and no
feature-by-feature comparison table. "Acrobat" as a plain category reference
(e.g. the hero one-liner above) is fine for orientation; a value-judgment
comparison is not. The pitch is what RaioPDF *is* and the idea behind it —
not a rebuttal of any specific company.

Where it fits naturally (not every option needs it), the concept-to-working-
prototype timeline — about twelve hours — is a fair, lighthearted aside for
the same point: you don't need a giant company to build something solid.
Don't force it in if the design doesn't have room; it's a bonus beat, not a
required claim.

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

## Why now (short section, can double as a pull-quote) — updated 2026-07-03

Turns out you don't need a subscription and a login screen to make solid
software — you just have to build it. RaioPDF is proof: free, full-featured,
on-device, nothing collected. (Same first-person-voice guidance as the
positioning frame above applies here.)

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
  and "$0" are fine (factual). Never "saves you X hours." The
  concept-to-prototype "about twelve hours" line is a stated fact from
  Jacob, not a productivity/savings estimate — it's fine to use where noted
  above.
- No superlatives ("game-changing," "revolutionary," "best-in-class").
- No fear framing ("never miss a redaction"). Lead with what the software
  does, not what goes wrong without it.
- RaioPDF is not tier-scoped — it's a free public download and brand/lead-gen
  asset, not a paid Macrify engagement. Don't pitch Tier 1/2/3 anywhere on
  this page.
