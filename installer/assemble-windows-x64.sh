#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)

# shellcheck source=PINS.windows-x64.env
source "${RAIOPDF_PINS_FILE:-$SCRIPT_DIR/PINS.windows-x64.env}"

TARGET_PLATFORM=${RAIOPDF_PLATFORM:-${PAYLOAD_PLATFORM:-windows-x64}}
if [[ "$TARGET_PLATFORM" != "windows-x64" ]]; then
  echo "assemble-windows-x64: expected windows-x64, got $TARGET_PLATFORM." >&2
  exit 1
fi

PAYLOAD_DIR=${RAIOPDF_PAYLOAD_DIR:-"$REPO_ROOT/apps/shell/src-tauri/payload/windows-x64"}
PAYLOAD_MANIFEST="RAIOPDF-PAYLOAD-MANIFEST.tsv"
CACHE_DIR=${RAIOPDF_PAYLOAD_CACHE:-"$SCRIPT_DIR/.payload-cache/windows-x64"}
DOWNLOAD_DIR="$CACHE_DIR/downloads"
WORK_DIR="$CACHE_DIR/work"
REQ_FILE="$REPO_ROOT/$OCRMYPDF_REQUIREMENTS"
REQUIRED_PAYLOAD_FILES=(
  "jre/bin/java.exe"
  "engine/stirling.jar"
  "mcp/app/index.mjs"
  "mcp/node_modules/@napi-rs/canvas/package.json"
  "mcp/node_modules/@napi-rs/canvas-win32-x64-msvc/package.json"
  "mcp/node/LICENSE"
  "mcp/node/node.exe"
  "ocr/THIRD-PARTY-PYTHON.md"
  "ocr/ocrmypdf.cmd"
  "ocr/raiopdf-ocr-progress.cmd"
  "ocr/raiopdf_ocr_progress.py"
  "ocr/raiopdf_ocr_progress_plugin.py"
  "ocr/python/python.exe"
  "ocr/tesseract/tesseract.exe"
  "ocr/tesseract/tessdata/eng.traineddata"
  "ocr/gs/bin/gs.exe"
  "ocr/gs/bin/gswin64c.exe"
  "ocr/qpdf/LICENSE.txt"
  "ocr/qpdf/bin/qpdf.exe"
  "legal/THIRD-PARTY-NOTICES.txt"
  "legal/COMPONENT-MANIFEST.json"
  "legal/RELEASE-SOURCE-CORRESPONDENCE.md"
  "legal/RAIOPDF-LICENSE-NOTICES.txt"
  "legal/source-offers/GHOSTSCRIPT-SOURCE-OFFER.txt"
  "legal/licenses/GPL-3.0.txt"
  "legal/licenses/AGPL-3.0.txt"
  "legal/licenses/MPL-2.0.txt"
)
REQUIRED_PAYLOAD_DIRS=(
  "mcp/pdfjs/cmaps"
  "mcp/pdfjs/standard_fonts"
  "mcp/pdfjs/wasm"
)

MODE=assemble
case "${1:-}" in
  "")
    ;;
  --verify)
    MODE=verify
    shift
    ;;
  *)
    echo "Usage: $0 [--verify]" >&2
    exit 2
    ;;
esac

if [[ "$#" -ne 0 ]]; then
  echo "Usage: $0 [--verify]" >&2
  exit 2
fi

mkdir -p -- "$DOWNLOAD_DIR" "$WORK_DIR"

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

find_python() {
  local candidate
  if [[ -n "${PYTHON_CMD:-}" ]]; then
    if "$PYTHON_CMD" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; then
      printf '%s\n' "$PYTHON_CMD"
      return
    fi
    echo "PYTHON_CMD does not point to a usable Python 3.11+ executable: $PYTHON_CMD" >&2
    exit 1
  fi

  for candidate in python3 python py; do
    if command -v "$candidate" >/dev/null 2>&1 &&
      "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)' >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  echo "Missing usable Python 3.11+ command (tried python3, python, py)." >&2
  exit 1
}

sha256_file() {
  sha256sum "$1" | awk '{print $1}'
}

