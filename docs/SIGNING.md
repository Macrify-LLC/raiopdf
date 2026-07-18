# Code signing

RaioPDF's Windows installers are signed with a **Certum "Open Source Code Signing
(cloud)"** certificate. Signing is done **locally** by a maintainer using SimplySign
Desktop — no signing credentials live in CI. This keeps the private key on Certum's
cloud HSM (as CA/Browser Forum rules now require) and out of GitHub.

> macOS signing/notarization is a separate trust chain (Apple Developer Program,
> Developer ID + notarization) — see the [macOS](#macos) section below.

## How it fits together

- **CI** (`.github/workflows/release.yml`) builds **unsigned** installers on tag pushes
  and uploads them as workflow artifacts only. Use these for test builds and to validate
  packaging, never as public release assets.
- **Signed releases** are built **locally** with the signing config overlay
  (`apps/shell/src-tauri/tauri.windows.signing.conf.json`), which tells Tauri to run
  `apps/shell/src-tauri/scripts/sign-windows.ps1` for each artifact. Building locally
  (rather than signing a downloaded CI artifact) ensures the inner app `.exe` **and** the
  installers are all signed, because Tauri signs during bundling.
- The signed build is a **complete** build, not just a signing pass. `build:shell:signed`
  first runs `pnpm prepare:shell-bundle`, which assembles the bundled **payload** (JRE +
  Stirling OCR engine + OCR toolchain, shipped via `bundle.resources`) and compiles the
  Tauri **`externalBin` sidecars** — `raiopdf-engine-host` and `raiopdf-mcp`. Tauri then
  signs the app `.exe`, both sidecars, and the installers in one pass, so the signed
  installer is the full app (OCR **and** the MCP connector), not a shell-only stub.

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
5. **Local build toolchain.** Because the signed build now assembles the full payload and
   compiles the sidecars locally (via `prepare:shell-bundle`), not just signing, the box
   needs the same toolchain CI uses:
   - **Node 24 + pnpm** and **Rust/cargo** (builds `raiopdf-engine-host` +
     `raiopdf-mcp-launcher`).
   - **JDK 21** plus the vendored Stirling engine dist — run `pnpm engine:vendor` (or
     `pnpm engine:build`) once so `engine/dist/` holds the Stirling jar the payload
     assembler expects.
   - **Git Bash** (or WSL) — the Windows payload assembler
     (`installer/assemble-windows-x64.sh`) is invoked through the explicit
     platform dispatcher, `installer/run-payload-assembler.mjs`.

   See `installer/README.md` for payload details. Validate the payload independently with
   `pnpm prepare:shell-bundle` before your first signed build.
6. **Find your thumbprint.** With SimplySign logged in:
   ```powershell
   Get-ChildItem Cert:\CurrentUser\My | Where-Object { $_.HasPrivateKey } |
     Format-List Subject, Thumbprint, NotAfter
   ```
   Copy the `Thumbprint` of the RaioPDF/Certum certificate.

## Cutting a signed release

The signing overlay enables `createUpdaterArtifacts`, so a signed build also produces the
Tauri **updater signatures** (`*-setup.exe.sig`). That step needs the **minisign updater
key** — separate from the Certum Authenticode cert — supplied via `TAURI_SIGNING_PRIVATE_KEY`
+ `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Both live in your organization's secret manager
(the `credential` field is the private key, the `password` field is its password) — see
your private release runbook for the exact vault/item reference. The build also stamps
the app version from the **git tag on the current commit**,
so tag the release before building — an untagged commit fails the stamp rather than shipping
a placeholder version.

```powershell
# 1. Log in with SimplySign Desktop (scan the QR with the mobile app).

# 2. Point the build at your certificate (thumbprint from the setup step, no spaces):
$env:RAIOPDF_SIGN_THUMBPRINT = "PASTE_YOUR_THUMBPRINT_HERE"
# Release validation pins this same certificate thumbprint by default.
# Optional: set RAIOPDF_SIGN_EXPECTED_SUBJECT too, but use the exact full
# SignerCertificate.Subject string if you do.
# Optional — defaults to http://time.certum.pl:
# $env:RAIOPDF_SIGN_TIMESTAMP_URL = "http://time.certum.pl"

# 3. Supply the minisign updater key (from your secret manager) so updater .sig files
#    are produced. Example using the 1Password CLI against a private vault/item you've
#    set up yourself:
$env:TAURI_SIGNING_PRIVATE_KEY = op read "op://<vault>/<item>/credential"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = op read "op://<vault>/<item>/password"

# 4. Tag the release commit (the build stamps the version from this tag):
git tag v0.1.0   # example

# 5. Build the signed installers. Runs the full pipeline: stamp version ->
#    prepare:shell-bundle (assemble OCR payload + build engine-host/MCP sidecars) ->
#    sign app + sidecars + installers -> emit updater .sig. The first run is heavy.
pnpm build:shell:signed

# 6. Stage the signed public release assets under canonical names.
$tag = "v0.1.0"  # same tag as the release commit
pnpm prepare:release-assets -- --tag $tag

# 7. Validate the exact local asset set before publishing. This also verifies
#    Authenticode status, signer subject, timestamp, and updater signature.
pnpm validate:release-assets -- --tag $tag

# 8. Upload the exact signed installer, updater signature, latest.json, and checksum file.
gh release upload $tag (Get-ChildItem release-assets\signed\windows-x64\* | ForEach-Object { $_.FullName }) --clobber

# 9. After publishing the GitHub release, verify the published assets too.
#    This rejects draft/prerelease state, confirms /releases/latest resolves to
#    this tag, downloads the public installer, and checks Authenticode plus the
#    Tauri updater signature against published bytes.
pnpm validate:release-assets -- --tag $tag --github
```

The signed Tauri build normally lands in the workspace bundle directory
`target/release/bundle/nsis/` (`apps/shell/src-tauri/target/release/bundle/nsis/` is
also searched as a fallback). The release-prep script copies exactly one signed NSIS
installer and its matching `.sig` into the ignored local staging directory
`release-assets/signed/windows-x64/`, renaming the installer to the canonical public asset name,
and stages the release compliance assets from the built payload:

```text
RaioPDF-<version>-windows-x64-setup.exe
RaioPDF-<version>-windows-x64-setup.exe.sig
RaioPDF-<version>-third-party-notices.txt
RaioPDF-<version>-component-manifest.json
RaioPDF-<version>-source-correspondence.md
RaioPDF-<version>-license-notices.txt
RaioPDF-<version>-ghostscript-source-offer.txt
ghostscript-<ghostscript-version>-source.tar.xz
latest.json
SHA256SUMS.txt
```

The updater endpoint uses GitHub's `/releases/latest/download/latest.json` URL, so
stable `latest.json` must be uploaded to the latest **published, non-prerelease**
GitHub Release. Product copy can call a stable release an alpha, but only toggle
GitHub's "pre-release" state for preview builds that users download manually. A draft,
prerelease, or older release will not serve updates to shipped apps.

CI's unsigned draft-release flow (`.github/workflows/release.yml`) intentionally does
**not** upload `.exe` release assets and does **not** generate `latest.json`. If the
release already exists, reruns leave its draft/published state alone. The manifest must
point at the locally built, signed installer only, because it embeds the updater
signature for that exact release asset.

### Verify the signature

```powershell
$exe = Get-ChildItem release-assets\signed\windows-x64\RaioPDF-*-windows-x64-setup.exe | Select-Object -First 1
Get-AuthenticodeSignature $exe.FullName | Format-List Status, SignerCertificate, TimeStamperCertificate
# Status should be "Valid" and a timestamp should be present.
```

## Environment variables

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `RAIOPDF_SIGN_THUMBPRINT` | yes | — | SHA-1 thumbprint selecting the signing certificate |
| `RAIOPDF_SIGN_EXPECTED_THUMBPRINT` | no | `RAIOPDF_SIGN_THUMBPRINT` | Thumbprint expected on the signed public installer during validation |
| `RAIOPDF_SIGN_EXPECTED_SUBJECT` | no | — | Exact full Authenticode signer subject to require in addition to the thumbprint |
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
- **Bundled sidecars:** `pnpm build:shell:signed` prepares the payload and Tauri
  `externalBin` files before signing. Re-verify the installed `mcp_status` path
  and engine startup after signing changes.
- **Publisher name:** the name shown in the Windows UAC / SmartScreen prompt comes from
  the certificate subject, not from this repo. Decide whether the cert is issued to your
  personal name or to "Macrify LLC" when ordering.
- **SmartScreen reputation:** a standard (non-EV) certificate is trusted immediately for
  validity, but Microsoft SmartScreen reputation still builds up over download volume, so
  early downloaders may briefly see a warning until reputation accrues.

## macOS

macOS releases are signed with a **Developer ID Application** certificate and
**notarized** by Apple. Like Windows, signing is **maintainer-local**: the
certificate lives in the maintainer Mac's keychain, notarization credentials live
in that keychain as a `notarytool` profile, and CI never sees either. Unlike
SmartScreen, notarization has no reputation ramp — a notarized app passes
Gatekeeper immediately.

### One-time setup

1. **Certificate.** In the Apple Developer Program, create a **Developer ID
   Application** certificate (not Mac Development, not the App Store
   distribution types, not Developer ID Installer — RaioPDF ships a `.dmg`, not
   a `.pkg`). Install it in the login keychain and confirm:
   ```bash
   security find-identity -v -p codesigning
   # -> 1) ... "Developer ID Application: <name> (<TEAMID>)"
   ```
2. **Notarization profile.** Generate an app-specific password for your Apple ID
   (account.apple.com -> Sign-In and Security -> App-Specific Passwords), then:
   ```bash
   xcrun notarytool store-credentials raiopdf-notary \
     --apple-id <apple-id-email> --team-id <TEAMID> --password <app-specific-password>
   ```
3. **Updater key.** The same Tauri minisign key the Windows release uses
   (`TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), from
   your secret manager.

