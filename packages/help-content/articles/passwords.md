---
id: passwords
title: PDF Security
group: legal
summary: Create a copy that needs a password to open, or save an unlocked copy.
order: 90
---

# PDF Security

Create a separate, password-protected copy of the PDF you have open. RaioPDF
uses strong AES-256 encryption and leaves the original file unchanged. Use this
when you need to share a PDF while limiting who can open it.

## Create a protected copy

1. Open the PDF.
2. Choose **Legal → PDF Security**.
3. Enter the **Open password** twice. Use at least 8 characters; RaioPDF
   recommends 12 or more.
4. Leave **Allow printing** and **Allow copying** on, or turn either one off.
5. Click **Create Protected Copy** and choose where to save it.
6. When verification finishes, choose **Open Protected Copy** if you want to
   switch to it.

The protected copy includes edits that have not yet been saved to the original.
The original stays open, keeps its current unsaved state, and is never replaced.

## Printing and copying

The open password encrypts the file. The printing and copying settings ask PDF
programs to limit those actions, but some programs may ignore the request.
Accessibility access remains available.

## Save an unlocked copy

Open **PDF Security** for a protected PDF that RaioPDF has unlocked. Choose
**Save Unlocked Copy** to write a separate copy without encryption. The protected
original is not changed.

## Passwords and file types

- **RaioPDF does not store or recover passwords.** Keep yours somewhere safe.
  When practical, send the PDF and its password through different channels.
- **Digitally signed PDFs are blocked.** Rewriting one could invalidate its
  signature. Protect the PDF before signing it.
- **PDF/A needs confirmation.** PDF/A is a format meant for long-term archiving,
  and it does not allow encryption. RaioPDF asks before continuing, and the
  original PDF/A file stays untouched.
- **Protection does not clean the PDF.** Metadata — hidden details such as the
  author and the software that made the file — is encrypted, not removed.
  Use **Scrub Metadata** or **Sanitize** separately when you need those changes.
- **This is an installed-app feature.** It is not available in the browser
  help preview or through RaioPDF's AI connector.

## Related

- [Scrub Metadata](tool:scrub-metadata) — remove hidden information before sharing
- [Sanitize](tool:sanitize) — strip hidden active content before sharing
