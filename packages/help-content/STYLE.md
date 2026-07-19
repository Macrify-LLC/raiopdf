# Help content — style checklist

Every RaioPDF help article is written for a **lay audience**: an attorney, paralegal,
or office staffer who is good at their job and does **not** write code or think about
PDFs as a technical object. Write like the one-pager a partner reads before a meeting,
not like documentation for an engineer.

Run every article against this list before it ships.

## Voice

- [ ] **Lead with the task, in the reader's words.** The first sentence says what they
      get done ("Permanently remove text so it's truly gone"), not what the feature is
      ("The redaction subsystem…").
- [ ] **Show the actual clicks.** "Open the PDF, choose **Legal → Redact**, drag a box
      over each thing to remove." A reader should be able to picture themselves doing it.
- [ ] **Plain words.** No "normalize," "rasterize," "extract," "metadata" without an
      inline, one-clause definition the first time ("metadata — the hidden info a file
      carries about who made it and when").
- [ ] **Short sentences. Short paragraphs.** Two or three sentences per paragraph.
- [ ] **You, not the user.** Address the reader directly.

## Substance

- [ ] **Every claim is true of the current app.** If the app doesn't do it, don't say it.
- [ ] **No claims beyond the approved marketing copy** (`site/shared/COPY.md`). Help
      explains; it doesn't sell.
- [ ] **Legal-safety caveats are mandatory where they apply.** The sensitive-info scanner and
      anything assistive says, in plain words, "this is a helper — always check it
      yourself before you rely on it." Never imply the software makes the legal call.
- [ ] **Name the permanent/irreversible steps.** If an action can't be undone, say so
      before the reader does it.

## What NOT to do

- [ ] No fear framing ("never miss…", "don't lose…") and no superlatives
      ("powerful," "seamless," "game-changing") — org rule. Let the task speak.
- [ ] No screenshots that will rot; describe the on-screen labels in text instead.
- [ ] No jargon dressed up as friendliness ("simply just click…"). Cut "simply,"
      "just," "easily."

## Shape of a good article

1. **One-line summary** (the frontmatter `summary`) — what you get done.
2. **Why you'd use it** — one short paragraph, in the reader's situation.
3. **How to do it** — numbered steps with the real button names in **bold**.
4. **What to know** — the one or two things that matter (a caveat, what's permanent,
   what it checks for you).
5. **Related** — links to sibling articles with `[label](tool:<id>)`.
