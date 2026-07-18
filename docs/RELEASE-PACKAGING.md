# Platform release packaging

RaioPDF publishes Windows x64 and Apple Silicon as independent packages. A
Windows installer may contain only the Windows x64 runtime and native tools; a
macOS installer may contain only the macOS arm64 runtime and native tools. We do
not build a universal macOS package or put both operating-system payloads in one
download.

The macOS overlay records the DMG, updater, and resource contract. `bundle.active`
is now true: the relocatable macOS arm64 payload is assembled and verified on Apple
Silicon (`installer/assemble-macos-arm64.sh` plus the manifest, Mach-O boundary, and
size gates), so `pnpm build:shell:macos-arm64` produces an unsigned `.app`/`.dmg`.
CI's compile-only `shell-macos-arm64` job stays non-distributable regardless: it runs
the payload assembler with `--prepare-empty` (an empty-payload marker) and builds Tauri
with `--no-bundle`, so it compiles the shell without ever emitting a bundle.

Signed macOS releases are a maintainer-local pipeline: `pnpm release:macos`
(`scripts/release-macos.mjs`) stamps the version, assembles the payload with
every Mach-O Developer ID signed before the manifest is generated, builds the
hardened-runtime app via `tauri.macos.signing.conf.json`, notarizes and staples
the app, builds the Tauri-signed updater archive from the stapled app, then
builds, signs, notarizes, and staples the DMG, and finally stages and validates
the canonical assets. See `docs/SIGNING.md` (macOS) for credentials and the
step-by-step contract.

The platform contract is defined in `installer/platforms.mjs`. It owns the
payload, cache, release-stage, Tauri updater, Rust target, and public artifact
names for each supported platform. Release work is staged separately:

```text
release-assets/signed/
  windows-x64/
  macos-arm64/
  latest.json
```

`prepare:release-assets` and `validate:release-assets` continue to produce and
validate a complete Windows release from `release-assets/signed/windows-x64`.
The macOS stage is produced by `prepare-signed-release-assets --platform
macos-arm64` (normally invoked by the `stage` step of `pnpm release:macos`),
and `--combine` cross-checks both platform stages before writing the shared
`latest.json` and the release-wide `SHA256SUMS.txt` at the stage root — see
`docs/SIGNING.md`, "Publishing the combined release."

The default Windows command keeps its established public filenames and embeds
the Windows-only `latest.json` for compatibility. For a combined release, stage
Windows without shared metadata first:

```powershell
pnpm prepare:release-assets -- --tag v0.2.0 --platform-stage-only
```

That mode leaves `latest.json` out of the Windows directory and its checksum;
the cross-platform generator then writes the only shared manifest at
`release-assets/signed/latest.json`.

Validate that Windows platform-only stage before aggregation with:

```powershell
pnpm validate:platform-release-stage -- `
  --platform windows-x64 `
  --root release-assets/signed/windows-x64 `
  --payload-root apps/shell/src-tauri/payload/windows-x64 `
  --release-version 0.2.0 `
  --ghostscript-version 10.07.1
```

Mac compliance, source, and checksum assets include `macos-arm64` in their
public names—for example
`RaioPDF-0.2.0-macos-arm64-component-manifest.json`,
`ghostscript-10.07.1-macos-arm64-source.tar.xz`, and
`SHA256SUMS-macos-arm64.txt`. Windows names remain unchanged. This lets both
sets coexist in one GitHub Release without same-name assets hiding one another.

## Updater manifest

Both platforms share one Tauri `latest.json` version and publication date, but
each updater entry points to a different signed asset:

- `windows-x86_64` → `RaioPDF-<version>-windows-x64-setup.exe`
- `darwin-aarch64` → `RaioPDF-<version>-macos-arm64.app.tar.gz`

Generate the combined file only after the selected platform stages contain the
updater artifact and its matching `.sig`:

```powershell
node scripts/generate-latest-json.mjs --tag v0.2.0 `
  --stage-root release-assets/signed `
  --platform windows-x64 `
  --platform macos-arm64
```

Omit the macOS `--platform` argument for a Windows-only release. The generator
still emits the existing single Windows entry, so adding the platform boundary
does not force a Mac package before one is ready. It rejects mixed versions,
duplicate updater keys, missing signatures, noncanonical URLs, and assets found
outside their platform stage.

## Package boundary and size gate

`scripts/validate-package-boundary.mjs` recursively checks a payload or release
stage. It rejects foreign-platform path markers, Linux ELF files, Windows PE
files in a Mac package, Mach-O files in a Windows package, and Intel or universal
Mach-O files in the Apple Silicon package. Non-x64 Windows executables are rejected except
for the exact Microsoft x64-runtime and NSIS x64-installer bootstrap contracts;
symlinks are rejected so staging cannot escape its platform root.

When given `--installer`, the same command checks the compressed installer
against `scripts/package-size-baselines.json`. `--payload-size` checks the sum
of every file in the unpacked payload directory against a separate installed-size
baseline. Growth above either the percentage
and byte allowance fails unless the caller explicitly supplies
`--allow-growth --growth-reason "..."`; a reviewed release should normally
update the committed baseline instead. The Windows baselines are the published
0.1.3 installer and its verified 986,198,913-byte unpacked payload. The macOS
baselines are the first fully signed and notarized arm64 package (0.1.4): a
431,412,835-byte DMG and a 762,978,566-byte Developer ID-signed unpacked
payload.

The release workflow runs the boundary scan on the assembled Windows payload
and again on the resource copy produced by Tauri. Before a Mac stage is signed,
run the same scan on both the assembled payload and the expanded application:

```powershell
pnpm validate:package-boundary -- --platform macos-arm64 `
  --root target/release/bundle/macos/RaioPDF.app/Contents
```

The `.app.tar.gz` updater signature and DMG notarization then bind those checked
release bytes; mounting and stapling the DMG remain Mac-native acceptance gates.

Validate the exact Mac stage, including its updater signature and checksums,
with:

```powershell
pnpm validate:platform-release-stage -- `
  --platform macos-arm64 `
  --root release-assets/signed/macos-arm64 `
  --payload-root apps/shell/src-tauri/payload/macos-arm64 `
  --release-version 0.2.0 `
  --ghostscript-version 10.07.1
```

The command reads the same Tauri updater public key as the existing Windows
release validator. It verifies `RaioPDF-<version>-macos-arm64.app.tar.gz.sig`
against the archive bytes cross-platform. Apple code-signing, notarization, and
stapling remain separate Mac-native checks.
