#!/usr/bin/env pwsh
#
# sign-windows.ps1 — signs a single file passed by Tauri's bundle.windows.signCommand.
#
# Tauri invokes this once per artifact (the app .exe and each installer), substituting
# the file path for %1. Signing uses the Certum "Open Source Code Signing (cloud)"
# certificate, which SimplySign Desktop loads into the CurrentUser certificate store
# once you are logged in. signtool then selects it by thumbprint.
#
# Configure via environment variables (never hard-code the thumbprint here):
#   RAIOPDF_SIGN_THUMBPRINT     (required) SHA-1 thumbprint of the cert, hex, no spaces
#   RAIOPDF_SIGN_TIMESTAMP_URL  (optional) RFC-3161 timestamp URL
#                               default: http://time.certum.pl
#
# If RAIOPDF_SIGN_THUMBPRINT is unset the script fails loudly — that is intentional so
# a misconfigured "signed" build never silently produces an unsigned artifact. To make
# an unsigned build, simply build WITHOUT the signing config overlay (plain `tauri build`).
#
# See docs/SIGNING.md for the full release runbook.

param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$File
)

$ErrorActionPreference = 'Stop'

# Never re-sign vendored third-party payload binaries (the bundled Ghostscript,
# Tesseract, and OCR toolchain under bundle.resources). Tauri hands this command every
# PE it bundles, including those resources, but re-signing them with our certificate
# would (1) make the license notices' "unmodified upstream" claim false, and (2) break
# the release gate that requires ocr/gs/bin/gs.exe to stay a byte-identical alias of
# gswin64c.exe (independent signatures diverge the two). We only sign RaioPDF's own
# artifacts — the app .exe, the Rust sidecars, and the installer — so decline anything
# living under a payload/ directory and leave it exactly as upstream shipped it.
if ($File -match '[\\/]payload[\\/]') {
  Write-Host "Skipping (vendored payload binary, left as upstream — not re-signed): $File"
  exit 0
}

$thumbprint = $env:RAIOPDF_SIGN_THUMBPRINT
if ([string]::IsNullOrWhiteSpace($thumbprint)) {
  Write-Error @'
RAIOPDF_SIGN_THUMBPRINT is not set.

Set it to your Certum code-signing certificate's SHA-1 thumbprint before building
with the signing overlay, e.g. (PowerShell):

  $env:RAIOPDF_SIGN_THUMBPRINT = "ABC123...."   # no spaces

Make sure SimplySign Desktop is running and logged in so the cert is available.
See docs/SIGNING.md. (No certificate yet? Build without the signing overlay to
produce an unsigned installer.)
'@
  exit 1
}
# Normalize: strip any spaces a copy/paste from the cert dialog may have introduced.
$thumbprint = $thumbprint -replace '\s', ''

$timestampUrl = if ([string]::IsNullOrWhiteSpace($env:RAIOPDF_SIGN_TIMESTAMP_URL)) {
  'http://time.certum.pl'
} else {
  $env:RAIOPDF_SIGN_TIMESTAMP_URL
}

# Locate signtool.exe: PATH first, else the newest x64 build under the Windows SDK.
$signtool = (Get-Command signtool.exe -ErrorAction SilentlyContinue).Source
if (-not $signtool) {
  $kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  $signtool = Get-ChildItem -Path $kitsRoot -Recurse -Filter signtool.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\x64\\' } |
    Sort-Object FullName -Descending |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not $signtool) {
  Write-Error 'signtool.exe not found. Install the Windows 10/11 SDK (includes signtool).'
  exit 1
}

Write-Host "Signing: $File"
& $signtool sign /fd sha256 /tr $timestampUrl /td sha256 /sha1 $thumbprint $File
if ($LASTEXITCODE -ne 0) {
  Write-Error "signtool failed with exit code $LASTEXITCODE"
  exit $LASTEXITCODE
}
