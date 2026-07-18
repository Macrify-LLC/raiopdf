# RaioPDF — Frequently Asked Questions

A free, fully-local desktop PDF suite for law firms. If your question isn't
answered here, [open a GitHub issue](https://github.com/Macrify-LLC/raiopdf/issues)
or email support@macrify.me.

- [The basics](#the-basics)
- [Your files & privacy](#your-files--privacy)
- [Installing & platforms](#installing--platforms)
- [What it does](#what-it-does)
- [AI & MCP](#ai--mcp)
- [Trust & legal](#trust--legal)
- [Support & contributing](#support--contributing)

---

## The basics

### Why is it named "RaioPDF"?

"Raio" is Portuguese for a ray of sunlight — and I'm more of a fan of sunlight
than I am of clouds.

### What is RaioPDF?

A desktop PDF program that does the things you use Acrobat for every day —
view, organize, OCR, annotate, fill forms, sign — plus the legal-specific
workflows a law practice actually needs: verified redaction, Bates numbering,
e-filing prep, and exhibit binders. It runs entirely on your own computer.

### If you're an attorney, why are you making this, and why is it free?

Because it was a lot of fun, because Acrobat is the most bloated software I use
on a day-to-day basis, because it wasn't that hard, and because it serves as an
advertisement for my custom software services. In that order.

(There's a longer version of the why in the
[README's "philosophy" section](https://github.com/Macrify-LLC/raiopdf#the-philosophy).)

### Is it really free? What's the catch?

Free, permanently. No account, no subscription, no trial that expires, no
watermarks, no nag screens. There isn't a paid tier hiding behind the free one —
this is the whole thing. It's built and given away by [Macrify LLC](https://macrify.me).

### Is it open source? What license?

Yes. RaioPDF is licensed under GPL-3.0, and the source lives at
[github.com/Macrify-LLC/raiopdf](https://github.com/Macrify-LLC/raiopdf). It
bundles some third-party components under their own licenses (the MIT-licensed
Stirling-PDF engine, Tesseract, PDF.js, Ghostscript, and others) — see
[`licenses/THIRD-PARTY.md`](licenses/THIRD-PARTY.md) for the full notices.

---

## Your files & privacy

### Does RaioPDF upload my files anywhere?

No. Every operation — including OCR — runs on your machine. Your documents are
never uploaded, and the parts of the app that touch your PDFs never talk to the
internet at all.

### Is it really offline?

The document work is. The only thing RaioPDF does automatically over the
network is check GitHub for a newer signed version of the app itself. That check
sends nothing about your files — no names, no contents, no usage data — it just
asks "is there a newer release?" the same way your browser would if you visited
the releases page.

### What about crash reports — isn't that "phoning home"?

Nothing is sent automatically. If RaioPDF ever crashes, it asks you once whether
you'd like to report it, and you choose how: either open a pre-filled GitHub
issue in your browser, or save the report to a file you can email in yourself.
Either way you review every word before anything leaves your machine, and you
can turn the prompt off entirely in Settings.

### Do you collect any telemetry or analytics?

None. There's no background analytics, no tracking, no profiling — in the app or
built into it. "No telemetry" is part of the product's identity, not a setting
we might change later.

---

## Installing & platforms

### What do I need to run it?

A Windows PC, or a Mac with Apple Silicon (an M-series chip). On either platform
the installer bundles everything it needs (the PDF engine, the OCR toolchain), so
there's no Docker, Java setup, or separate downloads. (Intel Macs aren't
supported yet.)

### Is there a Mac version?

Yes. RaioPDF runs on Windows and on Macs with Apple Silicon (M-series chips). The
macOS build is Developer ID-signed and notarized by Apple, so it opens without any
Gatekeeper workaround. Intel Macs aren't supported yet — see the
[roadmap](ROADMAP.md).

### Where do I download it, and is it safe?

The only official place to download RaioPDF is
[GitHub Releases](https://github.com/Macrify-LLC/raiopdf/releases). The Windows
installer is code-signed; the macOS build is Developer ID-signed and notarized.
It's a **public alpha**, so treat it as early software —
usable and versioned, but expect rough edges, and please
[report anything that breaks](https://github.com/Macrify-LLC/raiopdf/issues).

### How do updates work?

The app checks GitHub Releases for a newer signed build and lets you update when
one is available. You're always getting builds from the same official source —
nothing auto-installs behind your back.

---

## What it does

### Can it replace Adobe Acrobat?

In my opinion, yes — for 99% of what I do with PDFs. Plus it has legal workflows
and features that either don't exist in Acrobat or are buried under confusing,
technically worded menus. But you don't have to take my word for it: it's
literally free and doesn't require a signup or anything.

### Does it do OCR? Offline?

Yes — "Make Searchable" runs OCR entirely on your machine, no upload and no wait
on a server. RaioPDF is also honest about the result: the status bar tells you
whether a document's text layer is verified searchable, missing, or garbled, and
"Fix garbled text" rebuilds a bad text layer offline rather than pretending a
scan is searchable when it isn't.

### What legal-specific features does it have?

- **Prepare for Filing** — normalize pages to a court's e-filing requirements and
  split an oversized file into properly labeled, sequential, portal-compliant
  parts, with a rule-cited preflight report.
- **Exhibit binders** — assemble a motion or brief with exhibits in order,
  auto-stamped ("Exhibit A," configurable) and auto-bookmarked.
- **Bates numbering** across an entire document set in one pass.
- **Production sets** — Bates-numbered discovery productions with confidentiality
  designations, index files, and volume splits.
- **Filing packet builder** — a multi-document filing assembled as one packet
  with a manifest and the document-level checks a court expects.
- **True redaction**, **sensitive-info scanning**, **metadata scrubbing**, and
  **batch cleanup** across many files at once.

### Does it do *real* redaction? How do I know the text is gone?

Yes. Redaction actually removes the underlying content — it isn't a black box
drawn over text that's still sitting underneath. RaioPDF then verifies the result
by re-extracting the text, and the verifier is garble-aware, so a broken text
layer can't fake a clean pass. If verification fails, no redacted file is written
at all.

### Can it add password protection / encrypt a PDF?

Yes, in the installed desktop app. **PDF Security** creates a separate AES-256
protected copy with an open password. It can include your current unsaved edits,
while the original file stays open and unchanged.

You can allow or restrict printing and copying, but those PDF permissions are
advisory and some readers may ignore them. The open password is the part that
encrypts the file.

RaioPDF does not store or recover the password. Keep it somewhere safe and,
when practical, send the PDF and password through different channels.

RaioPDF blocks protection when it finds a digital signature. For a PDF/A file,
it asks you to confirm that the protected copy will no longer be PDF/A. You can
also use **Save Unlocked Copy**, leaving the protected original unchanged.

### Which courts / jurisdictions does the e-filing prep support?

RaioPDF was built with Florida courts in mind — Florida is the default — but the
document preparation itself is fully configurable. It ships preset defaults for a
handful of courts (Florida, Federal CM/ECF, Georgia's eFileGA and PeachCourt, and
Indiana's IEFS), and those presets are **purely advisory**: they pre-select
sensible steps and cite the authority behind each requirement, but nothing is
enforced or locked. You can toggle any prep step and override the settings — page
size, file-size caps, and the rest — for your own court or for a single run. It's
guidance to check your work against, not a gate. More presets are on the
[roadmap](ROADMAP.md); if you'd like yours added, let us know (see
[Support](#support--contributing)).

---

## AI & MCP

### Does RaioPDF use AI?

No. My experience lends me to believe that forcing AI into every product is an
annoyance, not a feature. Instead, Raio is meant to work directly with AI you
already provide, if you so choose.

### Then what's this "MCP" thing I've seen mentioned?

RaioPDF ships an **off-by-default** connector that lets *your own* AI agent
(Claude Desktop, Claude Code, etc.) run RaioPDF's supported local tools over the
[Model Context Protocol](https://modelcontextprotocol.io). So there's no AI
*inside* RaioPDF, but if you already use an AI assistant, you can point it at
RaioPDF's toolbox — OCR, verified redaction, Bates, binders, production sets,
filing preflight, and more. It's disabled until you turn it on. See
[`docs/MCP.md`](docs/MCP.md).

### If I connect an AI agent, does my data stay local?

Yes — the RaioPDF side still runs entirely on your machine. What your AI
assistant itself does with the results is governed by whichever assistant you're
using, so choose one you trust.

---

## Trust & legal

### Is the e-filing / sensitive-info help legal advice?

No. The jurisdiction packs, preflight reports, and scanners are **guidance, not
legal advice** — tools to help you check your own work. You're still responsible
for what you file.

### Can I trust the sensitive-info scanner to catch everything?

Treat it as **assistive only**. It flags likely SSNs and account numbers (in the
spirit of Florida's rule on minimizing sensitive information in filings), but you
should never rely on automated detection for legal judgment — verify before you
file.

---

## Support & contributing

### I found a bug or want a feature — where do I go?

[GitHub Issues](https://github.com/Macrify-LLC/raiopdf/issues) is the primary
place for both — but for a bug, it's worth skimming the [pinned Known Issues
list](https://github.com/Macrify-LLC/raiopdf/issues/158) first, since the rough
edge you hit may already be tracked (👍 it there to help me prioritize). If you'd
rather email a feature idea, send it to features@macrify.me; for help using the
app, support@macrify.me (best-effort — this is free, community-supported
software).

### Can I contribute?

Yes — see [`CONTRIBUTING.md`](CONTRIBUTING.md). It's GPL-3.0 and developed in the
open.

### Is there commercial / paid support?

No SLA-backed support tier. RaioPDF is a free public tool; help is best-effort
through GitHub Issues and email.
