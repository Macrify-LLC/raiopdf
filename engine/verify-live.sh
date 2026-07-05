#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
DIST_DIR="$SCRIPT_DIR/dist"
JAR_PATH=${JAR_PATH:-}
JAVA_BIN=${JAVA_BIN:-}
HEALTH_PATH=${HEALTH_PATH:-/api/v1/info/status}

SERVER_PID=""
TMP_DIR=""

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "$TMP_DIR" ]]; then
    rm -rf -- "$TMP_DIR"
  fi
}
trap cleanup EXIT

latest_dist_jar() {
  local host_platform
  local host_match
  host_platform=$(detect_host_platform || true)

  if [[ -n "$host_platform" ]]; then
    # shellcheck disable=SC2012 # portable newest-file pick (find -printf is GNU-only)
    host_match=$(ls -t "$DIST_DIR"/stirling-pdf-*-"$host_platform".jar 2>/dev/null | head -n 1)
    if [[ -n "$host_match" ]]; then
      printf '%s\n' "$host_match"
      return 0
    fi
    echo "No host-native JAR found for $host_platform. Rebuild with PLATFORM=$host_platform or set JAR_PATH." >&2
    return 1
  fi

  find "$DIST_DIR" -maxdepth 1 -type f -name 'stirling-pdf-*.jar' -printf '%T@ %p\n' \
    | sort -n \
    | tail -n 1 \
    | cut -d' ' -f2-
}

detect_host_platform() {
  local os
  local arch
  os=$(uname -s)
  arch=$(uname -m)

  case "$os:$arch" in
    Linux:x86_64 | Linux:amd64)
      printf 'linux-x64\n'
      ;;
    Linux:aarch64 | Linux:arm64)
      printf 'linux-arm64\n'
      ;;
    Darwin:x86_64 | Darwin:amd64)
      printf 'darwin-x64\n'
      ;;
    Darwin:aarch64 | Darwin:arm64)
      printf 'darwin-arm64\n'
      ;;
    MINGW*:x86_64 | MSYS*:x86_64 | CYGWIN*:x86_64)
      printf 'windows-x64\n'
      ;;
  esac
}

java_major() {
  local candidate=$1
  local version
  version=$("$candidate" -XshowSettings:properties -version 2>&1 \
    | awk -F= '/java.specification.version/ {gsub(/[[:space:]]/, "", $2); print $2; exit}')
  if [[ "$version" == 1.* ]]; then
    printf '%s\n' "${version#1.}"
  else
    printf '%s\n' "$version"
  fi
}

is_java_25() {
  local candidate=$1
  local major
  major=$(java_major "$candidate" || true)
  [[ "$major" =~ ^[0-9]+$ && "$major" -ge 25 ]]
}

find_java_25() {
  local candidate

  if [[ -n "$JAVA_BIN" ]]; then
    if [[ -x "$JAVA_BIN" ]] && is_java_25 "$JAVA_BIN"; then
      printf '%s\n' "$JAVA_BIN"
      return 0
    fi
    echo "JAVA_BIN does not point to Java 25 or newer: $JAVA_BIN" >&2
    return 1
  fi

  candidate=$(command -v java || true)
  if [[ -n "$candidate" ]] && is_java_25 "$candidate"; then
    printf '%s\n' "$candidate"
    return 0
  fi

  while IFS= read -r candidate; do
    if [[ -x "$candidate" ]] && is_java_25 "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done < <(find "$HOME/.gradle/jdks" -type f -path '*/bin/java' 2>/dev/null | sort)

  echo "Could not find Java 25+. Build first so Gradle can auto-download Temurin 25, or set JAVA_BIN." >&2
  return 1
}

free_port() {
  python3 - <<'PY'
import socket

with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
}

create_test_pdf() {
  local output=$1
  python3 - "$output" <<'PY'
import sys

out = sys.argv[1]
objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
    b"<< /Length 44 >>\nstream\nBT /F1 18 Tf 50 100 Td (Page 1) Tj ET\nendstream",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
    b"<< /Length 44 >>\nstream\nBT /F1 18 Tf 50 100 Td (Page 2) Tj ET\nendstream",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
]

pdf = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
offsets = [0]
for index, body in enumerate(objects, start=1):
    offsets.append(len(pdf))
    pdf.extend(f"{index} 0 obj\n".encode("ascii"))
    pdf.extend(body)
    pdf.extend(b"\nendobj\n")

xref_offset = len(pdf)
pdf.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
pdf.extend(b"0000000000 65535 f \n")
for offset in offsets[1:]:
    pdf.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
