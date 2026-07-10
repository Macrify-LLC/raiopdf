# Table of Authorities

RaioPDF can scan the open PDF's text layer for cited authorities, show the
detected citations for review, and render a standalone Table of Authorities
locally in the browser process. The review step is deliberate: citation
detection is a helper, not the final legal judgment.

The workspace groups authorities as:

- **Cases**
- **Statutes**
- **Rules**
- **Constitutional Provisions**
- **Other**

Each detected row shows the canonical citation and the source document pages
where it appears. Before anything is rendered, the reviewer can:

- exclude a false positive;
- edit the canonical citation text;
- merge duplicate rows, unioning their page hits;
- add a missed authority manually with kind, citation, and pages;
- set the passim threshold for authorities cited on many pages.

The output flow mirrors the case caption tool:

- **Save as PDF** renders the reviewed table with the shared local engine
  renderer and sends the bytes through the existing save dialog.
- **Prepend to current PDF** renders the same bytes and inserts them at the
  front of the current standard in-memory PDF.

If the open document's hidden text layer is marked garbled, the workspace does
not run citation detection. It sends the user to the existing force-OCR flow so
the searchable text can be rebuilt first. Large streamed documents do not use
this browser-side byte flow yet; save/prepend from the workspace is limited to
standard in-memory documents.
