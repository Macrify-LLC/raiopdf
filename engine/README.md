# Engine Vendoring

This directory contains the tooling for producing RaioPDF's Stirling-PDF MIT-core engine JAR.

The upstream checkout is generated into `engine/upstream` and is intentionally ignored. Do not commit Stirling source into this repository.

## Usage

```bash
pnpm engine:vendor
pnpm engine:build
pnpm engine:verify
```

`engine/vendor.sh` clones Stirling-PDF at the tag in `engine/PINNED_TAG`, removes the documented proprietary/SaaS carve-outs, applies `engine/settings-gradle.patch`, and fails if any carve-out directory still exists.

`engine/build.sh` builds the core-flavor boot JAR:

```bash
STIRLING_FLAVOR=core ./gradlew :stirling-pdf:bootJar -PjpdfiumPlatforms="${PLATFORM:-windows-x64}" -x test -x spotlessCheck
```

Set `PLATFORM` to override the JPDFium native platform, for example `linux-x64`, `linux-arm64`, `darwin-x64`, or `darwin-arm64`. The script verifies the built JAR contains no entries matching `proprietary` or `saas`, prints the path and size, then copies it to `engine/dist`.

`engine/verify-live.sh` starts the built JAR on a free `127.0.0.1` port with a temporary `STIRLING_BASE_PATH`, waits for `/api/v1/info/status`, and checks the core endpoints RaioPDF relies on: merge, split, rotate, remove pages, and rearrange pages. Runtime requires Java 25 or newer; set `JAVA_BIN` if the Gradle-downloaded toolchain is not auto-detected.

Live verification must use a JAR built for the host platform because PDF operations load JPDFium natives. On Linux, run `PLATFORM=linux-x64 pnpm engine:build` before `pnpm engine:verify`.

## Footgun

Never build the scrubbed tree with `DISABLE_ADDITIONAL_FEATURES=true`. In Stirling-PDF v2.14.0 that legacy flag trips an inverted root `build.gradle` condition and wires `:proprietary` into configuration, which fails after the proprietary directory has been scrubbed.

Always build with:

```bash
STIRLING_FLAVOR=core
```

## Re-vendoring

1. Update `engine/PINNED_TAG`.
2. Re-read `docs/ENGINE-VENDORING.md` and re-check the upstream license, flavor wiring, scrub list, and endpoint contract.
3. Run `pnpm engine:vendor`.
4. If `engine/settings-gradle.patch` no longer applies, regenerate it so the final `settings.gradle` includes only `stirling-pdf` and `common` by default and includes `proprietary` only inside `if (!disableAdditional)`.
5. Run `pnpm engine:build` for the target `PLATFORM`.
6. Run `pnpm engine:verify`.
7. Run the repo gates before pushing.