pdf.extend(
    f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n".encode("ascii")
)

with open(out, "wb") as handle:
    handle.write(pdf)
PY
}

create_image_test_pdf() {
  local output=$1
  local image_stream_out=$2
  python3 - "$output" "$image_stream_out" <<'PY'
import sys
import zlib

out = sys.argv[1]
image_stream_out = sys.argv[2]

# 8x8 grayscale gradient, Flate-compressed: a decodable image whose raw
# encoded stream bytes must survive edit-text byte-identically.
pixels = bytes((x * 8 + y * 24) % 256 for x in range(8) for y in range(8))
image_data = zlib.compress(pixels, 9)

with open(image_stream_out, "wb") as handle:
    handle.write(image_data)

content = b"q 100 0 0 100 50 60 cm /Im1 Do Q BT /F1 18 Tf 20 20 Td (Exhibit) Tj ET"
image_dict = (
    b"<< /Type /XObject /Subtype /Image /Width 8 /Height 8"
    b" /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode"
    b" /Length " + str(len(image_data)).encode("ascii") + b" >>"
)
objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R"
    b" /Resources << /Font << /F1 6 0 R >> /XObject << /Im1 5 0 R >> >> >>",
    b"<< /Length " + str(len(content)).encode("ascii") + b" >>\nstream\n" + content + b"\nendstream",
    image_dict + b"\nstream\n" + image_data + b"\nendstream",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
]

pdf = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
offsets = [0]
for index, body in enumerate(objects, start=1):
    offsets.append(len(pdf))
    pdf.extend(f"{index} 0 obj\n".encode("ascii"))
    pdf.extend(body)
    pdf.extend(b"\nendobj\n")

xref_offset = len(pdf)
pdf.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
pdf.extend(b"0000000000 65535 f \n")
for offset in offsets[1:]:
    pdf.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
pdf.extend(
    f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref_offset}\n%%EOF\n".encode("ascii")
)

with open(out, "wb") as handle:
    handle.write(pdf)
PY
}

assert_pdf_text() {
  local label=$1
  local pdf=$2
  local required=$3
  local forbidden=$4
  python3 - "$pdf" "$required" "$forbidden" <<'PY' || { echo "$1 text assertion failed" >&2; exit 1; }
import re
import sys
import zlib

pdf_path, required, forbidden = sys.argv[1], sys.argv[2], sys.argv[3]
data = open(pdf_path, "rb").read()

haystacks = [data]
for match in re.finditer(rb"stream\r?\n", data):
    start = match.end()
    end = data.find(b"endstream", start)
    if end < 0:
        continue
    try:
        haystacks.append(zlib.decompress(data[start:end].rstrip(b"\r\n")))
    except zlib.error:
        continue

blob = b"\n".join(haystacks)
if required.encode("latin-1") not in blob:
    sys.exit(f"expected text not found in {pdf_path}: {required!r}")
if forbidden and forbidden.encode("latin-1") in blob:
    sys.exit(f"forbidden text still present in {pdf_path}: {forbidden!r}")
PY
  printf '%s: output text verified\n' "$label"
}

assert_bytes_present() {
  local label=$1
  local pdf=$2
  local needle_file=$3
  python3 - "$pdf" "$needle_file" <<'PY' || { echo "$1 byte-passthrough assertion failed" >&2; exit 1; }
import sys

data = open(sys.argv[1], "rb").read()
needle = open(sys.argv[2], "rb").read()
if not needle:
    sys.exit("empty needle")
if needle not in data:
    sys.exit(
        f"original stream bytes ({len(needle)} bytes) were not preserved in {sys.argv[1]};"
        " the image was re-encoded"
    )
PY
  printf '%s: original image stream preserved byte-identically\n' "$label"
}

curl_ok() {
  local label=$1
  local endpoint=$2
  local output=$3
  shift 3

  local status
  status=$(curl -sS -o "$output" -w '%{http_code}' \
    --connect-timeout 2 \
    --max-time 60 \
    -X POST \
    "$endpoint" \
    "$@")

  if [[ "$status" != "200" ]]; then
    echo "$label failed with HTTP $status" >&2
    if [[ -s "$output" ]]; then
      sed -n '1,80p' "$output" >&2 || true
    fi
    if [[ -n "${LOG_FILE:-}" && -s "$LOG_FILE" ]]; then
      echo "--- Stirling log tail ---" >&2
      tail -n 160 "$LOG_FILE" >&2 || true
    fi
    exit 1
  fi

  printf '%s: HTTP 200\n' "$label"
}

if [[ -z "$JAR_PATH" ]]; then
  JAR_PATH=$(latest_dist_jar)
