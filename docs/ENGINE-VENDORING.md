# Engine Vendoring — Stirling-PDF MIT-Core Backend

> Verified 2026-07-02 against a shallow clone at tag **v2.14.0** / commit
> **41f1cb2c22b8b117eb07f4cc0cf88c8a782c4a50**, including a successful
> local build of the core-flavor JAR and a live endpoint smoke test. This document drives
> the engine-bundling phase; re-verify on every version bump.

## Table of Authorities - reporter data

Verified 2026-07-10 over the network against the current upstream `main` branches:

| Source | Commit read | License finding | GPL-3.0 compatibility | URLs read |
|---|---:|---|---|---|
| Free Law Project `reporters-db` | `bcae37078404302fe452d6c0d111845777af95b1` | BSD 2-Clause License, SPDX `BSD-2-Clause`. The `LICENSE` file contains the two-clause BSD grant, and the README's license section says the repository is available under a permissive BSD license. | Compatible. BSD-2-Clause is permissive and can be included in a GPL-3.0 work when the BSD notice and conditions are preserved. | `https://raw.githubusercontent.com/freelawproject/reporters-db/bcae37078404302fe452d6c0d111845777af95b1/LICENSE`; `https://raw.githubusercontent.com/freelawproject/reporters-db/bcae37078404302fe452d6c0d111845777af95b1/README.rst` |
| Free Law Project `eyecite` | `09165c2d90b4295b4967b1b01b83963c37ab2a98` | BSD 2-Clause License, SPDX `BSD-2-Clause`. The `LICENSE` file contains the two-clause BSD grant. | Compatible. BSD-2-Clause is permissive and can be included in a GPL-3.0 work when the BSD notice and conditions are preserved. | `https://raw.githubusercontent.com/freelawproject/eyecite/09165c2d90b4295b4967b1b01b83963c37ab2a98/LICENSE` |

Path taken: clean permissive-license path. The rules package vendors a minimized
`reporters-db` slice at `packages/rules/src/authorities/data/reporters.generated.json`.
No `eyecite` code, Python, data, or citation patterns are vendored in this phase.

Included data: reporter lookup abbreviation keys, edition abbreviation keys, reporter
variation keys, canonical reporter abbreviations, reporter full names, local `kind: "case"`
classification, and edition abbreviation lists. Excluded data: examples, regexes, date
ranges, notes, links, publisher metadata, MLZ jurisdiction metadata, and cite-type nuance
beyond the local case-reporter classification. Source data URL:
`https://raw.githubusercontent.com/freelawproject/reporters-db/bcae37078404302fe452d6c0d111845777af95b1/reporters_db/data/reporters.json`.

## Recommendation

**Pin `v2.14.0` and commit `41f1cb2c22b8b117eb07f4cc0cf88c8a782c4a50`, and build with `STIRLING_FLAVOR=core`. Do NOT pin a v1.x tag.**

- v2 has a first-class three-way flavor switch in `settings.gradle` — `core | proprietary
  (default) | saas` — via the `STIRLING_FLAVOR` env var. `core` sets
  `disableAdditional=true`, which drops `implementation project(':proprietary')` from
  `app/core/build.gradle`, drops the `bootJar dependsOn ':proprietary:jar'`, and never
  includes `:saas`.
- The verified core-flavor bootJar contains **zero** classes/jars matching `proprietary`
  or `saas`; startup logs `Without additional features in jar`. There are zero
  `import stirling.software.proprietary` statements in `app/core` or `app/common` —
  proprietary presence is detected only via a runtime classpath check.
- v1.x is NOT cleaner: `v1.6.0` includes `app/proprietary` **unconditionally** in
  `settings.gradle`. The truly all-MIT tree predates the open-core split (~v0.4x) and
  lacks the v2 job framework and current API. All operations RaioPDF needs exist in core
  at v2.14.0.
- License: root `LICENSE` is MIT with carve-outs only for the excluded dirs, and
  explicitly anticipates their removal ("if that directory exists"). The open-source core
  has no user limit.

