# Engine Vendoring

This directory contains the tooling for producing RaioPDF's Stirling-PDF MIT-core engine JAR.

The upstream checkout is generated into `engine/upstream` and is intentionally ignored. Do not commit Stirling source into this repository.

## Usage

```bash
pnpm engine:vendor
pnpm engine:build
pnpm engine:verify
```

`engine/vendor.sh` clones Stirling-PDF at the tag in `engine/PINNED_TAG`, verifies the checkout resolves to the commit in `engine/PINNED_COMMIT`, removes the documented proprietary/SaaS carve-outs, applies `engine/settings-gradle.patch`, verifies the patched `settings.gradle` hash in `engine/PINNED_SETTINGS_GRADLE_SHA256`, and fails if any carve-out directory still exists.

`engine/build.sh` builds the core-flavor boot JAR:

```bash
STIRLING_FLAVOR=core ./gradlew :stirling-pdf:bootJar -PjpdfiumPlatforms="${PLATFORM:-windows-x64}" -x test -x spotlessCheck
```

Set `PLATFORM` to override the JPDFium native platform, for example `linux-x64`, `linux-arm64`, `darwin-x64`, or `darwin-arm64`. The script refuses to build from an upstream checkout whose commit, patched settings hash, or worktree status does not match the pinned vendoring shape, verifies the built JAR contains no entries matching `proprietary` or `saas`, prints the path and size, then copies it to `engine/dist` with a `.source` manifest recording the tag, commit, platform, and JAR hash. Installer payload assembly refreshes the verified upstream checkout and rebuilds the engine before copying `engine/stirling.jar`.

`engine/verify-live.sh` starts the built JAR on a free `127.0.0.1` port with a temporary `STIRLING_BASE_PATH`, waits for `/api/v1/info/status`, and checks the core endpoints RaioPDF relies on: merge, split, rotate, remove pages, and rearrange pages. Runtime requires Java 25 or newer; set `JAVA_BIN` if the Gradle-downloaded toolchain is not auto-detected.

Live verification must use a JAR built for the host platform because PDF operations load JPDFium natives. On Linux, run `PLATFORM=linux-x64 pnpm engine:build` before `pnpm engine:verify`.

## Footgun

Never build the scrubbed tree with `DISABLE_ADDITIONAL_FEATURES=true`. In Stirling-PDF v2.14.0 that legacy flag trips an inverted root `build.gradle` condition and wires `:proprietary` into configuration, which fails after the proprietary directory has been scrubbed.

Always build with:

```bash
STIRLING_FLAVOR=core
```

## Re-vendoring

1. Update `engine/PINNED_TAG` and `engine/PINNED_COMMIT`. Resolve the commit from the exact upstream tag, for example:
   ```bash
   git ls-remote https://github.com/Stirling-Tools/Stirling-PDF.git "refs/tags/vX.Y.Z" "refs/tags/vX.Y.Z^{}"
   ```
   Use the peeled commit (`^{}`) when the tag is annotated; otherwise use the tag ref SHA.
2. Re-read `docs/ENGINE-VENDORING.md` and re-check the upstream license, flavor wiring, scrub list, and endpoint contract.
3. Run `pnpm engine:vendor`.
4. If `engine/settings-gradle.patch` no longer applies, regenerate it so the final `settings.gradle` includes only `stirling-pdf` and `common` by default and includes `proprietary` only inside `if (!disableAdditional)`.
5. Update `engine/PINNED_SETTINGS_GRADLE_SHA256` to the SHA-256 of `engine/upstream/settings.gradle` after a successful vendor run.
6. Run `pnpm engine:build` for the target `PLATFORM`.
7. Run `pnpm engine:verify`.
8. Run the repo gates before pushing.