fi

if [[ -z "$JAR_PATH" || ! -f "$JAR_PATH" ]]; then
  echo "No built engine JAR found. Run engine/build.sh first, or set JAR_PATH." >&2
  exit 1
fi

printf 'Verifying JAR: %s\n' "$JAR_PATH"

JAVA_BIN=$(find_java_25)
TMP_DIR=$(mktemp -d)
PORT=$(free_port)
BASE_PATH="$TMP_DIR/stirling-base"
LOG_FILE="$TMP_DIR/stirling.log"
INPUT_PDF="$TMP_DIR/input.pdf"

mkdir -p -- "$BASE_PATH"
create_test_pdf "$INPUT_PDF"

STIRLING_BASE_PATH="$BASE_PATH" "$JAVA_BIN" -Xmx1g -jar "$JAR_PATH" \
  --server.address=127.0.0.1 \
  "--server.port=$PORT" \
  --springdoc.api-docs.enabled=false \
  >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

BASE_URL="http://127.0.0.1:$PORT"

ready=false
for _ in $(seq 1 120); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "Stirling JVM exited before health became ready." >&2
    sed -n '1,220p' "$LOG_FILE" >&2 || true
    exit 1
  fi

  if curl -fsS --connect-timeout 1 --max-time 2 "$BASE_URL$HEALTH_PATH" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done

if [[ "$ready" != "true" ]]; then
  echo "Timed out waiting for Stirling health at $BASE_URL$HEALTH_PATH" >&2
  sed -n '1,220p' "$LOG_FILE" >&2 || true
  exit 1
fi

printf 'Stirling health ready: %s%s\n' "$BASE_URL" "$HEALTH_PATH"

curl_ok "merge-pdfs" "$BASE_URL/api/v1/general/merge-pdfs" "$TMP_DIR/merge.pdf" \
  -F "fileInput=@$INPUT_PDF;type=application/pdf" \
  -F "fileInput=@$INPUT_PDF;type=application/pdf" \
  -F "sortType=orderProvided" \
  -F "removeCertSign=true" \
  -F "generateToc=false"

curl_ok "split-pages" "$BASE_URL/api/v1/general/split-pages" "$TMP_DIR/split.zip" \
  -F "fileInput=@$INPUT_PDF;type=application/pdf" \
  -F "pageNumbers=1"

curl_ok "rotate-pdf" "$BASE_URL/api/v1/general/rotate-pdf" "$TMP_DIR/rotate.pdf" \
  -F "fileInput=@$INPUT_PDF;type=application/pdf" \
  -F "angle=90"

curl_ok "remove-pages" "$BASE_URL/api/v1/general/remove-pages" "$TMP_DIR/remove.pdf" \
  -F "fileInput=@$INPUT_PDF;type=application/pdf" \
  -F "pageNumbers=2"

curl_ok "rearrange-pages" "$BASE_URL/api/v1/general/rearrange-pages" "$TMP_DIR/rearrange.pdf" \
  -F "fileInput=@$INPUT_PDF;type=application/pdf" \
  -F "pageNumbers=2,1" \
  -F "customMode=CUSTOM"

curl_ok "edit-text" "$BASE_URL/api/v1/general/edit-text" "$TMP_DIR/edit-text.pdf" \
  -F "fileInput=@$INPUT_PDF;type=application/pdf" \
  -F 'edits=[{"find":"Page","replace":"Sheet"}]' \
  -F "wholeWordSearch=false" \
  -F "pageNumbers=all"
assert_pdf_text "edit-text" "$TMP_DIR/edit-text.pdf" "Sheet" "Page "

IMAGE_PDF="$TMP_DIR/image-input.pdf"
IMAGE_STREAM="$TMP_DIR/image-stream.bin"
create_image_test_pdf "$IMAGE_PDF" "$IMAGE_STREAM"

# Zero-match edit: the round trip must not re-encode the embedded image
# (requires the pdfjson image-passthrough functional patch; see ADR 0003).
curl_ok "edit-text-image-passthrough" "$BASE_URL/api/v1/general/edit-text" "$TMP_DIR/edit-text-image.pdf" \
  -F "fileInput=@$IMAGE_PDF;type=application/pdf" \
  -F 'edits=[{"find":"zz-no-such-text-zz","replace":"x"}]' \
  -F "wholeWordSearch=false" \
  -F "pageNumbers=all"
assert_bytes_present "edit-text-image-passthrough" "$TMP_DIR/edit-text-image.pdf" "$IMAGE_STREAM"

echo "Live engine contract test passed for $JAR_PATH"
