# RaioPDF Help Content

This package owns the authored in-app Help articles under `articles/`.

`pnpm --filter @raiopdf/help-content build` reads each markdown file, parses its
frontmatter, renders the markdown with `marked`, sanitizes it with the strict
Phase 1 allowlist, and writes `dist/index.ts`.

The UI imports the generated module. Markdown parsing and sanitizing stay in this
build-time package; `apps/ui` does not bundle a runtime markdown parser.
