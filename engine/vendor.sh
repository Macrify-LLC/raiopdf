#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PINNED_TAG=$(<"$SCRIPT_DIR/PINNED_TAG")
PINNED_COMMIT=$(<"$SCRIPT_DIR/PINNED_COMMIT")
PINNED_SETTINGS_GRADLE_SHA256=$(<"$SCRIPT_DIR/PINNED_SETTINGS_GRADLE_SHA256")
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

actual_commit=$(git -C "$UPSTREAM_DIR" rev-parse HEAD)
if [[ "$actual_commit" != "$PINNED_COMMIT" ]]; then
  echo "Refusing to continue; Stirling-PDF $PINNED_TAG resolved to an unexpected commit:" >&2
  echo "  expected: $PINNED_COMMIT" >&2
  echo "  actual:   $actual_commit" >&2
  rm -rf -- "$UPSTREAM_DIR"
  exit 1
fi

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

settings_sha=$(sha256sum "$UPSTREAM_DIR/settings.gradle" | awk '{print $1}')
if [[ "$settings_sha" != "$PINNED_SETTINGS_GRADLE_SHA256" ]]; then
  echo "Refusing to continue; patched settings.gradle has an unexpected SHA-256:" >&2
  echo "  expected: $PINNED_SETTINGS_GRADLE_SHA256" >&2
  echo "  actual:   $settings_sha" >&2
  exit 1
fi

unexpected_status=()
while IFS= read -r status_line; do
  status=${status_line:0:2}
  path=${status_line:3}
  allowed=false
  if [[ "$status" == " D" ]]; then
    for dir in "${CARVE_OUT_DIRS[@]}"; do
      if [[ "$path" == "$dir" || "$path" == "$dir/"* ]]; then
        allowed=true
        break
      fi
    done
  elif [[ "$status" == " M" && "$path" == "settings.gradle" ]]; then
    allowed=true
  fi

  if [[ "$allowed" != true ]]; then
    unexpected_status+=("$status_line")
  fi
done < <(git -C "$UPSTREAM_DIR" status --porcelain=v1)

if ((${#unexpected_status[@]} > 0)); then
  echo "Refusing to continue; vendored tree has unexpected local changes:" >&2
  printf '  %s\n' "${unexpected_status[@]}" >&2
  exit 1
fi

echo "Vendored Stirling-PDF $PINNED_TAG into $UPSTREAM_DIR"
echo "Scrubbed proprietary, SaaS, engine, portal, and excluded editor source directories."
