# Security Policy

RaioPDF runs document operations entirely on your own machine — there's no server, no account, and no automatic data collection. Nothing about your PDFs or usage is ever sent automatically. The desktop app does check GitHub Releases for signed updates, and an update install downloads the signed installer from GitHub. The only other thing that can ever leave your machine is a crash report you choose to send: after an unclean exit RaioPDF may ask (once) whether you want to report it, and if you say yes it opens a pre-filled GitHub issue for you to review and submit yourself — RaioPDF never sends anything for you, and you can turn the prompt off entirely. That said, it's still software that opens untrusted PDF files and runs a bundled OCR/PDF engine, so security issues (memory-safety bugs, path traversal, malicious-file handling, credential leaks in the installer/signing pipeline, updater signing problems, etc.) are treated seriously.

## Reporting a vulnerability

**Preferred: GitHub Private Vulnerability Reporting.** This repo has it enabled — go to the [Security tab](https://github.com/Macrify-LLC/raiopdf/security/advisories/new) and click "Report a vulnerability." This opens a private draft advisory only you and the maintainer can see, and lets us coordinate a fix and disclosure before anything is public.

**Alternative:** email **jake@macrify.me** with a description of the issue, steps to reproduce, and (if applicable) a proof-of-concept file. Please don't open a public GitHub issue for anything that could be exploited before a fix ships.

## What to expect

- Acknowledgement within a few business days.
- This is a public alpha, solo-maintained project — there's no formal SLA, but security reports get priority over feature work.
- Credit in the fix's release notes / advisory, if you'd like it.

## Supported versions

Public alpha: the latest `0.1.x` release and `main` are supported. Security fixes are shipped in the next alpha release unless the issue requires a faster advisory.

## Scope

In scope: the Tauri shell (`apps/`), the bundled engine sidecar (`engine/`, `packages/engine-sidecar`), the installer/signing pipeline (`installer/`), and shared packages (`packages/`).

Out of scope: the upstream Stirling-PDF engine itself (report those upstream at [Stirling-Tools/Stirling-PDF](https://github.com/Stirling-Tools/Stirling-PDF)), and the marketing site (`site/`) unless the issue exposes user data (it collects none by design).