## Vendoring / scrub procedure

Delete from the vendored tree: `app/proprietary/`, `app/saas/`, `engine/`,
`frontend/portal/`, `frontend/editor/src/{desktop,proprietary,saas,cloud,prototypes}`.

Gradle 9 refuses missing project dirs, so apply this one patch to `settings.gradle`
(verified failure without it, verified fix with it):

```groovy
include 'stirling-pdf', 'common'
project(':stirling-pdf').projectDir = file('app/core')
project(':common'      ).projectDir = file('app/common')
if (!disableAdditional) {
    include 'proprietary'
    project(':proprietary').projectDir = file('app/proprietary')
}
```

Keep the patch as a committed patch file + scrub script; reapply on every upstream bump. Update `engine/PINNED_TAG`, `engine/PINNED_COMMIT`, and `engine/PINNED_SETTINGS_GRADLE_SHA256`; resolve annotated tags with the peeled `refs/tags/<tag>^{}` commit when present, otherwise use the tag ref SHA:

### Functional patches (`engine/patches/`)

Beyond the settings-plumbing patch, the pipeline can carry **functional patches**
to upstream behavior, governed by `docs/decisions/0003-functional-engine-patches.md`.
The short rules: every functional patch is an upstream candidate destined for
deletion once a pinned release contains the fix; MIT-core files only; git-diff
format in `engine/patches/*.patch`, applied in sorted order after
`settings-gradle.patch`; every modified file pinned by post-patch SHA-256 in
`engine/PINNED_PATCHED_FILES_SHA256` (which also drives the worktree-status
allowlists in `vendor.sh`/`build.sh`); and every patch exercised by an
`engine/verify-live.sh` check that fails on an unpatched engine.

Current functional patches:

| Patch | What it fixes | verify-live check | Upstream status |
|---|---|---|---|
| `pdfjson-image-passthrough.patch` | `/edit-text`'s PDF→JSON→PDF round trip decodes and re-encodes every image XObject (`encodeImage` → `ImageIO`), causing JPEG generational loss and CCITT/JBIG2 format swaps even on zero-match edits. The patch threads a `preserveImageStreams` flag so the internal edit-text round trip keeps raw image streams byte-identical; base64 reconstruction remains the fallback for the public JSON endpoints. | `edit-text-image-passthrough` | To be filed (issue-first per upstream CONTRIBUTING) |

On every pin bump: re-`git apply --check` each patch against the new tag,
regenerate if drifted, re-pin the hashes, and first check whether upstream has
landed the fix — if so, delete the patch and its manifest entries.

```bash
git ls-remote https://github.com/Stirling-Tools/Stirling-PDF.git "refs/tags/v2.14.0" "refs/tags/v2.14.0^{}"
```

**Footgun:** never build a scrubbed tree with the legacy `DISABLE_ADDITIONAL_FEATURES=true`
flag — an inverted legacy condition in the root `build.gradle` (~line 608) wires
`:proprietary` into the root project and fails configuration on a scrubbed tree. Always
`STIRLING_FLAVOR=core`.

## Build recipe (verified end-to-end)

```bash
pnpm engine:vendor
PLATFORM=windows-x64 pnpm engine:build
# -> engine/dist/stirling-pdf-2.14.0-windows-x64.jar
```

- **JDK:** any JDK launches Gradle (21 verified); the toolchain auto-downloads Temurin 25
  (foojay resolver). **Runtime requires JRE 25** — classfiles are Java 25, hardcoded
  (`sourceCompatibility = VERSION_25`); Docker base is `eclipse-temurin:25-jre-noble`.
  RaioPDF must bundle a jlink-trimmed **JRE 25** per platform.
- **Size:** ~224 MB with all 5 JPDFium native platforms; ~178 MB single-platform
  (`-PjpdfiumPlatforms=windows-x64|linux-x64|darwin-x64|darwin-arm64|linux-arm64`).
  ~30 MB is CJK Noto fonts in static resources if further trimming is wanted.