download_verified() {
  local name=$1
  local url=$2
  local expected_sha=$3
  local output="$DOWNLOAD_DIR/$name"

  if [[ -f "$output" ]] && [[ "$(sha256_file "$output")" == "$expected_sha" ]]; then
    printf 'Using cached %s\n' "$name" >&2
    printf '%s\n' "$output"
    return
  fi

  rm -f -- "$output"
  curl -fL --retry 3 --retry-delay 2 -o "$output" "$url"

  local actual_sha
  actual_sha=$(sha256_file "$output")
  if [[ "$actual_sha" != "$expected_sha" ]]; then
    echo "Checksum mismatch for $name" >&2
    echo "  expected: $expected_sha" >&2
    echo "  actual:   $actual_sha" >&2
    exit 1
  fi

  printf '%s\n' "$output"
}

extract_zip() {
  local zip_file=$1
  local dest=$2
  rm -rf -- "$dest"
  mkdir -p -- "$dest"
  "$PYTHON_CMD" - "$zip_file" "$dest" <<'PY'
import sys
import zipfile

with zipfile.ZipFile(sys.argv[1]) as archive:
    archive.extractall(sys.argv[2])
PY
}

find_7z() {
  local candidate
  for candidate in 7zz 7z 7za; do
    if command -v "$candidate" >/dev/null 2>&1; then
      command -v "$candidate"
      return
    fi
  done

  case "$(uname -s)-$(uname -m)" in
    MINGW*-x86_64|MSYS*-x86_64|CYGWIN*-x86_64)
      local archive tool_dir bootstrap
      archive=$(download_verified "7z-$SEVENZIP_VERSION-windows-x64.exe" "$SEVENZIP_WINDOWS_X64_URL" "$SEVENZIP_WINDOWS_X64_SHA256")
      tool_dir="$CACHE_DIR/7zip-$SEVENZIP_VERSION-windows-x64"
      if [[ ! -x "$tool_dir/7z.exe" ]]; then
        if ! command -v node >/dev/null 2>&1; then
          echo "Missing node; needed to locate bootstrap 7za for 7-Zip extraction." >&2
          exit 1
        fi
        bootstrap=$(node -e 'try { process.stdout.write(require("7zip-bin").path7za || ""); } catch {}')
        if [[ -z "$bootstrap" || ! -x "$bootstrap" ]]; then
          echo "Missing bootstrap 7za from 7zip-bin." >&2
          exit 1
        fi
        rm -rf -- "$tool_dir"
        mkdir -p -- "$tool_dir"
        "$bootstrap" x -y "-o$tool_dir" "$archive" >/dev/null
      fi
      printf '%s\n' "$tool_dir/7z.exe"
      ;;
    Linux-x86_64|Linux-amd64)
      local archive tool_dir
      archive=$(download_verified "7z-$SEVENZIP_VERSION-linux-x64.tar.xz" "$SEVENZIP_LINUX_X64_URL" "$SEVENZIP_LINUX_X64_SHA256")
      tool_dir="$CACHE_DIR/7zip-$SEVENZIP_VERSION-linux-x64"
      if [[ ! -x "$tool_dir/7zz" ]]; then
        rm -rf -- "$tool_dir"
        mkdir -p -- "$tool_dir"
        tar -xf "$archive" -C "$tool_dir"
      fi
      printf '%s\n' "$tool_dir/7zz"
      ;;
    *)
      echo "Missing 7z/7zz/7za. Install 7-Zip or add it to PATH for installer extraction." >&2
      exit 1
      ;;
  esac
}

extract_with_7z() {
  local archive=$1
  local dest=$2
  local seven_zip=$3
  rm -rf -- "$dest"
  mkdir -p -- "$dest"
  "$seven_zip" x -y "-o$dest" "$archive" >/dev/null
}

is_windows_shell() {
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

windows_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -w "$1"
  else
    printf '%s\n' "$1"
  fi
}

