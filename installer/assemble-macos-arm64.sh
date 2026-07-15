#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)

TARGET_PLATFORM=${RAIOPDF_PLATFORM:-${PAYLOAD_PLATFORM:-macos-arm64}}
if [[ "$TARGET_PLATFORM" != "macos-arm64" ]]; then
  echo "assemble-macos-arm64: expected macos-arm64, got $TARGET_PLATFORM." >&2
  exit 1
fi

PAYLOAD_DIR=${RAIOPDF_PAYLOAD_DIR:-"$REPO_ROOT/apps/shell/src-tauri/payload/macos-arm64"}
REQUIRED_PAYLOAD_FILES=(
  "jre/bin/java"
  "engine/stirling.jar"
  "mcp/app/index.mjs"
  "mcp/node/bin/node"
  "ocr/ocrmypdf"
  "ocr/python/bin/python3"
  "ocr/tesseract/bin/tesseract"
  "ocr/tesseract/share/tessdata/eng.traineddata"
  "ocr/gs/bin/gs"
  "ocr/qpdf/bin/qpdf"
  "legal/THIRD-PARTY-NOTICES.txt"
  "legal/COMPONENT-MANIFEST.json"
  "legal/RELEASE-SOURCE-CORRESPONDENCE.md"
  "legal/RAIOPDF-LICENSE-NOTICES.txt"
  "legal/licenses/GPL-3.0.txt"
)

MODE=assemble
case "${1:-}" in
  --verify)
    MODE=verify
    shift
    ;;
  "")
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

verify_args=(
  --verify
  --platform macos-arm64
  --payload-dir "$PAYLOAD_DIR"
)
for required in "${REQUIRED_PAYLOAD_FILES[@]}"; do
  verify_args+=(--require "$required")
done

if [[ "$MODE" == "verify" ]]; then
  node "$SCRIPT_DIR/payload-manifest.mjs" "${verify_args[@]}"
  exec node "$REPO_ROOT/scripts/validate-package-boundary.mjs" \
    --platform macos-arm64 \
    --root "$PAYLOAD_DIR"
fi

cat >&2 <<'EOF'
macOS arm64 payload assembly is not enabled yet. The isolated entrypoint and
verification contract are in place, but the relocatable Python/OCR component
pins must be finalized and exercised on Apple Silicon before this command may
produce a release payload. Do not substitute Windows payload components.
EOF
exit 1
