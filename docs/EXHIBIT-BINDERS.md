# Exhibit Binders and Slip Sheets

RaioPDF can assemble a main document and ordered exhibit PDFs into one bookmarked
binder. Each exhibit can be stamped, listed in the generated exhibit index, and
optionally preceded by a slip sheet.

Slip sheets have three cover styles:

- **Minimal**: centered exhibit label only. This is the default and preserves the
  original binder output.
- **Labeled**: centered exhibit label with the exhibit description beneath it.
- **Bordered**: exhibit label and description inside a simple rule.

The same cover renderer is used for binder slip sheets, cover-style previews, and
the Organize Pages **Insert Slip Sheet** action so generated pages match their
previews. Insert Slip Sheet is available for standard in-memory documents only in
this version; streamed large-document insertions still use file-based inserts.