copy_single_root_contents() {
  local src=$1
  local dest=$2
  local child_count first_child

  child_count=$(find "$src" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')
  if [[ "$child_count" == "1" ]]; then
    first_child=$(find "$src" -mindepth 1 -maxdepth 1 -print -quit)
    if [[ -d "$first_child" ]]; then
      src="$first_child"
    fi
  fi

  rm -rf -- "$dest"
  mkdir -p -- "$dest"
  cp -R "$src"/. "$dest"/
}

copy_engine_jar() {
  local dest="$PAYLOAD_DIR/engine/stirling.jar"
  local pinned_tag dist_jar

  pinned_tag=$(<"$REPO_ROOT/engine/PINNED_TAG")
  dist_jar="$REPO_ROOT/engine/dist/stirling-pdf-${pinned_tag#v}-${TARGET_PLATFORM}.jar"

  configure_build_jdk "$BUILD_JDK_ZIP"
  bash "$REPO_ROOT/engine/vendor.sh"
  PLATFORM="$TARGET_PLATFORM" bash "$REPO_ROOT/engine/build.sh"
  if ! verify_engine_dist_jar "$dist_jar"; then
    echo "Could not find a verified engine dist JAR for $TARGET_PLATFORM." >&2
    exit 1
  fi

  mkdir -p -- "$(dirname -- "$dest")"
  cp -- "$dist_jar" "$dest"
}

verify_engine_dist_jar() {
  local dist_jar=$1
  local manifest="$dist_jar.source"
  local expected_tag expected_commit actual_sha

  expected_tag=$(<"$REPO_ROOT/engine/PINNED_TAG")
  expected_commit=$(<"$REPO_ROOT/engine/PINNED_COMMIT")
  if [[ ! -f "$dist_jar" || ! -f "$manifest" ]]; then
    return 1
  fi

  actual_sha=$(sha256_file "$dist_jar")
  grep -Fx "tag=$expected_tag" "$manifest" >/dev/null &&
    grep -Fx "commit=$expected_commit" "$manifest" >/dev/null &&
    grep -Fx "platform=$TARGET_PLATFORM" "$manifest" >/dev/null &&
    grep -Fx "sha256=$actual_sha" "$manifest" >/dev/null
}

configure_build_jdk() {
  local jdk_zip=$1
  local extract_dir="$WORK_DIR/jdk"
  local jdk_root

  if command -v java >/dev/null 2>&1; then
    return
  fi

  jdk_root=$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d -name "jdk-*" -print -quit)
  if [[ -z "$jdk_root" ]]; then
    extract_zip "$jdk_zip" "$extract_dir"
    jdk_root=$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d -name "jdk-*" -print -quit)
  fi
  if [[ -z "$jdk_root" ]]; then
    echo "Could not find Temurin JDK root in $jdk_zip" >&2
    exit 1
  fi

  export JAVA_HOME="$jdk_root"
  export PATH="$JAVA_HOME/bin:$PATH"
}

install_node_runtime() {
  local node_zip=$1
  local extract_dir="$WORK_DIR/node-runtime"
  local node_dir="$PAYLOAD_DIR/mcp/node"
  local node_root

  extract_zip "$node_zip" "$extract_dir"
  node_root=$(find "$extract_dir" -mindepth 1 -maxdepth 1 -type d -name "node-v*-win-x64" -print -quit)
  if [[ -z "$node_root" ]]; then
    echo "Could not find Node runtime root in $node_zip" >&2
    exit 1
  fi

  rm -rf -- "$node_dir"
  mkdir -p -- "$node_dir"
  cp -- "$node_root/node.exe" "$node_dir/node.exe"
  cp -- "$node_root/LICENSE" "$node_dir/LICENSE"
}

