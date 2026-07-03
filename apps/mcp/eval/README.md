# RaioPDF MCP — evaluations

Task-based evaluations that check whether an AI client can drive the connector to
a correct, verifiable answer — complementing the unit/integration tests in
`test/` (which run in CI).

## Fixtures

Deterministic sample PDFs live in `fixtures/`. Regenerate them with:

```
node eval/make-fixtures.mjs
```

- `three-pages.pdf` — 3 pages, letter portrait, searchable
- `five-pages.pdf` — 5 pages, letter portrait, searchable
- `letter-portrait.pdf` — 1 page, 8.5 × 11 in, searchable
- `legal-size.pdf` — 2 pages, 8.5 × 14 in (non-standard for e-filing)

## Questions

`evaluation.xml` holds 10 question/answer pairs in the format the
`mcp-builder` skill expects. Each answer is stable and string-comparable.

## Running

To run the evals, point an MCP evaluation harness at the built connector
(`raiopdf-mcp`) with the `Open Raio to AI` gate enabled, supply `fixtures/` as
absolute paths and a writable temp directory for tool outputs, and compare each
tool result against the expected answer.

Which questions need the engine host (Stirling sidecar):

- **No sidecar** (in-process pdf-lib / rules engine): the `extract_pages`,
  `build_exhibit_binder`, and `prepare_for_filing` questions.
- **Needs the engine host**: the `pdf_page_count`, `merge_pdfs`, and
  `rotate_pages` questions route through the sidecar, so those require the engine
  host to be reachable.
