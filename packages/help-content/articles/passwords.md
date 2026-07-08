---
id: passwords
title: Passwords
group: legal
summary: Password protection isn't available in this build yet.
order: 90
---

# Passwords

Password protection isn't available in this build yet. You'll see the controls
in the **Passwords** panel, but they're turned off for now.

## What it's meant to do

When it's ready, this is where you'll set an open password on a PDF — the
password someone needs to open it — and control whether the file can be printed
or copied from.

## Why it's not here yet

RaioPDF can't yet encrypt a file, so there's no safe way to actually protect one
with a password. Rather than pretend, the controls are shown but disabled. If you
open **Document Properties**, a PDF will always report as "Not encrypted" for the
same reason.

We'd rather leave it off than ship a lock that doesn't lock.

## Related

- [Scrub Metadata](tool:scrub-metadata) — remove hidden information before sharing
- [Sanitize](tool:sanitize) — strip hidden active content before sharing