generate_python_third_party_notice() {
  local site_packages=$1
  local notice_file=$2

  "$PYTHON_CMD" - "$site_packages" "$notice_file" <<'PY'
from email import policy
from email.parser import BytesParser
from pathlib import Path
import re
import sys

site_packages = Path(sys.argv[1])
notice_file = Path(sys.argv[2])
metadata_files = sorted(site_packages.glob("*.dist-info/METADATA"))

if not metadata_files:
    raise SystemExit(f"No Python wheel METADATA files found in {site_packages}")

def clean(value):
    value = value or "Not declared in METADATA"
    value = re.sub(r"\s+", " ", value).strip()
    return value.replace("\\", "\\\\").replace("|", "\\|")

def project_urls(metadata):
    urls = {}
    for item in metadata.get_all("Project-URL", []):
        label, sep, url = item.partition(",")
        if sep:
            urls[label.strip().lower()] = url.strip()
    return urls

def homepage(metadata):
    direct = metadata.get("Home-page")
    if direct:
        return direct

    urls = project_urls(metadata)
    for label in (
        "homepage",
        "home",
        "source",
        "source code",
        "repository",
        "code",
        "documentation",
    ):
        if label in urls:
            return urls[label]
    return None

rows = []
for metadata_file in metadata_files:
    with metadata_file.open("rb") as handle:
        metadata = BytesParser(policy=policy.default).parse(handle)

    fallback_name = metadata_file.parent.name
    if fallback_name.endswith(".dist-info"):
        fallback_name = fallback_name[: -len(".dist-info")]
    name = metadata.get("Name") or fallback_name
    version = metadata.get("Version")
    license_value = metadata.get("License-Expression") or metadata.get("License")
    rows.append((name, version, license_value, homepage(metadata)))

rows.sort(key=lambda row: row[0].lower())

lines = [
    "# Python OCR Third-Party Notices",
    "",
    "Generated from installed wheel `*.dist-info/METADATA` files in the bundled OCRmyPDF Python environment.",
    "",
    "| Component | Version | License | Homepage |",
    "| --- | --- | --- | --- |",
]
for name, version, license_value, home in rows:
    lines.append(
        f"| {clean(name)} | {clean(version)} | {clean(license_value)} | {clean(home)} |"
    )

notice_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
}

install_python_ocrmypdf() {
  local python_zip=$1
  local extract_dir="$WORK_DIR/python"
  local python_dir="$PAYLOAD_DIR/ocr/python"
  local pth_file

  extract_zip "$python_zip" "$extract_dir"
  copy_single_root_contents "$extract_dir" "$python_dir"

  mkdir -p -- "$python_dir/Lib/site-packages"
  "$PYTHON_CMD" -m pip install \
    --upgrade \
    --no-compile \
    --target "$python_dir/Lib/site-packages" \
    --require-hashes \
    --implementation cp \
    --platform win_amd64 \
    --python-version "$PYTHON_VERSION" \
    --abi "$PYTHON_ABI" \
    --only-binary=:all: \
    -r "$REQ_FILE"

  pth_file=$(find "$python_dir" -maxdepth 1 -name "python*._pth" -print -quit)
  if [[ -n "$pth_file" ]]; then
    "$PYTHON_CMD" - "$pth_file" <<'PY'
from pathlib import Path
import sys

pth = Path(sys.argv[1])
lines = pth.read_text(encoding="utf-8").splitlines()
next_lines = []
has_site_packages = False
has_import_site = False
for line in lines:
    stripped = line.strip()
    if stripped == "Lib/site-packages":
        has_site_packages = True
    if stripped == "#import site":
        line = "import site"
        stripped = line
    if stripped == "import site":
        has_import_site = True
    next_lines.append(line)
if not has_site_packages:
    next_lines.append("Lib/site-packages")
if not has_import_site:
    next_lines.append("import site")
pth.write_text("\n".join(next_lines) + "\n", encoding="utf-8")
PY
  fi

  cat >"$PAYLOAD_DIR/ocr/ocrmypdf.cmd" <<'EOF'
@echo off
set "PYTHONHOME=%~dp0python"
set "PYTHONPATH=%~dp0python\Lib\site-packages"
set "PYTHONDONTWRITEBYTECODE=1"
"%~dp0python\python.exe" -m ocrmypdf %*
EOF

  cp "$REPO_ROOT/installer/ocr/raiopdf_ocr_progress.py" "$PAYLOAD_DIR/ocr/raiopdf_ocr_progress.py"
  cp "$REPO_ROOT/installer/ocr/raiopdf_ocr_progress_plugin.py" "$PAYLOAD_DIR/ocr/raiopdf_ocr_progress_plugin.py"
  cat >"$PAYLOAD_DIR/ocr/raiopdf-ocr-progress.cmd" <<'EOF'
@echo off
set "PYTHONHOME=%~dp0python"
set "PYTHONPATH=%~dp0python\Lib\site-packages"
set "PYTHONDONTWRITEBYTECODE=1"
"%~dp0python\python.exe" "%~dp0raiopdf_ocr_progress.py" %*
EOF

  generate_python_third_party_notice "$python_dir/Lib/site-packages" "$PAYLOAD_DIR/ocr/THIRD-PARTY-PYTHON.md"
}

