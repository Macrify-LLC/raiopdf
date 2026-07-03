---
id: data-stays-local
title: Your data never leaves your computer
group: getting-started
summary: Every document operation runs on your own machine. Your files aren't uploaded, and there's no account.
order: 20
---

# Your data never leaves your computer

RaioPDF does its work on your own machine. Your documents aren't uploaded, and
there's nothing to sign into.

## What runs on your machine

Everything you do to a document — opening, editing, organizing, redacting, Bates
numbering, scrubbing metadata, even OCR — happens on your computer. The steps
that need a heavier engine run a small helper alongside the app that only your
own computer can reach. Nothing is sent to an outside server.

## OCR is on your machine too

Making a scanned PDF searchable normally means uploading it somewhere. RaioPDF
does it locally, with a built-in text-recognition toolchain. The pages never
leave your computer.

## No tracking

RaioPDF collects no analytics and sends no usage data. If you ever export a
diagnostics file to troubleshoot a problem, it's saved to your computer and not
sent anywhere.

## "Open Raio to AI" is off unless you turn it on

RaioPDF has no AI of its own. There is an optional setting that lets *your* own
AI assistant use RaioPDF's tools. It's **off** by default, and even when you
turn it on, it talks only to the AI program you connected — over a direct
on-device channel, not the internet.

## The one thing that can reach out

To be straight with you: RaioPDF can check whether a newer version has been
released, from the project's official releases. That check is the only part that
reaches the internet, and it's about the app itself — never your documents.

## Related

- [Getting started](tool:getting-started)
- [Make Searchable (OCR)](tool:make-searchable) — offline text recognition
