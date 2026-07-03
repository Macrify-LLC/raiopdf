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

Sub-headline: Plus the legal workflows Adobe never bothered building.

## Positioning frame (short paragraph, upper page) — updated 2026-07-03 (rev. 3)

Written in Jacob's own first-person voice, not third-person product copy —
direct, plainspoken, a little wry, not corporate-marketing-serious. This is
now a real, opinionated founder essay, not a sanitized paragraph — the words
below are canonical, pulled verbatim from the repo's `README.md` (Jacob's own
style-fix pass, 2026-07-03). Reproduce it verbatim wherever the full version
is used; do not paraphrase it into corporate voice:

> Nothing makes me feel more like a crotchety old man than how software
> works today. I remember when you got software by someone handing you a
> floppy disk and that was that. But at some point, software companies
> realized that they could make unlimited money by renting the software out
> to users rather than selling it, and that became the only way
> productivity software was sold. And because software was so technically
> complicated and expensive to make, customers didn't have much of a choice
> in the matter.
>
> Nobody at my firm likes dealing with Acrobat. Its bloat stresses
> computers, its licensing quirks can bring work to a standstill, it
> constantly pushes features nobody wants to use, and we're paying
> thousands for the privilege. Editing a file that's already sitting on
> your own computer shouldn't require an account, a cloud upload, and a
> cavalcade of minor annoyances. So in this age of agentic coding, I asked
> how hard it would be to build a fully featured PDF program the old
> fashioned way. Turns out it's not that hard.
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
>
> And because you can just build it yourself, you can add in the
> functionality you've always wanted and leave out the stuff you don't.
> Regulating PDFs for e-filing has always been a major annoyance of mine.
> Some features, like exporting a PDF into size-limited chunks, just don't
> seem to exist in Acrobat (or I can't find them). Some are buried under a
> hundred configurations I don't want or understand.
>
> I believe that using Raio is a genuinely better experience than using
> Acrobat. Without the bloat, it's snappier. Without all of the features
> I've never used, it's less confusing and clunky to operate. And with the
> additional law practice-specific improvements, a lot of pain points of
> practice are smoothed out.
>
> This went from an idea to a working prototype in about twelve hours. Not
> because I'm an engineering prodigy — I'm a lawyer — but because the tools
> for building solid, deterministic software have gotten game-changingly
> powerful. If one attorney with a laptop can put a real dent in "free local
> PDF suite" over the course of an evening, the assumption that you need a
> giant company and a subscription to get decent software was already on
> its way out.
>
> The spirit airlines of software is arriving, and even if you don't like
> it, the Adobes, Microsofts, and others in the world are going to have to
> start competing with software that is free, convenient, reliable, and
> easy to use.

**Revised guidance (2026-07-03): this IS partially a protest — a personal
one, not a corporate one.** Naming Adobe (and, per the closer line above,
Microsoft) directly is fine — the tagline itself now says "the legal
workflows Adobe never bothered building." What's still off-limits is
*corporate-sounding* framing: no "warning shot," no "rebuke of the
subscription-SaaS pattern," no strategic-market-positioning language. This
reads as a specific person (a practicing attorney) griping about specific,
lived annoyances — bloat, licensing quirks, features nobody asked for — and
building the alternative himself. Keep it personal and specific, never
abstract/strategic. A first-person belief claim like "I believe this is a
genuinely better experience" is fine even pre-1.0 (the hedge is "I
believe," not a claim about the product being finished) — an unattributed,
third-person "RaioPDF is better than Acrobat" stated as flat fact is not,
until there's a real release to back it.

Where it fits naturally (not every option needs the full essay), the
concept-to-working-prototype timeline — about twelve hours — is a fair,
lighthearted beat for the same point: you don't need a giant company to
build something solid. It now belongs in the main flow of the essay (Jacob
folded it out of a separate "fun aside" and into the narrative itself) —
don't isolate it into its own callout box if you're using the full text.

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
  numbers per Fla. R. Jud. Admin. 2.425, before a filing goes out. Always
  pair with the honest caveat: this is assistive only — never trust AI with
  legal reasoning, verify before relying on it. Don't feature this one
  without the caveat attached.
- **Metadata scrubbing** before production or filing.
- **e-filing preflight report** with the actual rule citations (Fla. R. Jud.
  Admin. 2.520/2.525) attached.
- **Native MCP integration** (added 2026-07-03) — no AI built into RaioPDF
  itself, but it speaks natively to a user's own AI agents and tools. Keep
  the "no AI in the product" claim and the "MCP-native" claim next to each
  other so it doesn't read as a contradiction — the product has no AI
  features; it exposes an interface AI agents can call.

## Why now (short section, can double as a pull-quote) — updated 2026-07-03 (rev. 3)

> The spirit airlines of software is arriving, and even if you don't like
> it, the Adobes, Microsofts, and others in the world are going to have to
> start competing with software that is free, convenient, reliable, and
> easy to use.

(Same first-person-voice guidance as the positioning frame above applies
here — this is Jacob's line, pulled verbatim from the README's closing
paragraph.)

## What it is NOT (small, honest, near the download panel or footer) — updated 2026-07-03

- Not "AI-powered." No AI features built into RaioPDF — if I wanted an AI
  summary I could go to a million other more useful places first.
- Not released yet. Pre-alpha, no promised date. But if you want it, I'll
  give it to you.
- Windows first. macOS later — no date promised.
- Not trying to win a features arms race. This isn't about beating anyone
  spec-for-spec — it's about proving the free, local, and genuinely
  **competitive** alternative can exist at all.

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

## License / footer — updated 2026-07-03

- GPL-3.0. Bundles the MIT-licensed Stirling-PDF engine and other
  third-party components under their own licenses.
- "Published as a public good and also to swag on em by Macrify LLC."
  (Replaces the older "public service to the legal community" line — same
  fact, Jacob's own idiom. "Swag on em" is an established personal phrase of
  his, not a one-off — keep it verbatim, don't smooth it into formal
  language.) Link to macrify.me. Wordmark per `logo-system.md` — the Macrify
  wordmark file, never hand-typed next to a block mark.
- Support: GitHub Issues (primary) and support@macrify.me (best-effort,
  free/community-supported software — say so plainly, don't imply an SLA).

## Legal/tone guardrails — updated 2026-07-03

- No dollar/time/hour estimates that aren't backed by measured data. "Free"
  and "$0" are fine (factual). Never "saves you X hours." The
  concept-to-prototype "about twelve hours" line is a stated fact from
  Jacob, not a productivity/savings estimate — it's fine to use where noted
  above.
- **Superlatives carve-out for Jacob's own founder-voice copy.** The
  org-wide "no superlatives" rule (`sales-positioning.md`) still applies to
  generic/third-person marketing copy for every other product — but RaioPDF's
  first-person essay content is Jacob's own voice, and he used
  "game-changingly powerful" in his own README edit. Don't strip color out
  of his verbatim quotes. Do still avoid inventing *new* superlatives in
  copy that isn't a direct quote from him.
- **"Better than Acrobat" claims are fine in first person, hedged.** "I
  believe using Raio is a genuinely better experience than Acrobat" is
  Jacob's own line and stays. Don't write new unattributed/third-person
  "RaioPDF beats Acrobat" claims — the difference is the "I believe," not
  whether a comparison is made at all.
- No fear framing ("never miss a redaction"). Lead with what the software
  does, not what goes wrong without it.
- RaioPDF is not tier-scoped — it's a free public download and brand/lead-gen
  asset, not a paid Macrify engagement. Don't pitch Tier 1/2/3 anywhere on
  this page.