install_tesseract() {
  local installer=$1
  local eng_data=$2
  local seven_zip=$3
  local extract_dir="$WORK_DIR/tesseract"
  local tess_dir="$PAYLOAD_DIR/ocr/tesseract"

  if ! extract_with_7z "$installer" "$extract_dir" "$seven_zip"; then
    if ! is_windows_shell; then
      echo "Could not extract Tesseract installer with 7-Zip." >&2
      exit 1
    fi
    rm -rf -- "$extract_dir"
    mkdir -p -- "$extract_dir"
    chmod +x "$installer"
    "$installer" /SP- /VERYSILENT /SUPPRESSMSGBOXES /NORESTART "/DIR=$(windows_path "$extract_dir")"
  fi
  rm -rf -- "$extract_dir/\$PLUGINSDIR"
  rm -f -- "$extract_dir/tesseract-uninstall.exe"

  rm -rf -- "$tess_dir"
  mkdir -p -- "$tess_dir"
  cp -R "$extract_dir"/. "$tess_dir"/
  mkdir -p -- "$tess_dir/tessdata"
  cp -- "$eng_data" "$tess_dir/tessdata/eng.traineddata"
}

install_ghostscript() {
  local installer=$1
  local seven_zip=$2
  local extract_dir="$WORK_DIR/ghostscript"
  local gs_dir="$PAYLOAD_DIR/ocr/gs"

  if ! extract_with_7z "$installer" "$extract_dir" "$seven_zip"; then
    if ! is_windows_shell; then
      echo "Could not extract Ghostscript installer with 7-Zip." >&2
      exit 1
    fi
    rm -rf -- "$extract_dir"
    mkdir -p -- "$extract_dir"
    chmod +x "$installer"
    "$installer" /S "/D=$(windows_path "$extract_dir")"
  fi
  rm -rf -- "$extract_dir/\$PLUGINSDIR"

  rm -rf -- "$gs_dir"
  mkdir -p -- "$gs_dir"
  cp -R "$extract_dir"/. "$gs_dir"/
  if [[ ! -f "$gs_dir/bin/gswin64c.exe" ]]; then
    echo "Ghostscript payload is missing bin/gswin64c.exe" >&2
    exit 1
  fi
  cp -- "$gs_dir/bin/gswin64c.exe" "$gs_dir/bin/gs.exe"
}

install_qpdf() {
  local archive=$1
  local extract_dir="$WORK_DIR/qpdf"
  local qpdf_dir="$PAYLOAD_DIR/ocr/qpdf"
  local qpdf_exe source_bin license_file

  extract_zip "$archive" "$extract_dir"
  qpdf_exe=$(find "$extract_dir" -type f -name "qpdf.exe" -print -quit)
  if [[ -z "$qpdf_exe" ]]; then
    echo "QPDF payload is missing bin/qpdf.exe" >&2
    exit 1
  fi
  source_bin=$(dirname -- "$qpdf_exe")

  # The msvc64 zip ships no top-level LICENSE.txt; the license text lives in
  # the bundled manual sources. Accept either, newest layout first.
  license_file=$(find "$extract_dir" -type f -iname "LICENSE.txt" -print -quit)
  if [[ -z "$license_file" ]]; then
    license_file=$(find "$extract_dir" -type f -name "license.rst.txt" -path "*_sources*" -print -quit)
  fi
  if [[ -z "$license_file" ]]; then
    echo "QPDF payload is missing a license file (LICENSE.txt or license.rst.txt)" >&2
    exit 1
  fi

  rm -rf -- "$qpdf_dir"
  mkdir -p -- "$qpdf_dir/bin"
  cp -- "$qpdf_exe" "$qpdf_dir/bin/qpdf.exe"
  find "$source_bin" -maxdepth 1 -type f -iname "*.dll" -exec cp -- {} "$qpdf_dir/bin/" \;
  cp -- "$license_file" "$qpdf_dir/LICENSE.txt"
}

