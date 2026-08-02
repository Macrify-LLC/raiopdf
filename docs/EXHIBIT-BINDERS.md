# Exhibit Binders and Slip Sheets

RaioPDF can assemble a main document and ordered exhibit PDFs into one bookmarked
binder. Each exhibit can be stamped, listed in the generated exhibit index, and
optionally preceded by a slip sheet.

## Exhibit labels

Each stamped page gets the exhibit's label at the placement the binder options
name (`placement` edge/align, `marginIn`), on the pages `stampPages` selects.
There are two renderings:

- **Text label** (default): a single line of text drawn against the visual page
  edge, shrunk to fit the page width.
- **Stamp design** (`PdfBinderOptions.stampDesign`): the label is drawn as an
  exhibit sticker — fill, border, corner rounding, font, and centered label —
  through the same `drawStamp` renderer the placed Exhibit Stamp tool uses, so a
  design previewed in the stamp gallery renders identically in a binder. The
  sticker box is laid out against the upright page and mapped back into user
  space, so rotated exhibit pages read the same as upright ones.

`stampDesign` carries **appearance only** — sizes, colors, font face. It has no
template id and no counter: the label text always comes from the exhibit's own
`label` (and `labelLines`, the same label split into rendered lines for a stacked
sticker). That keeps the binder's numbering entirely binder-controlled, so
building a binder never consumes an exhibit-stamp template's running count.

Both renderings are **baked into page content**, not live annotations — binder
output has always been flat.

`stampDesign` is deliberately absent from the MCP `build_binder` schema: stamp
designs are an in-app concept, and the MCP surface accepts only the options it
declares.

Slip sheets have three cover styles:

- **Minimal**: centered exhibit label only. This is the default and preserves the
  original binder output.
- **Labeled**: centered exhibit label with the exhibit description beneath it.
- **Bordered**: exhibit label and description inside a simple rule.

The same cover renderer is used for binder slip sheets, cover-style previews, and
the Organize Pages **Insert Slip Sheet** action so generated pages match their
previews. Insert Slip Sheet is available for standard in-memory documents only in
this version; streamed large-document insertions still use file-based inserts.
