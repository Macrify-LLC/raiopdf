#!/usr/bin/env bash
set -Eeuo pipefail

# RaioPDF macOS arm64 payload assembler.
#
# Mirrors installer/assemble-windows-x64.sh, but the native OCR stack
# (Ghostscript, qpdf, Tesseract + Leptonica + image libs) is BUILT FROM PINNED
# SOURCE into self-contained arm64 binaries that link only system libraries
# (/usr/lib, /System). The bundled Python comes from python-build-standalone
# (relocatable by design). Homebrew binaries are never shipped in the payload;
# Homebrew is only used as a source of build TOOLS (cmake/autotools), never as a
# source of linked libraries. See docs and PINS.macos-arm64.env.

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)

# shellcheck source=PINS.macos-arm64.env
source "${RAIOPDF_PINS_FILE:-$SCRIPT_DIR/PINS.macos-arm64.env}"

TARGET_PLATFORM=${RAIOPDF_PLATFORM:-${PAYLOAD_PLATFORM:-macos-arm64}}
if [[ "$TARGET_PLATFORM" != "macos-arm64" ]]; then
  echo "assemble-macos-arm64: expected macos-arm64, got $TARGET_PLATFORM." >&2
  exit 1
fi

# jpdfium native platform token for the Stirling engine build (NOT the payload id).
ENGINE_PLATFORM=darwin-arm64

PAYLOAD_DIR=${RAIOPDF_PAYLOAD_DIR:-"$REPO_ROOT/apps/shell/src-tauri/payload/macos-arm64"}
PAYLOAD_MANIFEST="RAIOPDF-PAYLOAD-MANIFEST.tsv"
CACHE_DIR=${RAIOPDF_PAYLOAD_CACHE:-"$SCRIPT_DIR/.payload-cache/macos-arm64"}
DOWNLOAD_DIR="$CACHE_DIR/downloads"
WORK_DIR="$CACHE_DIR/work"
PREFIX_ROOT="$CACHE_DIR/prefix"
REQ_FILE="$REPO_ROOT/$OCRMYPDF_REQUIREMENTS"

REQUIRED_PAYLOAD_FILES=(
  "jre/bin/java"
  "engine/stirling.jar"
  "mcp/app/index.mjs"
  "mcp/node/bin/node"
  "mcp/node/LICENSE"
  "ocr/THIRD-PARTY-PYTHON.md"
  "ocr/ocrmypdf"
  "ocr/raiopdf-ocr-progress"
  "ocr/raiopdf_ocr_progress.py"
  "ocr/raiopdf_ocr_progress_plugin.py"
  "ocr/python/bin/python3"
  "ocr/tesseract/bin/tesseract"
  "ocr/tesseract/share/tessdata/eng.traineddata"
  "ocr/gs/bin/gs"
  "ocr/qpdf/bin/qpdf"
  "legal/THIRD-PARTY-NOTICES.txt"
  "legal/COMPONENT-MANIFEST.json"
  "legal/RELEASE-SOURCE-CORRESPONDENCE.md"
  "legal/RAIOPDF-LICENSE-NOTICES.txt"
  "legal/source-offers/GHOSTSCRIPT-SOURCE-OFFER.txt"
  "legal/licenses/GPL-3.0.txt"
  "legal/licenses/AGPL-3.0.txt"
  "legal/licenses/MPL-2.0.txt"
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

NCPU=$(sysctl -n hw.ncpu 2>/dev/null || echo 4)

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1${2:+ ($2)}" >&2
    exit 1
  fi
}

sha256_file() {
  shasum -a 256 "$1" | awk '{print $1}'
}

# Host python used only for orchestration (extracting archives, driving pip into
# the bundled interpreter). Falls back to the bundled interpreter once staged.
find_host_python() {
  local candidate
  for candidate in python3 python; do
    if command -v "$candidate" >/dev/null 2>&1 &&
      "$candidate" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 9) else 1)' >/dev/null 2>&1; then
      command -v "$candidate"
      return
    fi
  done
  echo "Missing a host python3 (>=3.9) for archive extraction." >&2
  exit 1
}