generate_payload_manifest() {
  "$PYTHON_CMD" - "$PAYLOAD_DIR" "$PAYLOAD_MANIFEST" <<'PY'
from pathlib import Path
import hashlib
import sys

payload_dir = Path(sys.argv[1]).resolve()
manifest_name = sys.argv[2]
manifest_path = payload_dir / manifest_name

def should_skip(path: Path) -> bool:
    relative = path.relative_to(payload_dir)
    return "__pycache__" in relative.parts or path.suffix == ".pyc"

rows = []
for path in sorted(payload_dir.rglob("*")):
    if not path.is_file() or path.name == manifest_name or should_skip(path):
        continue

    relative_path = path.relative_to(payload_dir).as_posix()
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    rows.append((relative_path, path.stat().st_size, digest))

with manifest_path.open("w", encoding="utf-8", newline="\n") as handle:
    handle.write("sha256\tsize\tpath\n")
    for relative_path, size, digest in rows:
        handle.write(f"{digest}\t{size}\t{relative_path}\n")
PY
}

verify_payload_manifest() {
  "$PYTHON_CMD" - "$PAYLOAD_DIR" "$PAYLOAD_MANIFEST" "${#REQUIRED_PAYLOAD_FILES[@]}" "${REQUIRED_PAYLOAD_FILES[@]}" "${REQUIRED_PAYLOAD_DIRS[@]}" <<'PY'
from pathlib import Path, PurePosixPath
import hashlib
import sys

payload_dir = Path(sys.argv[1]).resolve()
manifest_name = sys.argv[2]
required_file_count = int(sys.argv[3])
required_paths = set(sys.argv[4:4 + required_file_count])
required_dirs = set(sys.argv[4 + required_file_count:])
manifest_path = payload_dir / manifest_name

if not manifest_path.is_file():
    raise SystemExit(f"Missing payload manifest: {manifest_path}")

lines = manifest_path.read_text(encoding="utf-8").splitlines()
if not lines or lines[0] != "sha256\tsize\tpath":
    raise SystemExit(f"Invalid payload manifest header: {manifest_path}")

manifest = {}
errors = []

def should_skip(path: Path) -> bool:
    relative = path.relative_to(payload_dir)
    return "__pycache__" in relative.parts or path.suffix == ".pyc"

for line_number, line in enumerate(lines[1:], start=2):
    parts = line.split("\t")
    if len(parts) != 3:
        errors.append(f"{manifest_path}:{line_number}: expected sha256, size, path")
        continue

    expected_sha, expected_size_text, relative_path = parts
    if relative_path in manifest:
        errors.append(f"{manifest_path}:{line_number}: duplicate path {relative_path}")
        continue
    relative = PurePosixPath(relative_path)
    if (
        relative_path == manifest_name
        or relative.is_absolute()
        or any(part in {"", ".", ".."} for part in relative.parts)
    ):
        errors.append(f"{manifest_path}:{line_number}: invalid path {relative_path}")
        continue
    try:
        expected_size = int(expected_size_text)
    except ValueError:
        errors.append(f"{manifest_path}:{line_number}: invalid size for {relative_path}")
        continue
    manifest[relative_path] = (expected_sha, expected_size)

actual_paths = {
    path.relative_to(payload_dir).as_posix()
    for path in payload_dir.rglob("*")
    if path.is_file() and path.name != manifest_name and not should_skip(path)
}

for relative_path, (expected_sha, expected_size) in sorted(manifest.items()):
    path = payload_dir / relative_path
    if not path.is_file():
        errors.append(f"Missing payload file from manifest: {relative_path}")
        continue
    actual_size = path.stat().st_size
    if actual_size != expected_size:
        errors.append(
            f"Size mismatch for {relative_path}: expected {expected_size}, actual {actual_size}"
        )
    actual_sha = hashlib.sha256(path.read_bytes()).hexdigest()
    if actual_sha != expected_sha:
        errors.append(
            f"SHA256 mismatch for {relative_path}: expected {expected_sha}, actual {actual_sha}"
        )

missing_required = sorted(required_paths - set(manifest))
for relative_path in missing_required:
    errors.append(f"Required payload file missing from manifest: {relative_path}")

for relative_dir in sorted(required_dirs):
    directory = payload_dir / relative_dir
    if not directory.is_dir():
        errors.append(f"Required payload directory missing: {relative_dir}")
        continue
    prefix = relative_dir.rstrip("/") + "/"
    if not any(relative_path.startswith(prefix) for relative_path in manifest):
        errors.append(f"Required payload directory has no manifest entries: {relative_dir}")

extra_paths = sorted(actual_paths - set(manifest))
for relative_path in extra_paths:
    errors.append(f"Payload file missing from manifest: {relative_path}")

if errors:
    for error in errors:
        print(error, file=sys.stderr)
    raise SystemExit(1)

print(f"Verified {len(manifest)} payload files against {manifest_path}")
PY
}

