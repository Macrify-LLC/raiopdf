#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)

# shellcheck source=PINS.env
source "$SCRIPT_DIR/PINS.env"

TARGET_PLATFORM=${PAYLOAD_PLATFORM:-windows-x64}
if [[ "$TARGET_PLATFORM" != "windows-x64" ]]; then
  echo "Unsupported PAYLOAD_PLATFORM=$TARGET_PLATFORM; only windows-x64 is supported." >&2
  exit 1
fi

PAYLOAD_DIR="$REPO_ROOT/apps/shell/src-tauri/payload"
CACHE_DIR=${RAIOPDF_PAYLOAD_CACHE:-"$SCRIPT_DIR/.payload-cache"}
DOWNLOAD_DIR="$CACHE_DIR/downloads"
WORK_DIR="$CACHE_DIR/work"
REQ_FILE="$REPO_ROOT/$OCRMYPDF_REQUIREMENTS"

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
  python3 - "$zip_file" "$dest" <<'PY'
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
  local dist_jar

  dist_jar=$(find "$REPO_ROOT/engine/dist" -maxdepth 1 -type f -name "*-${TARGET_PLATFORM}.jar" -print -quit 2>/dev/null || true)
  if [[ -z "$dist_jar" ]]; then
    bash "$REPO_ROOT/engine/vendor.sh"
    PLATFORM="$TARGET_PLATFORM" bash "$REPO_ROOT/engine/build.sh"
    dist_jar=$(find "$REPO_ROOT/engine/dist" -maxdepth 1 -type f -name "*-${TARGET_PLATFORM}.jar" -print -quit)
  fi

  mkdir -p -- "$(dirname -- "$dest")"
  cp -- "$dist_jar" "$dest"
}

generate_python_third_party_notice() {
  local site_packages=$1
  local notice_file=$2

  python3 - "$site_packages" "$notice_file" <<'PY'
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
  python3 -m pip install \
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
    python3 - "$pth_file" <<'PY'
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
"%~dp0python\python.exe" -m ocrmypdf %*
EOF

  generate_python_third_party_notice "$python_dir/Lib/site-packages" "$PAYLOAD_DIR/ocr/THIRD-PARTY-PYTHON.md"
}

install_tesseract() {
  local installer=$1
  local eng_data=$2
  local seven_zip=$3
  local extract_dir="$WORK_DIR/tesseract"
  local tess_dir="$PAYLOAD_DIR/ocr/tesseract"

  extract_with_7z "$installer" "$extract_dir" "$seven_zip"
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

  extract_with_7z "$installer" "$extract_dir" "$seven_zip"
  rm -rf -- "$extract_dir/\$PLUGINSDIR"

  rm -rf -- "$gs_dir"
  mkdir -p -- "$gs_dir"
  cp -R "$extract_dir"/. "$gs_dir"/
}

verify_payload() {
  local missing=0
  local path
  for path in \
    "$PAYLOAD_DIR/jre/bin/java.exe" \
    "$PAYLOAD_DIR/engine/stirling.jar" \
    "$PAYLOAD_DIR/ocr/THIRD-PARTY-PYTHON.md" \
    "$PAYLOAD_DIR/ocr/ocrmypdf.cmd" \
    "$PAYLOAD_DIR/ocr/python/python.exe" \
    "$PAYLOAD_DIR/ocr/tesseract/tesseract.exe" \
    "$PAYLOAD_DIR/ocr/tesseract/tessdata/eng.traineddata" \
    "$PAYLOAD_DIR/ocr/gs/bin/gswin64c.exe"; do
    if [[ ! -f "$path" ]]; then
      echo "Missing expected payload file: $path" >&2
      missing=1
    fi
  done

  if [[ "$missing" != 0 ]]; then
    exit 1
  fi

  printf 'Payload assembled at %s\n' "$PAYLOAD_DIR"
  printf 'Payload size: %s\n' "$(du -sh "$PAYLOAD_DIR" | awk '{print $1}')"
}

if [[ "$MODE" == "verify" ]]; then
  verify_payload
  exit 0
fi

need curl
need python3
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
python_zip=$(download_verified "python-$PYTHON_EMBED_VERSION-embed-amd64.zip" "$PYTHON_EMBED_URL" "$PYTHON_EMBED_SHA256")
tesseract_installer=$(download_verified "tesseract-$TESSERACT_VERSION-w64-setup.exe" "$TESSERACT_URL" "$TESSERACT_SHA256")
tessdata_eng=$(download_verified "tessdata-fast-$TESSDATA_FAST_VERSION-eng.traineddata" "$TESSDATA_ENG_URL" "$TESSDATA_ENG_SHA256")
ghostscript_installer=$(download_verified "ghostscript-$GHOSTSCRIPT_VERSION-w64.exe" "$GHOSTSCRIPT_URL" "$GHOSTSCRIPT_SHA256")

seven_zip=$(find_7z)

extract_zip "$jre_zip" "$WORK_DIR/jre"
copy_single_root_contents "$WORK_DIR/jre" "$PAYLOAD_DIR/jre"

copy_engine_jar
install_python_ocrmypdf "$python_zip"
install_tesseract "$tesseract_installer" "$tessdata_eng" "$seven_zip"
install_ghostscript "$ghostscript_installer" "$seven_zip"
verify_payload
