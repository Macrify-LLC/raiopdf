# Installer payloads

RaioPDF builds one native payload per release artifact. Windows x64 and macOS
arm64 inputs, caches, manifests, and bundle resources must never share a
directory. There is no universal or combined desktop package.

The platform contract lives in `platforms.mjs`. Its two public IDs are
`windows-x64` and `macos-arm64`; each descriptor owns its assembler, pins,
payload output, cache, Rust target, updater key, artifact names, and foreign-file
rules.

## Windows x64

`pnpm prepare:shell-bundle` remains the compatibility command for the current
Windows release and is equivalent to `pnpm prepare:shell-bundle:windows-x64`.
It builds MCP, dispatches `assemble-windows-x64.sh`, writes only
`apps/shell/src-tauri/payload/windows-x64`, uses only
`installer/.payload-cache/windows-x64`, and then prepares the Windows external
binaries. `pnpm build:shell:windows-x64` applies the Windows-only Tauri overlay.

CI may verify an existing Windows payload with:

```bash
node installer/run-payload-assembler.mjs --platform windows-x64 --verify
```

## macOS arm64

`assemble-macos-arm64.sh` assembles the full relocatable payload on Apple
Silicon: Ghostscript, qpdf, and Tesseract (plus their image libraries) are
built from pinned source with `MACOSX_DEPLOYMENT_TARGET` pinned so shipped
binaries never inherit the build machine's SDK default, and the JRE, Node,
python-build-standalone CPython, and OCRmyPDF wheel set come from pinned
archives (`PINS.macos-arm64.env`). `assemble-macos-arm64.sh --verify` defines
the required layout and rejects Windows files. For signed releases, the
assembler's `RAIOPDF_MACOS_SIGN_PAYLOAD=1` hook Developer ID-signs every
payload Mach-O before the manifest is generated (see `docs/SIGNING.md`), and
`scripts/scan-macos-min-os.mjs` enforces the deployment-target floor.

A compile-only CI job may create an unmistakable empty resource directory:

```bash
node installer/run-payload-assembler.mjs --platform macos-arm64 --prepare-empty
```

That command cleans only the repository-contained `macos-arm64` namespace and
writes `RAIOPDF-PAYLOAD-NOT-ASSEMBLED`. It is for `tauri build --no-bundle`
only; the payload verifier rejects it because the required runtime files and
manifest are absent.

Run the platform contract tests with `pnpm test:platforms`.