download_verified() {
  local name=$1 url=$2 expected_sha=$3
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

# Extract a tarball (gz/xz) into a fresh destination and echo the single
# top-level directory it unpacked (most upstream tarballs have exactly one).
extract_tarball() {
  local archive=$1 dest=$2
  rm -rf -- "$dest"
  mkdir -p -- "$dest"
  tar -xf "$archive" -C "$dest"
}

single_child_dir() {
  local dir=$1 count first
  count=$(find "$dir" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')
  if [[ "$count" == "1" ]]; then
    first=$(find "$dir" -mindepth 1 -maxdepth 1 -print -quit)
    if [[ -d "$first" ]]; then
      printf '%s\n' "$first"
      return
    fi
  fi
  printf '%s\n' "$dir"
}

# ---------------------------------------------------------------------------
# Native OCR toolchain — built from pinned source into $PREFIX_ROOT/*.
# Each builder is guarded: if its product already runs, the rebuild is skipped
# so re-runs after a later failure stay fast. Homebrew is only a build-tool
# source; nothing under /opt/homebrew is linked into the results.
# ---------------------------------------------------------------------------

PREFIX_JPEG="$PREFIX_ROOT/jpeg"
PREFIX_PNG="$PREFIX_ROOT/png"
PREFIX_TIFF="$PREFIX_ROOT/tiff"
PREFIX_LEPT="$PREFIX_ROOT/lept"
PREFIX_GS="$PREFIX_ROOT/gs"
PREFIX_QPDF="$PREFIX_ROOT/qpdf"
PREFIX_TESS="$PREFIX_ROOT/tess"

build_libjpeg_turbo() {
  if [[ -f "$PREFIX_JPEG/lib/libjpeg.a" ]]; then
    echo "Using cached libjpeg-turbo static build" >&2
    return
  fi
  local src work
  src=$(download_verified "libjpeg-turbo-$LIBJPEG_TURBO_VERSION.tar.gz" "$LIBJPEG_TURBO_SOURCE_URL" "$LIBJPEG_TURBO_SOURCE_SHA256")
  extract_tarball "$src" "$WORK_DIR/jpeg"
  work=$(single_child_dir "$WORK_DIR/jpeg")
  rm -rf -- "$PREFIX_JPEG" "$WORK_DIR/jpeg-build"
  cmake -S "$work" -B "$WORK_DIR/jpeg-build" \
    -DCMAKE_BUILD_TYPE=Release -DENABLE_SHARED=0 -DENABLE_STATIC=1 \
    -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_INSTALL_PREFIX="$PREFIX_JPEG"
  cmake --build "$WORK_DIR/jpeg-build" -j"$NCPU"
  cmake --install "$WORK_DIR/jpeg-build"
}

build_libpng() {
  if [[ -f "$PREFIX_PNG/lib/libpng16.a" ]]; then
    echo "Using cached libpng static build" >&2
    return
  fi
  local src work
  src=$(download_verified "libpng-$LIBPNG_VERSION.tar.xz" "$LIBPNG_SOURCE_URL" "$LIBPNG_SOURCE_SHA256")
  extract_tarball "$src" "$WORK_DIR/png"
  work=$(single_child_dir "$WORK_DIR/png")
  rm -rf -- "$PREFIX_PNG"
  ( cd "$work"
    ./configure --prefix="$PREFIX_PNG" --disable-shared --enable-static
    make -j"$NCPU"
    make install )
}

build_libtiff() {
  if [[ -f "$PREFIX_TIFF/lib/libtiff.a" ]]; then
    echo "Using cached libtiff static build" >&2
    return
  fi
  local src work
  src=$(download_verified "tiff-$LIBTIFF_VERSION.tar.gz" "$LIBTIFF_SOURCE_URL" "$LIBTIFF_SOURCE_SHA256")
  extract_tarball "$src" "$WORK_DIR/tiff"
  work=$(single_child_dir "$WORK_DIR/tiff")
  rm -rf -- "$PREFIX_TIFF"
  ( cd "$work"
    export PKG_CONFIG_PATH="$PREFIX_JPEG/lib/pkgconfig"
    export PKG_CONFIG_LIBDIR=""
    ./configure --prefix="$PREFIX_TIFF" --disable-shared --enable-static \
      --disable-lzma --disable-zstd --disable-webp --disable-jbig \
      CPPFLAGS="-I$PREFIX_JPEG/include" LDFLAGS="-L$PREFIX_JPEG/lib"
    make -j"$NCPU"
    make install )
}

build_leptonica() {
  if [[ -f "$PREFIX_LEPT/lib/libleptonica.a" ]]; then
    echo "Using cached leptonica static build" >&2
    return
  fi
  local src work
  src=$(download_verified "leptonica-$LEPTONICA_VERSION.tar.gz" "$LEPTONICA_SOURCE_URL" "$LEPTONICA_SOURCE_SHA256")
  extract_tarball "$src" "$WORK_DIR/lept"
  work=$(single_child_dir "$WORK_DIR/lept")
  rm -rf -- "$PREFIX_LEPT"
  ( cd "$work"
    export PKG_CONFIG_PATH="$PREFIX_PNG/lib/pkgconfig:$PREFIX_JPEG/lib/pkgconfig:$PREFIX_TIFF/lib/pkgconfig"
    export PKG_CONFIG_LIBDIR=""
    ./configure --prefix="$PREFIX_LEPT" --disable-shared --enable-static \
      --without-giflib --without-libwebp --without-libwebpmux --without-libopenjpeg \
      CPPFLAGS="-I$PREFIX_PNG/include -I$PREFIX_JPEG/include -I$PREFIX_TIFF/include" \
      LDFLAGS="-L$PREFIX_PNG/lib -L$PREFIX_JPEG/lib -L$PREFIX_TIFF/lib"
    make -j"$NCPU"
    make install )
}

build_tesseract() {
  if [[ -x "$PREFIX_TESS/bin/tesseract" ]] && "$PREFIX_TESS/bin/tesseract" --version >/dev/null 2>&1; then
    echo "Using cached tesseract build" >&2
    return
  fi
  build_libjpeg_turbo
  build_libpng
  build_libtiff
  build_leptonica
  local src work
  src=$(download_verified "tesseract-$TESSERACT_VERSION.tar.gz" "$TESSERACT_SOURCE_URL" "$TESSERACT_SOURCE_SHA256")
  extract_tarball "$src" "$WORK_DIR/tess"
  work=$(single_child_dir "$WORK_DIR/tess")
  rm -rf -- "$PREFIX_TESS"
  ( cd "$work"
    ./autogen.sh
    export PKG_CONFIG_PATH="$PREFIX_LEPT/lib/pkgconfig:$PREFIX_PNG/lib/pkgconfig:$PREFIX_JPEG/lib/pkgconfig:$PREFIX_TIFF/lib/pkgconfig"
    export PKG_CONFIG_LIBDIR=""
    ./configure --prefix="$PREFIX_TESS" --disable-shared --enable-static \
      --without-curl --without-archive --without-tensorflow --disable-openmp \
      CPPFLAGS="-I$PREFIX_LEPT/include/leptonica -I$PREFIX_PNG/include -I$PREFIX_JPEG/include -I$PREFIX_TIFF/include" \
      LDFLAGS="-L$PREFIX_LEPT/lib -L$PREFIX_PNG/lib -L$PREFIX_JPEG/lib -L$PREFIX_TIFF/lib"
    make -j"$NCPU"
    make install )
}

build_ghostscript() {
  if [[ -x "$PREFIX_GS/bin/gs" ]] && "$PREFIX_GS/bin/gs" -v >/dev/null 2>&1; then
    echo "Using cached ghostscript build" >&2
    return
  fi
  local src work
  src=$(download_verified "ghostscript-$GHOSTSCRIPT_VERSION.tar.xz" "$GHOSTSCRIPT_SOURCE_URL" "$GHOSTSCRIPT_SOURCE_SHA256")
  extract_tarball "$src" "$WORK_DIR/gs"
  work=$(single_child_dir "$WORK_DIR/gs")
  rm -rf -- "$PREFIX_GS"
  # Reduce PATH and clear compiler/pkg-config env so configure prefers
  # Ghostscript's bundled library trees over any Homebrew copies.
  ( cd "$work"
    export PATH="/usr/bin:/bin:/usr/sbin:/sbin"
    unset PKG_CONFIG_PATH PKG_CONFIG_LIBDIR CPPFLAGS LDFLAGS CFLAGS CXXFLAGS CC CXX
    ./configure --prefix="$PREFIX_GS" \
      --disable-cups --disable-dbus --disable-gtk --without-x \
      --without-tesseract --with-libpaper=no --disable-fontconfig
    make -j"$NCPU"
    make install )
}

build_qpdf() {
  if [[ -x "$PREFIX_QPDF/bin/qpdf" ]] && "$PREFIX_QPDF/bin/qpdf" --version >/dev/null 2>&1; then
    echo "Using cached qpdf build" >&2
    return
  fi
  build_libjpeg_turbo
  local src work
  src=$(download_verified "qpdf-$QPDF_VERSION.tar.gz" "$QPDF_SOURCE_URL" "$QPDF_SOURCE_SHA256")
  extract_tarball "$src" "$WORK_DIR/qpdf"
  work=$(single_child_dir "$WORK_DIR/qpdf")
  rm -rf -- "$PREFIX_QPDF" "$WORK_DIR/qpdf-build"
  # Pin pkg-config to ONLY our static libjpeg-turbo so qpdf never picks up a
  # Homebrew jpeg. zlib resolves to the macOS SDK libz. Native crypto only.
  ( export PKG_CONFIG_LIBDIR="$PREFIX_JPEG/lib/pkgconfig"
    export PKG_CONFIG_PATH=""
    cmake -S "$work" -B "$WORK_DIR/qpdf-build" -DCMAKE_BUILD_TYPE=Release \
      -DCMAKE_PREFIX_PATH="$PREFIX_JPEG" \
      -DREQUIRE_CRYPTO_NATIVE=1 -DUSE_IMPLICIT_CRYPTO=0 \
      -DBUILD_STATIC_LIBS=1 -DBUILD_SHARED_LIBS=0 \
      -DINSTALL_MANUAL=0 -DBUILD_DOC=0 \
      -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_INSTALL_PREFIX="$PREFIX_QPDF"
    cmake --build "$WORK_DIR/qpdf-build" -j"$NCPU"
    cmake --install "$WORK_DIR/qpdf-build" )
}

stage_native_ocr_tools() {
  build_ghostscript
  build_qpdf
  build_tesseract

  mkdir -p -- "$PAYLOAD_DIR/ocr/gs/bin" "$PAYLOAD_DIR/ocr/qpdf/bin" \
    "$PAYLOAD_DIR/ocr/tesseract/bin" "$PAYLOAD_DIR/ocr/tesseract/share/tessdata"
  cp -- "$PREFIX_GS/bin/gs" "$PAYLOAD_DIR/ocr/gs/bin/gs"
  cp -- "$PREFIX_QPDF/bin/qpdf" "$PAYLOAD_DIR/ocr/qpdf/bin/qpdf"
  cp -- "$PREFIX_TESS/bin/tesseract" "$PAYLOAD_DIR/ocr/tesseract/bin/tesseract"
  chmod +x "$PAYLOAD_DIR/ocr/gs/bin/gs" "$PAYLOAD_DIR/ocr/qpdf/bin/qpdf" \
    "$PAYLOAD_DIR/ocr/tesseract/bin/tesseract"

  local tessdata
  tessdata=$(download_verified "tessdata-fast-$TESSDATA_FAST_VERSION-eng.traineddata" "$TESSDATA_ENG_URL" "$TESSDATA_ENG_SHA256")
  cp -- "$tessdata" "$PAYLOAD_DIR/ocr/tesseract/share/tessdata/eng.traineddata"
}

# ---------------------------------------------------------------------------
# Relocatable runtime staging.
# ---------------------------------------------------------------------------

install_jre() {
  local jre_tar extract_dir home_dir
  jre_tar=$(download_verified "temurin-jre-$TEMURIN_JRE_VERSION-aarch64-mac.tar.gz" "$TEMURIN_JRE_URL" "$TEMURIN_JRE_SHA256")
  extract_dir="$WORK_DIR/jre"
  extract_tarball "$jre_tar" "$extract_dir"
  home_dir=$(find "$extract_dir" -type d -path "*/Contents/Home" -print -quit)
  if [[ -z "$home_dir" ]]; then
    echo "Could not find Contents/Home in the Temurin JRE archive." >&2
    exit 1
  fi
  rm -rf -- "$PAYLOAD_DIR/jre"
  mkdir -p -- "$PAYLOAD_DIR/jre"
  cp -R "$home_dir"/. "$PAYLOAD_DIR/jre"/
}

install_node_runtime() {
  local node_tar extract_dir node_root
  node_tar=$(download_verified "node-v$NODE_RUNTIME_VERSION-darwin-arm64.tar.gz" "$NODE_RUNTIME_URL" "$NODE_RUNTIME_SHA256")
  extract_dir="$WORK_DIR/node"
  extract_tarball "$node_tar" "$extract_dir"
  node_root=$(single_child_dir "$extract_dir")
  rm -rf -- "$PAYLOAD_DIR/mcp/node"
  mkdir -p -- "$PAYLOAD_DIR/mcp/node/bin"
  cp -- "$node_root/bin/node" "$PAYLOAD_DIR/mcp/node/bin/node"
  cp -- "$node_root/LICENSE" "$PAYLOAD_DIR/mcp/node/LICENSE"
  chmod +x "$PAYLOAD_DIR/mcp/node/bin/node"
}

install_python_ocrmypdf() {
  local py_tar extract_dir python_dir site_packages
  py_tar=$(download_verified "cpython-$PYTHON_STANDALONE_VERSION-$PYTHON_STANDALONE_RELEASE-aarch64-apple-darwin-install_only.tar.gz" "$PYTHON_STANDALONE_URL" "$PYTHON_STANDALONE_SHA256")
  extract_dir="$WORK_DIR/python"
  extract_tarball "$py_tar" "$extract_dir"
  # python-build-standalone install_only unpacks a single top-level "python" dir.
  python_dir="$PAYLOAD_DIR/ocr/python"
  rm -rf -- "$python_dir"
  mkdir -p -- "$(dirname -- "$python_dir")"
  cp -R "$extract_dir/python" "$python_dir"

  site_packages="$python_dir/lib/python$PYTHON_VERSION/site-packages"
  "$python_dir/bin/python3" -m ensurepip --upgrade >/dev/null 2>&1 || true
  # Install OCRmyPDF + hash-pinned deps directly into the bundled interpreter.
  "$python_dir/bin/python3" -m pip install \
    --no-input --disable-pip-version-check \
    --no-compile --require-hashes --only-binary=:all: \
    -r "$REQ_FILE"

  # POSIX launcher: run the bundled interpreter's ocrmypdf module. The engine
  # adds the bundled tesseract/gs dirs to PATH before invoking this.
  cat >"$PAYLOAD_DIR/ocr/ocrmypdf" <<'EOF'
#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
export PYTHONHOME="$DIR/python"
export PYTHONDONTWRITEBYTECODE=1
exec "$DIR/python/bin/python3" -m ocrmypdf "$@"
EOF
  chmod +x "$PAYLOAD_DIR/ocr/ocrmypdf"

  cp "$REPO_ROOT/installer/ocr/raiopdf_ocr_progress.py" "$PAYLOAD_DIR/ocr/raiopdf_ocr_progress.py"
  cp "$REPO_ROOT/installer/ocr/raiopdf_ocr_progress_plugin.py" "$PAYLOAD_DIR/ocr/raiopdf_ocr_progress_plugin.py"
  cat >"$PAYLOAD_DIR/ocr/raiopdf-ocr-progress" <<'EOF'
#!/bin/sh
DIR="$(cd "$(dirname "$0")" && pwd)"
export PYTHONHOME="$DIR/python"
export PYTHONDONTWRITEBYTECODE=1
exec "$DIR/python/bin/python3" "$DIR/raiopdf_ocr_progress.py" "$@"
EOF
  chmod +x "$PAYLOAD_DIR/ocr/raiopdf-ocr-progress"

  generate_python_third_party_notice "$site_packages" "$PAYLOAD_DIR/ocr/THIRD-PARTY-PYTHON.md"
}

generate_python_third_party_notice() {
  local site_packages=$1 notice_file=$2
  "$HOST_PYTHON" - "$site_packages" "$notice_file" <<'PY'
from email import policy
from email.parser import BytesParser
from pathlib import Path
import re, sys

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
    for label in ("homepage","home","source","source code","repository","code","documentation"):
        if label in urls:
            return urls[label]
    return None

rows = []
for metadata_file in metadata_files:
    with metadata_file.open("rb") as handle:
        metadata = BytesParser(policy=policy.default).parse(handle)
    fallback_name = metadata_file.parent.name
    if fallback_name.endswith(".dist-info"):
        fallback_name = fallback_name[:-len(".dist-info")]
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
    lines.append(f"| {clean(name)} | {clean(version)} | {clean(license_value)} | {clean(home)} |")
notice_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
}

copy_engine_jar() {
  local dest="$PAYLOAD_DIR/engine/stirling.jar"
  local pinned_tag dist_jar
  pinned_tag=$(<"$REPO_ROOT/engine/PINNED_TAG")
  dist_jar="$REPO_ROOT/engine/dist/stirling-pdf-${pinned_tag#v}-${ENGINE_PLATFORM}.jar"

  # Reuse an already-verified engine JAR (matching tag/commit/platform/sha256)
  # to skip a costly re-vendor + gradle rebuild.
  if ! verify_engine_dist_jar "$dist_jar"; then
    bash "$REPO_ROOT/engine/vendor.sh"
    PLATFORM="$ENGINE_PLATFORM" bash "$REPO_ROOT/engine/build.sh"
  fi
  if ! verify_engine_dist_jar "$dist_jar"; then
    echo "Could not find a verified engine dist JAR for $ENGINE_PLATFORM." >&2
    exit 1
  fi
  mkdir -p -- "$(dirname -- "$dest")"
  cp -- "$dist_jar" "$dest"
}

verify_engine_dist_jar() {
  local dist_jar=$1 manifest="$1.source" expected_tag expected_commit actual_sha
  expected_tag=$(<"$REPO_ROOT/engine/PINNED_TAG")
  expected_commit=$(<"$REPO_ROOT/engine/PINNED_COMMIT")
  if [[ ! -f "$dist_jar" || ! -f "$manifest" ]]; then
    return 1
  fi
  actual_sha=$(sha256_file "$dist_jar")
  grep -Fx "tag=$expected_tag" "$manifest" >/dev/null &&
    grep -Fx "commit=$expected_commit" "$manifest" >/dev/null &&
    grep -Fx "platform=$ENGINE_PLATFORM" "$manifest" >/dev/null &&
    grep -Fx "sha256=$actual_sha" "$manifest" >/dev/null
}

# ---------------------------------------------------------------------------
# Relocatability pass: dereference symlinks (the boundary validator forbids
# them), thin any fat/universal Mach-O to arm64, strip Python bytecode caches,
# and re-apply an ad-hoc signature to anything we modified so dlopen/exec
# succeed on Apple Silicon. No Developer ID / notarization is involved.
# ---------------------------------------------------------------------------

# Remove Windows/foreign artifacts the macOS boundary forbids and runtime-
# unnecessary tooling from the bundled CPython. python-build-standalone ships a
# full stdlib (idlelib, venv scripts, pip's vendored Windows launchers) that
# carries .bat/.exe/.ps1/.ico files no macOS payload needs.
prune_payload() {
  echo "Pruning foreign artifacts and unused Python tooling..." >&2
  local py_lib="$PAYLOAD_DIR/ocr/python/lib/python$PYTHON_VERSION"
  rm -rf -- \
    "$py_lib/idlelib" \
    "$py_lib/turtledemo" \
    "$py_lib/test" \
    "$py_lib/ensurepip" \
    "$py_lib/venv/scripts" \
    2>/dev/null || true
  # pip is only needed at assembly time to install OCRmyPDF; drop it (and its
  # vendored Windows .exe launchers) from the shipped runtime.
  rm -rf -- "$py_lib"/site-packages/pip "$py_lib"/site-packages/pip-*.dist-info 2>/dev/null || true
  # Any remaining foreign-extension files anywhere in the payload.
  find "$PAYLOAD_DIR" -type f \( \
    -name "*.bat" -o -name "*.cmd" -o -name "*.exe" -o -name "*.dll" \
    -o -name "*.msi" -o -name "*.ps1" -o -name "*.ico" \) -delete 2>/dev/null || true
}

make_relocatable() {
  prune_payload
  echo "Dereferencing symlinks under payload..." >&2
  # Resolve symlinks to real content (targets are internal to the payload:
  # JRE/Python/Node ship internal symlinks). Iterate until none remain.
  local pass=0 remaining
  while :; do
    remaining=$(find "$PAYLOAD_DIR" -type l | wc -l | tr -d ' ')
    [[ "$remaining" == "0" ]] && break
    pass=$((pass + 1))
    if (( pass > 10 )); then
      echo "Too many symlink resolution passes; possible cycle." >&2
      find "$PAYLOAD_DIR" -type l >&2
      exit 1
    fi
    while IFS= read -r link; do
      [[ -z "$link" ]] && continue
      local target
      target=$(cd "$(dirname "$link")" && python_realpath "$link") || target=""
      if [[ -z "$target" || ! -e "$target" ]]; then
        echo "Removing broken symlink: $link" >&2
        rm -f -- "$link"
        continue
      fi
      rm -f -- "$link"
      if [[ -d "$target" ]]; then
        cp -R "$target" "$link"
      else
        cp -- "$target" "$link"
      fi
    done < <(find "$PAYLOAD_DIR" -type l)
  done

  echo "Stripping Python bytecode caches..." >&2
  find "$PAYLOAD_DIR" -type d -name "__pycache__" -prune -exec rm -rf {} + 2>/dev/null || true
  find "$PAYLOAD_DIR" -type f -name "*.pyc" -delete 2>/dev/null || true

  echo "Thinning fat Mach-O binaries to arm64..." >&2
  local file info
  while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    info=$(lipo -info "$file" 2>/dev/null || true)
    if [[ "$info" == *"Architectures in the fat file"* ]]; then
      lipo "$file" -thin arm64 -output "$file.arm64.tmp"
      mv -f -- "$file.arm64.tmp" "$file"
      codesign --remove-signature "$file" >/dev/null 2>&1 || true
      codesign -s - -f "$file" >/dev/null 2>&1 || true
    fi
  done < <(find "$PAYLOAD_DIR" -type f \( -name "*.dylib" -o -name "*.so" -o -perm -100 \))
}

# realpath is not on stock macOS; use python for a portable canonical path.
python_realpath() {
  "$HOST_PYTHON" -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"
}

generate_payload_manifest() {
  node "$SCRIPT_DIR/payload-manifest.mjs" --generate --platform macos-arm64 --payload-dir "$PAYLOAD_DIR" \
    "${manifest_require_args[@]}"
}

verify_payload() {
  node "$REPO_ROOT/scripts/generate-legal-notices.mjs" --platform macos-arm64 --payload-dir "$PAYLOAD_DIR" --check
  node "$SCRIPT_DIR/payload-manifest.mjs" --verify --platform macos-arm64 --payload-dir "$PAYLOAD_DIR" \
    "${manifest_require_args[@]}"
  node "$REPO_ROOT/scripts/validate-package-boundary.mjs" --platform macos-arm64 --root "$PAYLOAD_DIR"
  printf 'Payload assembled at %s\n' "$PAYLOAD_DIR"
  printf 'Payload size: %s\n' "$(du -sh "$PAYLOAD_DIR" | awk '{print $1}')"
}

# Build the --require argument list once for both generate and verify.
manifest_require_args=()
for required in "${REQUIRED_PAYLOAD_FILES[@]}"; do
  manifest_require_args+=(--require "$required")
done

if [[ "$MODE" == "verify" ]]; then
  HOST_PYTHON=$(find_host_python)
  need node
  verify_payload
  exit 0
fi

need curl
need node
need cmake "Homebrew build tool for qpdf/libjpeg-turbo"
need make
need clang
need autoreconf "Homebrew autoconf/automake/libtool for tesseract"
need pkg-config "Homebrew pkg-config for tesseract/leptonica"
HOST_PYTHON=$(find_host_python)

if [[ "$(sha256_file "$REQ_FILE")" != "$OCRMYPDF_REQUIREMENTS_SHA256" ]]; then
  echo "Checksum mismatch for $OCRMYPDF_REQUIREMENTS" >&2
  exit 1
fi

mkdir -p -- "$DOWNLOAD_DIR" "$WORK_DIR" "$PREFIX_ROOT"

# Build native OCR tools first (into the persistent cache prefixes) so a failure
# here surfaces before the payload dir is wiped.
build_ghostscript
build_qpdf
build_tesseract

rm -rf -- "$PAYLOAD_DIR"
mkdir -p -- "$PAYLOAD_DIR/ocr"
touch "$PAYLOAD_DIR/.gitkeep"

install_jre
copy_engine_jar
install_node_runtime
install_python_ocrmypdf
stage_native_ocr_tools
node "$SCRIPT_DIR/build-mcp-runtime.mjs" --platform macos-arm64
node "$REPO_ROOT/scripts/generate-legal-notices.mjs" --platform macos-arm64 --payload-dir "$PAYLOAD_DIR"
make_relocatable
rm -f -- "$PAYLOAD_DIR/.gitkeep"
generate_payload_manifest
verify_payload
