---
id: report-a-problem
title: Report a problem
group: getting-started
summary: Two ways to tell us something went wrong — email it, or hand it to your own AI assistant to diagnose first.
order: 30
---

# Report a problem

RaioPDF is free, and it's early. When something doesn't work, telling us is the
most useful thing you can do — the next attorney who hits the same wall never
sees it.

When an error appears, you'll usually see two buttons under the message.

## How to do it

1. **Email a report** opens your own email program with the technical details
   already filled in. Nothing sends until you press send, and you can edit
   anything first.
2. **Help diagnose this** copies a written description of the problem to your
   clipboard. Paste it into whichever AI assistant you already use. It will read
   the error, tell you in plain language what went wrong, and then offer to draft
   either an email or a public bug report for you to send.
3. If it offers to file a public bug report and you don't have a GitHub account,
   let it walk you through signing up. It's free and takes about two minutes.

## What to know

- **RaioPDF has no AI in it.** "Help diagnose this" only puts text on your
  clipboard. Nothing is sent anywhere, by RaioPDF or by anyone else, unless you
  paste it somewhere and choose to send it.
- **What gets included.** The version of RaioPDF, your operating system, and the
  technical details of the failure. Before anything reaches your clipboard,
  RaioPDF removes file paths — including network-share paths — along with file
  names, email addresses, and number patterns that look like Social Security,
  phone, or account numbers. Timestamps are deliberately kept, so whoever reads
  it can tell what happened in what order.
- **That removal isn't perfect, so read before you paste.** It recognises
  patterns rather than reading meaning. A client or matter name written as
  ordinary words — a case caption inside an error message, a matter number
  shorter than eight digits — can still slip through. Have a look at what you're
  pasting, the same way you'd glance at an attachment before sending it.
- **A public bug report is public.** Anyone can read it. The assistant is asked
  to keep names out of it, but you're the last check.
- **Your files aren't involved.** No document is ever attached, uploaded, or
  copied anywhere as part of a report.
- **If you'd rather your assistant see more detail,** you can turn on the
  optional connector in Settings → "Open Raio to AI". Your assistant can then ask
  RaioPDF for its own recent activity log — still on your machine, and with the
  same removal applied before it hands anything over. The copied prompt tells your
  assistant not to go reading files on your computer either way.

## Related

- [Your data never leaves your computer](tool:data-stays-local)
- [Getting started](tool:getting-started)
