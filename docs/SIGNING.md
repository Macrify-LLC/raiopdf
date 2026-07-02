# Code signing

RaioPDF's Windows installers are signed with a **Certum "Open Source Code Signing
(cloud)"** certificate. Signing is done **locally** by a maintainer using SimplySign
Desktop — no signing credentials live in CI. This keeps the private key on Certum's
cloud HSM (as CA/Browser Forum rules now require) and out of GitHub.

> macOS signing/notarization is a separate track (Apple Developer Program) and is not
> covered here yet.

## How it fits together

- **CI** (`.github/workflows/release.yml`) builds **unsigned** installers on tag pushes
  and uploads them as artifacts. Use this for test builds and to validate the packaging.
- **Signed releases** are built **locally** with the signing config overlay
  (`apps/shell/src-tauri/tauri.windows.signing.conf.json`), which tells Tauri to run
  `apps/shell/src-tauri/scripts/sign-windows.ps1` for each artifact. Building locally
  (rather than signing a downloaded CI artifact) ensures the inner app `.exe` **and** the
  installers are all signed, because Tauri signs during bundling.

Nothing secret is committed: the certificate is selected at build time by thumbprint,
read from an environment variable.

## One-time setup

1. **Certificate.** Obtain the Certum *Open Source Code Signing — in the cloud*
   certificate and complete identity verification. Order it early; issuance can take
   several days.
2. **SimplySign.** Install **SimplySign Desktop** and the **SimplySign mobile app**
   (used for the OTP/QR login). Logging in loads the certificate into your Windows
   `CurrentUser\My` certificate store for the session.
3. **Windows SDK.** Install the Windows 10/11 SDK so `signtool.exe` is available.
   `sign-windows.ps1` finds it on `PATH` or under `Windows Kits\10\bin`.
4. **PowerShell 7+** (`pwsh`) — the overlay invokes the signing script with `pwsh`.
5. **Find your thumbprint.** With SimplySign logged in:
   ```powershell
   Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.HasPrivateKey } |
     Format-List Subject, Thumbprint, NotAfter
   ```
   Copy the `Thumbprint` of the RaioPDF/Certum certificate.

## Cutting a signed release

```powershell
# 1. Log in with SimplySign Desktop (scan the QR with the mobile app).

# 2. Point the build at your certificate (thumbprint from the setup step, no spaces):
$env:RAIOPDF_SIGN_THUMBPRINT = "PASTE_YOUR_THUMBPRINT_HERE"
# Optional — defaults to http://time.certum.pl:
# $env:RAIOPDF_SIGN_TIMESTAMP_URL = "http://time.certum.pl"

# 3. Build the signed installers:
pnpm build:shell:signed
```

Output lands in `apps/shell/src-tauri/target/release/bundle/` (`nsis/*.exe`, `msi/*.msi`).

### Verify the signature

```powershell
$exe = Get-ChildItem apps\shell\src-tauri\target\release\bundle\nsis\*.exe | Select-Object -First 1
Get-AuthenticodeSignature $exe.FullName | Format-List Status, SignerCertificate, TimeStamperCertificate
# Status should be "Valid" and a timestamp should be present.
```

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `RAIOPDF_SIGN_THUMBPRINT` | yes | — | SHA-1 thumbprint selecting the signing certificate |
| `RAIOPDF_SIGN_TIMESTAMP_URL` | no | `http://time.certum.pl` | RFC-3161 timestamp server |

If `RAIOPDF_SIGN_THUMBPRINT` is unset, the signing script fails on purpose so a build
can't silently ship unsigned. For an intentional unsigned build, run plain
`pnpm build:shell` (no overlay).

## Notes / gotchas

- **Signed builds must be built locally** while SimplySign is logged in — the certificate
  is only in the store for that session.
- **`signCommand` working directory:** Tauri runs the sign command from the Tauri project
  directory (`apps/shell/src-tauri`), which is why the overlay uses the relative path
  `scripts/sign-windows.ps1`. If a future Tauri version changes this, switch to an
  absolute path. Worth confirming on the first real signed build.
- **Engine not yet bundled:** the installer currently contains the shell only — the
  Stirling sidecar and OCR toolchain aren't wired into the Tauri bundle yet
  (no `externalBin`/`resources` in `tauri.conf.json`). When they are, they'll be signed
  by the same `signCommand`, but re-verify signing after that change.
- **Publisher name:** the name shown in the Windows UAC / SmartScreen prompt comes from
  the certificate subject, not from this repo. Decide whether the cert is issued to your
  personal name or to "Macrify LLC" when ordering.
- **SmartScreen reputation:** a standard (non-EV) certificate is trusted immediately for
  validity, but Microsoft SmartScreen reputation still builds up over download volume, so
  early downloaders may briefly see a warning until reputation accrues.
