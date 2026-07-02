#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PINNED_TAG=$(<"$SCRIPT_DIR/PINNED_TAG")
UPSTREAM_DIR="$SCRIPT_DIR/upstream"
PATCH_FILE="$SCRIPT_DIR/settings-gradle.patch"
REMOTE_URL="https://github.com/Stirling-Tools/Stirling-PDF.git"

CARVE_OUT_DIRS=(
  "app/proprietary"
  "app/saas"
  "engine"
  "frontend/portal"
  "frontend/editor/src/desktop"
  "frontend/editor/src/proprietary"
  "frontend/editor/src/saas"
  "frontend/editor/src/cloud"
  "frontend/editor/src/prototypes"
)

if [[ ! -s "$PATCH_FILE" ]]; then
  echo "Missing settings.gradle patch: $PATCH_FILE" >&2
  exit 1
fi

rm -rf -- "$UPSTREAM_DIR"
git clone --depth 1 --branch "$PINNED_TAG" "$REMOTE_URL" "$UPSTREAM_DIR"

for dir in "${CARVE_OUT_DIRS[@]}"; do
  rm -rf -- "$UPSTREAM_DIR/${dir:?}"
done

survivors=()
for dir in "${CARVE_OUT_DIRS[@]}"; do
  if [[ -e "$UPSTREAM_DIR/$dir" ]]; then
    survivors+=("$dir")
  fi
done

if ((${#survivors[@]} > 0)); then
  echo "Refusing to continue; carved-out upstream directories survived scrub:" >&2
  printf '  %s\n' "${survivors[@]}" >&2
  exit 1
fi

(
  cd "$UPSTREAM_DIR"
  git apply --check "$PATCH_FILE"
  git apply "$PATCH_FILE"
)

echo "Vendored Stirling-PDF $PINNED_TAG into $UPSTREAM_DIR"
echo "Scrubbed proprietary, SaaS, engine, portal, and excluded editor source directories."