- **Time:** ~6–7 min cold; ~18 s warm.
- **Runtime:** starts in ~7–10 s; RSS ~860 MB under `-Xmx1g` after processing jobs.
  Verified flags: `--server.port=<p> --server.address=127.0.0.1`,
  `STIRLING_BASE_PATH=<dir>` (relocates configs/logs/pipeline/customFiles).
- **Release provenance:** `engine/build.sh` refuses to build if `engine/upstream` is not at
  `engine/PINNED_COMMIT`, if patched `settings.gradle` does not match
  `engine/PINNED_SETTINGS_GRADLE_SHA256`, if any file listed in
  `engine/PINNED_PATCHED_FILES_SHA256` does not match its pinned post-patch hash, or if
  the worktree contains anything beyond the documented scrub deletions, the settings
  patch, and the enumerated functional-patch files. Each copied `engine/dist/*.jar` gets a
  `.source` manifest with tag, commit, platform, and SHA-256; payload assembly always
  refreshes the verified upstream checkout and rebuilds before copying `engine/stirling.jar`.

## REST API contract (verified live against the built core JAR)

All `POST multipart/form-data`; the PDF param is **`fileInput`** everywhere (repeated for
merge). Optional `?async=true` returns a job id — poll `GET /api/v1/general/job/{id}`,
fetch `.../job/{id}/result`. Errors are RFC-7807-style JSON (`detail`, `status`,
`errorCode`); corrupt input → 400 `E001`; disabled endpoint → 403. OpenAPI at
`/v1/api-docs`; `./gradlew generateOpenApiDocs` produces `SwaggerDoc.json` — vendor it per
pinned tag as the contract fixture.

| Operation | Endpoint | Key params | Verified |
|---|---|---|---|
| Merge | `/api/v1/general/merge-pdfs` | `fileInput`×N, `sortType=orderProvided`, `removeCertSign`, `generateToc` | 200 |
| Split | `/api/v1/general/split-pages` | `pageNumbers` (`1,3-5`, `all`) → ZIP | 200 |
| Rotate | `/api/v1/general/rotate-pdf` | `angle` (multiple of 90; whole doc) | 200 |
| Remove pages | `/api/v1/general/remove-pages` | `pageNumbers` | 200 |
| Rearrange | `/api/v1/general/rearrange-pages` | `pageNumbers`, `customMode` | 200 |
| OCR | `/api/v1/misc/ocr-pdf` | `languages`×N, `ocrType` (`skip-text`\|`force-ocr`\|`Normal`), `ocrRenderType` (`hocr`\|`sandwich`), `sidecar`, `deskew`, `clean`, `cleanFinal`, `removeImagesAfter` | 403 w/o binaries (correct gating) |
| Compress | `/api/v1/misc/compress-pdf` | `optimizeLevel` 1–9 (default 5), `expectedOutputSize`, `grayscale`, `linearize` | 200 (Java fallback w/o gs) |
| PDF/A | `/api/v1/convert/pdf/pdfa` | `outputFormat` (`pdfa-1`\|`pdfa-2b`\|`pdfa-3b`), `strict` | 403 w/o Ghostscript (gs required) |
| Metadata | `/api/v1/misc/update-metadata` | `deleteAll`, `title`, `author`, …, custom via `allRequestParams` | 200 |
| Stamp | `/api/v1/misc/add-stamp` | `pageNumbers`, `stampType` (`text`\|`image`), `stampText`/`stampImage`, `fontSize`, `rotation`, `opacity`, `position` 1–9, **`customMargin` (de-facto REQUIRED — NPE→500 if omitted, upstream bug v2.14.0)**, `customColor` | 200 |
| Remove password | `/api/v1/security/remove-password` | `fileInput`, `password` (empty string works for owner-restricted PDFs; password-required failures return `errorCode: "E004"`) | 200 / E004 |
| Redaction | `/api/v1/security/auto-redact` (`listOfText`, `useRegex`, `wholeWordSearch`, `redactColor`, `convertPDFToImage`); `.../redact` (manual boxes); `.../redact-execute` | Auto-redact only guarantees unrecoverable text when `convertPDFToImage=true`, which rasterizes pages and loses searchable/selectable text. `redact-execute` supports `strategy=IMAGE_FINALIZE`/`convertToImage=true`; its `ImageBox` model names `y1` as top and `y2` as bottom. | 200 (auto-redact) |
| Edit text | `/api/v1/general/edit-text` | `edits` (JSON array text part `[{"find":"…","replace":"…"}]`, ordered, literal, case-sensitive), `wholeWordSearch`, `pageNumbers` (1-based). Full PDF→JSON→PDF regeneration even on zero matches; response is PDF bytes only (counts are log-only); bookmarks dropped (sidecar restores); raw image streams preserved only via `pdfjson-image-passthrough.patch`. | 200 + text & image-passthrough asserts |

