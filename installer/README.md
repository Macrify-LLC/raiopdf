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

The Mac namespace and verifier are present, but full payload assembly remains
disabled until the relocatable Python/OCR inputs are pinned and exercised on
Apple Silicon. `assemble-macos-arm64.sh --verify` defines the required layout
and rejects Windows files. It does not claim that an incomplete payload is a
release payload.

A compile-only CI job may create an unmistakable empty resource directory:

```bash
node installer/run-payload-assembler.mjs --platform macos-arm64 --prepare-empty
```

That command cleans only the repository-contained `macos-arm64` namespace and
writes `RAIOPDF-PAYLOAD-NOT-ASSEMBLED`. It is for `tauri build --no-bundle`
only; the payload verifier rejects it because the required runtime files and
manifest are absent.

Run the platform contract tests with `pnpm test:platforms`.