verify_payload() {
  node "$REPO_ROOT/scripts/generate-legal-notices.mjs" --payload-dir "$PAYLOAD_DIR" --check
  verify_payload_manifest
  node "$REPO_ROOT/scripts/validate-package-boundary.mjs" \
    --platform windows-x64 \
    --root "$PAYLOAD_DIR"

  printf 'Payload assembled at %s\n' "$PAYLOAD_DIR"
  printf 'Payload size: %s\n' "$(du -sh "$PAYLOAD_DIR" | awk '{print $1}')"
}

if [[ "$MODE" == "verify" ]]; then
  PYTHON_CMD=$(find_python)
  need node
  verify_payload
  exit 0
fi

need curl
need node
PYTHON_CMD=$(find_python)
need sha256sum
need tar

if [[ "$(sha256_file "$REQ_FILE")" != "$OCRMYPDF_REQUIREMENTS_SHA256" ]]; then
  echo "Checksum mismatch for $OCRMYPDF_REQUIREMENTS" >&2
  exit 1
fi

rm -rf -- "$PAYLOAD_DIR"
mkdir -p -- "$PAYLOAD_DIR/ocr"
touch "$PAYLOAD_DIR/.gitkeep"

jre_zip=$(download_verified "temurin-jre-$TEMURIN_JRE_VERSION-windows-x64.zip" "$TEMURIN_JRE_URL" "$TEMURIN_JRE_SHA256")
jdk_zip=$(download_verified "temurin-jdk-$TEMURIN_JDK_VERSION-windows-x64.zip" "$TEMURIN_JDK_URL" "$TEMURIN_JDK_SHA256")
node_zip=$(download_verified "node-v$NODE_RUNTIME_VERSION-win-x64.zip" "$NODE_RUNTIME_URL" "$NODE_RUNTIME_SHA256")
python_zip=$(download_verified "python-$PYTHON_EMBED_VERSION-embed-amd64.zip" "$PYTHON_EMBED_URL" "$PYTHON_EMBED_SHA256")
tesseract_installer=$(download_verified "tesseract-$TESSERACT_VERSION-w64-setup.exe" "$TESSERACT_URL" "$TESSERACT_SHA256")
tessdata_eng=$(download_verified "tessdata-fast-$TESSDATA_FAST_VERSION-eng.traineddata" "$TESSDATA_ENG_URL" "$TESSDATA_ENG_SHA256")
ghostscript_installer=$(download_verified "ghostscript-$GHOSTSCRIPT_VERSION-w64.exe" "$GHOSTSCRIPT_URL" "$GHOSTSCRIPT_SHA256")
qpdf_zip=$(download_verified "qpdf-$QPDF_VERSION-msvc64.zip" "$QPDF_URL" "$QPDF_SHA256")

seven_zip=$(find_7z)

extract_zip "$jre_zip" "$WORK_DIR/jre"
copy_single_root_contents "$WORK_DIR/jre" "$PAYLOAD_DIR/jre"

BUILD_JDK_ZIP="$jdk_zip"
copy_engine_jar
install_node_runtime "$node_zip"
install_python_ocrmypdf "$python_zip"
install_tesseract "$tesseract_installer" "$tessdata_eng" "$seven_zip"
install_ghostscript "$ghostscript_installer" "$seven_zip"
install_qpdf "$qpdf_zip"
node "$SCRIPT_DIR/build-mcp-runtime.mjs"
node "$REPO_ROOT/scripts/generate-legal-notices.mjs" --payload-dir "$PAYLOAD_DIR"
generate_payload_manifest
verify_payload