## OCR invocation & config

`OCRController` shells out via `ProcessExecutor` to **OCRmyPDF**:
`<ocrmypdfPath> --verbose 2 --output-type pdf --pdf-renderer {hocr|sandwich} [--sidecar]
[--deskew] [--clean] [--clean-final] {--skip-text|--force-ocr}
--invalidate-digital-signatures --language eng in.pdf out.pdf`.
Raw tesseract is used only when the OCRmyPDF group is disabled/unavailable.

Config keys (`{STIRLING_BASE_PATH}/configs/settings.yml`, generated from
`app/core/src/main/resources/settings.yml.template` on first boot):

- `system.customPaths.operations.ocrmypdf` — ocrmypdf binary path (drives both the
  startup availability probe and invocation).
- `system.tessdataDir` — tessdata dir; priority: key > `TESSDATA_PREFIX` env > distro
  default. API language list = the `.traineddata` files present.
- `processExecutor.sessionLimit.ocrMyPdfSessionLimit: 4` (the sidecar's generated
  `custom_settings.yml` raises it from 2 so the release canary's three OCR calls
  never queue on an unreleased slot — see `docs/RELEASE-CANARY.md`),
  `processExecutor.timeoutMinutes.ocrMyPdfTimeoutMinutes: 30`.
- **`tesseract` and `gs` have no path key** — they must be on the sidecar process `PATH`;
  the shell must prepend the bundle dir to `PATH` when spawning the JVM.
- Lean-sidecar trimming: `endpoints.toRemove: []` / `endpoints.groupsToRemove: []`;
  disable swagger with `springdoc.api-docs.enabled=false`.
- Missing binaries auto-disable endpoint groups with clear log lines; the rest of the API
  keeps working.
- OCR bundle parts (per official image): Python venv + `pip install ocrmypdf`, apt
  `tesseract-ocr` + `tesseract-ocr-eng` + `-osd`, `unpaper pngquant` (only for
  `clean=true`), Ghostscript (also required for PDF/A; preferred for compress/repair).

## Open risks

1. **JRE 25 requirement** — bleeding-edge; no downgrade path. Bundle Temurin 25 jlink'd.
2. **Sidecar weight** — 178 MB JAR + ~0.9 GB RSS. Cap with `-Xmx`; consider lazy start/stop.
3. **OCR bundle complexity** — Python runtime + ocrmypdf + tesseract + tessdata + gs per
   platform; the single hardest packaging item.
4. **Ghostscript-gated endpoints** — PDF/A 403s without gs; compress degrades.
5. **`add-stamp` NPE** — always send `customMargin` (e.g. `medium`).
6. **No auth in core flavor** — API is unauthenticated; bind 127.0.0.1 (shell already
   does), disable springdoc, trim unused endpoints.
7. **Patch maintenance** — scrub script + settings.gradle patch + `engine/patches/*`
   functional patches reapplied per bump (see ADR 0003: check upstream first, delete
   patches upstream has landed, re-pin `PINNED_PATCHED_FILES_SHA256`);
   contract-test the endpoint table against the vendored `SwaggerDoc.json`.
8. **Test-fixture gotcha** — upstream's `test_globalsign.pdf` is intentionally corrupt;
   don't use it for smoke tests.
