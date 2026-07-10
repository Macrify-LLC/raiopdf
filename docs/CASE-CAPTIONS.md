# Case Captions and Cover Pages

RaioPDF can make a one-page case caption from matter details you type once. The
desktop app renders the caption locally in the browser process, using the same
caption renderer as the local engine tools. The preview, style thumbnails, saved
PDF, and prepended page all come from that shared renderer.

The workspace includes four caption styles:

- **Classic boxed**: a traditional party block inside a rule.
- **Underlined parties**: open party text with a separator rule.
- **Centered federal**: centered party block with the case details to the right.
- **Minimal**: title-forward layout for short cover pages.

Case profiles are stored on the local computer under their own app storage key,
`raio.caseProfiles.v1`. They hold the caption fields and the preferred style for
that matter. They are separate from filing preferences, which are court/portal
settings.

From the workspace, a caption can be:

- saved as its own PDF;
- prepended as page 1 of the current standard in-memory PDF;
- used as a clearly labeled front-matter step before adding the result to a
  binder or filing packet.

Large streamed documents still use file-to-file path operations for document
mutation. In this version, caption prepend is limited to standard in-memory
documents; saving the caption as a separate PDF remains available.
