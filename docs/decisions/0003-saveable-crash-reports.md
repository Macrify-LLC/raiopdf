# 0003 — Saveable crash reports for voluntary email submission

- Status: accepted
- Date: 2026-07-13
- Supersedes: 0002 — Opt-in crash reporting via a user-submitted GitHub issue
- Related: `apps/shell/src-tauri/src/diagnostics.rs`, `SECURITY.md`

## Context

ADR 0002 chose a user-submitted GitHub issue as the only crash-report path.
That preserved RaioPDF's **Telemetry: none** promise, but it excluded people
without GitHub accounts. The crash dialog has since shipped a second option:
save a report locally and attach it to a manual email.

The first implementation mistakenly saved the generic diagnostics export. That
file included version, platform, engine status, and scrubbed logs, but not the
structured crash record's signature and full captured backtrace. The email path
therefore omitted the details most useful for diagnosing the crash.

## Decision

Keep both voluntary reporting paths. A user may review the crash details and
either open a pre-filled GitHub issue or save a local report to email manually.
The saved file uses a versioned, human-readable envelope containing the app
version, OS and architecture, panic signature and location when available, full
captured backtrace, and scrubbed recent application-log lines.

The save-and-email path is voluntary and opt-in for each report. RaioPDF sends
nothing automatically, makes no crash-reporting network request, and does not
change its CSP. **Telemetry: none** remains accurate. A report that a user
chooses to email may be read and summarized to help triage the reported crash.

The generic **Export Diagnostics** command remains a separate option for broader
troubleshooting and does not replace the structured crash report.

## Consequences

- People can report crashes without a GitHub account while retaining control
  over the exact local file they share.
- Email reports now preserve the signature and captured backtrace instead of
  substituting a generic diagnostics dump.
- The envelope begins with `RAIOPDF-CRASH-REPORT/1`; changing its header order or
  named sections requires a new envelope version.
- Crash signatures, backtraces, and log tails continue through the existing
  diagnostic scrubber before display or save.
- Reports are not anonymous when emailed, because the sender chooses to use
  their own email account.

## Alternatives considered

- **Keep GitHub as the only path.** Rejected because it unnecessarily requires
  an account when a manual, local-save workflow preserves the same privacy
  posture.
- **Save the generic diagnostics export.** Rejected because it omits the
  captured backtrace and conflates two distinct troubleshooting artifacts.
- **Send reports automatically.** Rejected because it would break the explicit
  consent model and RaioPDF's zero-telemetry promise.