### Cutting a signed macOS release

```bash
export RAIOPDF_MAC_SIGN_IDENTITY="Developer ID Application: <name> (<TEAMID>)"
export TAURI_SIGNING_PRIVATE_KEY="$(...from your secret manager...)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(...)"

git tag vX.Y.Z          # version is stamped from the tag, as on Windows
pnpm release:macos      # or: node scripts/release-macos.mjs --version X.Y.Z
```

`scripts/release-macos.mjs` runs the whole chain in the **final-byte order** the
release contract requires — the payload manifest and every signature must
describe the exact bytes that ship:

1. **assemble** — payload assembled, then every payload Mach-O is Developer ID
   signed (`scripts/sign-macos-payload.mjs`, invoked by the assembler's
   `RAIOPDF_MACOS_SIGN_PAYLOAD=1` hook), and only then is the payload manifest
   generated — over the signed bytes. The deployment-target floor is enforced by
   `scripts/scan-macos-min-os.mjs` against `bundle.macOS.minimumSystemVersion`.
2. **build** — version stamped from the tag, sidecars compiled, Tauri builds and
   signs the `.app` with hardened runtime via
   `tauri.macos.signing.conf.json`.
3. **verify-app / notarize-app / staple-app** — strict recursive codesign
   verification, `notarytool submit --wait` (the notary log is fetched on
   failure), staple, and a Gatekeeper assessment.
