# RaioPDF — Roadmap

Where RaioPDF is headed. This is genuinely forward-looking work — the features
that already ship in the public alpha are documented in the
[README](https://github.com/Macrify-LLC/raiopdf#features), not here.

**How to read this:** no dates, and everything below can change. Items are
grouped by rough priority, not by calendar. If something you need is missing or
buried in "later," that's exactly the kind of thing worth telling us about — see
[Have an opinion?](#have-an-opinion) at the bottom.

---

## Now — what's getting attention

- **Smoothing the rough edges.** RaioPDF is a public alpha; the near-term focus
  is fixing what alpha users report and hardening the everyday paths.
- **Feature explainer videos.** A short video for each major feature — what it is
  and how to use it — embedded via YouTube right in the in-app help, so every
  tool is easy to learn.

## Next — lined up after that

- **More e-filing jurisdiction packs.** The alpha covers Florida, Federal
  CM/ECF, Georgia, and Indiana. Which jurisdictions come next will be driven by
  what people ask for.
- **Custom exhibit stamps.** Design your own digital exhibit sticker —
  "Plaintiff's Exhibit ___" with a number that advances automatically as you
  stamp — save it to a stamp gallery, and drop it onto a page. The e-sticker
  workflow that takes a tutorial and a hidden stamps folder in Acrobat, as a
  first-class tool.
- **Direct editing on very large PDFs.** Big documents that open streamed now
  get the full file-to-file toolset (split, extract, compress, OCR, and the
  rest — shipped in 0.1.3). The remaining gap is direct in-page editing and
  markup on those very large files, and closing it is a priority.
- **Deeper batch and production-set options** for firms working across large
  document sets.

## Later — planned, no date

- **Additional automations and workflows** — driven by what people request and
  whatever proves broadly useful.

## Considering — ideas, not commitments

These are on the table but not promised. Interest from users is what moves them
up.

- **Intel Mac support.** The macOS build targets Apple Silicon (M-series) today;
  Intel support depends on demand.
- **A mobile companion app (view + annotate).** A lower-capability build,
  Android tablets first, focused on what runs fully on-device: viewing,
  highlighting, handwritten ink notes, comments, bookmarks, stamps, and Bates
  numbering. The heavy engine work — OCR, PDF/A, compression, verified
  redaction, page surgery — would stay on desktop. Saving to OneDrive,
  SharePoint, Google Drive, or Dropbox would ride the device's own share sheet
  and file picker, so the app itself still never touches the network or asks
  for an account.
- Additional annotation and form-filling tooling.
- More document-assembly and packaging workflows for specific practice areas.
- Community-requested conveniences that fit the "free, local, no-nonsense" spirit
  of the project.

---

## Have an opinion?

This roadmap is shaped by what firms actually need.

- **Want a feature sooner — or at all?** Email **features@macrify.me**, or
  [open a GitHub issue](https://github.com/Macrify-LLC/raiopdf/issues).
- Bugs and general help: [GitHub Issues](https://github.com/Macrify-LLC/raiopdf/issues)
  or support@macrify.me.

RaioPDF is free and open source under GPL-3.0. What ships next is genuinely
influenced by what you tell us.
