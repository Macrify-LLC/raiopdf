# 0002 — Opt-in crash reporting via a user-submitted GitHub issue

- Status: accepted
- Date: 2026-07-03
- Blueprint: `2026-07-03-raiopdf-error-logging-and-diagnostics` (Phase 3, Open Question Q1)
- Related: 0001 — Logging & privacy policy (planned; the Phase 1 logging/scrubber
  work it will document already lives in `apps/shell/src-tauri/src/diagnostics.rs`)

## Context

Phase 3 of the diagnostics blueprint adds a **post-crash report prompt**:
after RaioPDF exits uncleanly, the next launch offers (once, and the prompt can
be turned off) to help the user send a diagnostic report. Nothing is ever sent
automatically — the *sending* is what the user opts into, per report. The report itself is already designed and data-minimized
(app version, OS/arch, crash signature + backtrace, a scrubbed log tail — never
document data, file names, or page text; see the scrubber in `diagnostics.rs`).

The one genuinely undecided part was **where the report goes**, because that
choice collides with RaioPDF's single most load-bearing promise: **telemetry:
none.** That promise is stated in the README badge, in `SECURITY.md`, on the
marketing site, and — structurally — in the Tauri content-security policy, which
only permits the app to reach its own localhost engine
(`connect-src 'self' http://127.0.0.1:*`). Any true phone-home would require
loosening that CSP in a publicly visible way and rewriting the copy that the
whole "your data stays local" positioning rests on.

The blueprint framed four options: a **prefilled GitHub issue** the user submits
themselves (zero infrastructure, no CSP change), a **Macrify HTTP endpoint**
(one-click and anonymous, but a real phone-home), **email/mailto:** (no CSP
change, clunky, leaks the user's email), or **defer** the whole feature.

## Decision

**Crash reports are delivered as a pre-filled GitHub issue that the user opens
in their own browser and submits themselves.** The app builds a URL
(`https://github.com/Macrify-LLC/raiopdf/issues/new?...`) whose title and body
are the scrubbed, data-minimized payload, and shells out to the OS browser to
open it. **RaioPDF makes no crash-reporting network request of its own** — the
browser does, and only after the user reviews the exact text and clicks submit
on GitHub. Signed update checks are the separate, intentional GitHub Releases
exception to the product's otherwise local runtime.

Consequences for the surrounding promises:

- **The CSP does not change for crash reporting.** The webview still does not
  send crash reports. The updater plugin reaches GitHub Releases outside the
  document-processing path to check and install signed app updates.
- **The "Telemetry: none" badge stays.** User-initiated reporting is not
  telemetry — nothing is collected in the background and nothing is ever sent
  automatically. The copy gains one honest clarifying line rather than a
  retraction: *no automatic data collection; nothing is ever sent
  automatically; after an unclean exit RaioPDF asks once (and you can turn the
  prompt off), and you review and submit each report yourself.* Applies to
  `README.md`, `SECURITY.md`, and `site/shared/COPY.md`. Note the copy must not
  call the feature "off by default" — the prompt appears by default; only the
  sending is opt-in.
- **No backend infrastructure and no data-retention policy** are introduced.
  This keeps the product consistent with its "no cloud, no account" identity and
  its personal-protest framing — a firm shouldn't have to trust a vendor's
  server for something this basic.

## Prompt & consent design (so the "opt-in" claim is real)

- The prompt appears **once**, on the next launch after an unclean exit, and is
  explicitly non-nagging: **[View exactly what will be sent] [Open GitHub issue]
  [Not now] [Never ask]**.
- Default is to send nothing. **"Never ask" persists** and suppresses all future
  prompts. "Not now" simply clears the pending marker.
- **View-exact-payload is mandatory, not a nicety.** The consent is only
  meaningful if the user can read the literal text before it leaves their hands.

## Alternatives considered

- **Macrify endpoint (phone-home).** Best UX, but it inverts the product's core
  claim, forces a visible CSP loosening, and requires standing up + maintaining
  a collector and retention policy. Rejected: the UX gain is not worth trading
  away the promise the whole product is built to make.
- **Email / mailto:.** No CSP change, but clunky, size-limited, and it exposes
  the user's own email address in the act of reporting a bug. Rejected in favor
  of the GitHub path, which keeps the reporter's contact details their choice.
- **Defer.** Reasonable, but the crash-marker and scrubber seams already exist
  from Phases 1–2, and a zero-infrastructure, telemetry-none-preserving path is
  available now — there's no positioning risk to resolve later. Rejected.

## Cost of the choice (stated honestly)

- Reporting is **not anonymous** and requires a GitHub account plus a
  click-through. That is the deliberate price of never phoning home.
- If field experience later shows that friction suppresses reports badly enough
  to matter, revisiting a true phone-home is a **product/positioning decision,
  not an engineering one** — and it must arrive as a new ADR that supersedes this
  one, alongside the CSP loosening and the copy rewrite it implies. It is not a
  change to make quietly.