4. **updater** — the `.app.tar.gz` is built **from the stapled app**, signed with
   the Tauri updater key, and the signature is verified against the configured
   updater pubkey before anything is staged.
5. **dmg / notarize-dmg** — the DMG is built from the stapled app (drag-install
   layout), codesigned, notarized, and stapled itself.
6. **stage** — canonical `macos-arm64` release assets are staged and validated
   (`prepare-signed-release-assets.mjs` / `validate-release-assets.mjs`).

Every step is resumable: `node scripts/release-macos.mjs --resume-from <step>`
re-enters after a failure without redoing earlier work, and `--stop-after <step>`
runs a partial chain (useful for a signing spike without publishing anything).

### Entitlements

Hardened runtime is on for everything; entitlement exceptions are granted only to
the executables that prove the need (`apps/shell/src-tauri/entitlements/`):

- the app + Rust sidecars: none (WKWebView's JIT lives in a system XPC process);
- the bundled JRE: JIT, unsigned executable memory, and
  `disable-library-validation` — the engine jar extracts JNI natives to a temp
  dir at runtime, which can never carry our team signature;
- the bundled Node runtime: JIT only.

### Release rules shared with Windows

Stable releases are **lockstep**: one version tag publishes complete signed
assets for both platforms, and the shared `latest.json` (containing
`windows-x86_64` and `darwin-aarch64` entries) is generated only after both
platform stages are final, and uploaded last. Published bytes are immutable —
fixes ship as a new patch version.

### Publishing the combined release

Stable releases are lockstep, so publishing takes three staging moves — the two
platform stages are built independently (each on its own build host), then
combined wherever both are present:

```bash
# On the Windows box (note --platform-stage-only: the per-platform stage must
# NOT contain latest.json; the combined one is generated at the stage root):
pnpm prepare:release-assets -- --tag vX.Y.Z --platform-stage-only

# On the Mac (the release orchestrator's `stage` step runs this for you):
node scripts/prepare-signed-release-assets.mjs --tag vX.Y.Z --platform macos-arm64

# Wherever both release-assets/signed/{windows-x64,macos-arm64}/ stages exist:
node scripts/prepare-signed-release-assets.mjs --tag vX.Y.Z --combine
```

`--combine` cross-checks both stages (same version, complete asset sets, valid
updater signatures), writes the cross-platform `latest.json` (`windows-x86_64` +
`darwin-aarch64`) and the release-wide `SHA256SUMS.txt` at the stage root, and
prints an **upload plan**. Upload exactly that plan (or pass `--combine
--upload`) — do not blind-glob the stage directories: the Windows stage's own
platform-scoped checksum file is superseded by the stage-root one and is
deliberately excluded. As with Windows-only releases, `latest.json` is uploaded
last, to a **published, non-prerelease** release.
