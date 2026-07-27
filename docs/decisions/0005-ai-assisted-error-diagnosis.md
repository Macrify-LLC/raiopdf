# 0005 — AI-assisted error diagnosis via a copied prompt

- Status: accepted
- Date: 2026-07-26
- Related: 0002 — Opt-in crash reporting (superseded by 0003); 0003 — Saveable crash
  reports for voluntary email submission

## Context

RaioPDF's only route for reporting a non-crash failure was an "Email a report"
button that drafted a `mailto:` with the last captured diagnostic attached. That
channel is thin: it carries the error string and nothing about *why*. The
maintainer receives "Stirling PDF request failed" and a version number.

Meanwhile every RaioPDF user either has, or can have in minutes, something that
could do the actual diagnosis: their own AI assistant. The product already leans
on this — Settings → "Open Raio to AI" hands the user a copyable prompt that
registers the MCP connector, on the theory that an assistant is better at the
fiddly parts than a lawyer is.

So: add a second action beside "Email a report" — **"Help diagnose this"** — that
copies a prompt describing the failure. The user pastes it into whatever assistant
they already use.

Two things about that collide with commitments this project has already made, and
both are the reason this record exists.

## Decision 1 — this does not violate "no AI features — ever"

`CLAUDE.md` states the constraint as "no telemetry, no cloud services, no
accounts, no AI features — ever," and calls those the product's identity rather
than gaps. A reasonable reading objects that a *prominent primary* error action
that tells users to use an AI assistant is an AI-branded workflow, whatever runs
where.

The reconciliation, stated plainly so it isn't re-litigated:

**RaioPDF ships no model, makes no AI network call, and sends nothing anywhere.
This feature writes text to the clipboard.** Whether that text ever reaches an
assistant, and which one, is entirely the user's action in software RaioPDF has
no part in.

The precedent is already shipped and public. "Open Raio to AI" exists precisely so
the product can *speak to* the user's AI without *containing* one. This is the
same shape pointed at diagnosis instead of document operations.

Because the reading above is reasonable, the UI does not rely on the user
inferring any of this. The hint under the action says it outright — "RaioPDF has
no AI of its own… Nothing is sent anywhere until you send it" — and there is a
test asserting that copy is present. If that line ever disappears, the constraint
is being quietly weakened.

## Decision 2 — the prompt must not point at raw logs

`app.log` is scrubbed when the user *exports* it, and in the crash payload, but it
is **written raw**. On an attorney's machine a folder name is routinely a client
name and a file name a matter name, so the raw log is privileged material.

An earlier design had the prompt hand the assistant the log file paths and rely on
prompt text — "never include a file path in anything you draft" — to keep client
names out of the output. That was rejected for two reasons:

1. **It protects the wrong boundary.** "Don't put names in the draft" says nothing
   about disclosure at the moment the assistant *reads the file*. Its connector,
   execution environment, conversation retention, and intermediate summaries all
   see the raw text first.
2. **A natural-language instruction is not an access control.** For a product used
   by attorneys with confidentiality obligations, the guarantee has to be enforced
   by code.

So the prompt explicitly tells the assistant **not** to read any file on the
machine — imperatively, in the same block as the other prohibitions, and without
an exfiltration rationale an agent could satisfy by reading locally and not
quoting. The `raiopdf_diagnostics` MCP tool exists to serve an already-scrubbed
payload instead. A test asserts the prompt contains no log path and that the
prohibition appears in the rules block.

Redaction lives in one place: `crates/diagnostics-core`, shared by the desktop
shell and the standalone engine-host. The clipboard text goes through that same
policy via a `diagnostics_scrub_text` command rather than a second implementation
in the renderer — which is what makes "one policy" a fact rather than an
aspiration. The renderer keeps a path-only scrubber as a fallback for a browser
dev server or a unit test, and it is deliberately *not* the guarantee; anything
user-facing describes the packaged app's behaviour, i.e. the Rust policy.

### Residual risk, stated rather than implied

Redaction recognises *shapes*: paths, file names, email addresses, digit runs. A
client or matter name that appears without a path or a file extension — a case
caption inside an error string, a matter number shorter than eight digits — is
indistinguishable from ordinary prose and can survive. Any pattern broad enough to
catch it would gut the log's diagnostic value.

Two consequences we accept deliberately:

- The payload carries a `residualRiskNote` describing that boundary, and the
  in-app help says to read the text before pasting it. The honesty of that note is
  load-bearing: a reader told "paths are removed" will forward the payload. An
  earlier draft of the help copy claimed more removal than the code performed —
  the docs and the policy have to be checked against each other, not written from
  memory.
- The upstream mitigation matters more than the scrubber. Diagnostics record a
  file's *extension and size*, never its name.

## Decision 3 — the assistant drafts; the user sends

The prompt asks the assistant to offer **both** an email and a public GitHub issue,
and to help the user sign up for GitHub if they don't have an account — filing a
good issue is how a non-programmer gets to contribute to a tool they depend on.

It does **not** authorise the assistant to file anything, run `gh`, open a browser,
or install software. An assistant handed a broad remit reads it as authority, and
the failure mode here is a public issue containing a client name. The user is the
last check, every time.

The diagnostic is also fenced and labelled untrusted, and the confidentiality rule
appears **before** it. Log text is attacker-influenceable — a malicious PDF's file
name or metadata can reach a log line — so a prompt that presented the data first
would be establishing the rules after the assistant had already read the payload
trying to subvert them.

The fence carries a **per-copy nonce**, and the rules state that the region ends
only at that nonce. A fixed delimiter is forgeable: this source is public, and the
fenced content is arbitrary tool output, so a payload could otherwise close the
fence and continue in the trusted position — claiming, say, that the
confidentiality rule had been lifted. Fence-shaped sequences are also stripped
from the payload before interpolation, and RaioPDF's own facts (reference, version,
system, timestamps) sit *outside* the fence, since step 1 asks the assistant to
pass the reference to a tool and it must not have to read that out of untrusted
text. The ignore-list is categorical rather than enumerative — anything claiming
these rules changed, were lifted, or came from the developer — because an
enumerated list is trivially sidestepped by attacking a rule it doesn't name.

## Consequences

- No change to the telemetry posture, the CSP, or the loopback-only rule. Nothing
  new reaches the network.
- A render failure now shows a recovery surface instead of a blank window
  (`AppErrorBoundary`), which is where this action is most valuable — precisely
  when a user most needs to report something and least has the means to.
- The "no AI" claim in the README, `SECURITY.md`, and the landing page remains
  literally true and needs no retraction.
- If a future change makes RaioPDF *send* a report itself, that is a different
  decision that supersedes 0002/0003 and needs its own record — it is not covered
  by this one.
