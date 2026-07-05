#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PINNED_TAG=$(<"$SCRIPT_DIR/PINNED_TAG")
PINNED_COMMIT=$(<"$SCRIPT_DIR/PINNED_COMMIT")
PINNED_SETTINGS_GRADLE_SHA256=$(<"$SCRIPT_DIR/PINNED_SETTINGS_GRADLE_SHA256")
UPSTREAM_DIR="$SCRIPT_DIR/upstream"
DIST_DIR="$SCRIPT_DIR/dist"
PINNED_PATCHED_FILES="$SCRIPT_DIR/PINNED_PATCHED_FILES_SHA256"
PLATFORM=${PLATFORM:-windows-x64}
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

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
    return
  fi
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
    return
  fi

  echo "Missing SHA-256 tool: install sha256sum or shasum." >&2
  return 1
}

if [[ ! -x "$UPSTREAM_DIR/gradlew" ]]; then
  echo "Missing upstream Gradle wrapper. Run engine/vendor.sh first." >&2
  exit 1
fi

actual_commit=$(git -C "$UPSTREAM_DIR" rev-parse HEAD 2>/dev/null || true)
if [[ "$actual_commit" != "$PINNED_COMMIT" ]]; then
  echo "Refusing to build Stirling-PDF from an unexpected source commit:" >&2
  echo "  expected: $PINNED_COMMIT" >&2
  echo "  actual:   ${actual_commit:-unknown}" >&2
  echo "Run engine/vendor.sh to refresh the verified upstream checkout." >&2
  exit 1
fi

settings_sha=$(sha256_file "$UPSTREAM_DIR/settings.gradle")
if [[ "$settings_sha" != "$PINNED_SETTINGS_GRADLE_SHA256" ]]; then
  echo "Refusing to build; patched settings.gradle has an unexpected SHA-256:" >&2
  echo "  expected: $PINNED_SETTINGS_GRADLE_SHA256" >&2
  echo "  actual:   $settings_sha" >&2
  echo "Run engine/vendor.sh to refresh the verified upstream checkout." >&2
  exit 1
fi

# Files modified by functional patches (engine/patches/) must match their
# pinned post-patch hashes, mirroring the settings.gradle check. See ADR 0003.
PATCHED_FILE_PATHS=()
if [[ -s "$PINNED_PATCHED_FILES" ]]; then
  while read -r pinned_sha pinned_path; do
    [[ -z "$pinned_sha" || "$pinned_sha" == \#* ]] && continue
    PATCHED_FILE_PATHS+=("$pinned_path")
    actual_sha=$(sha256_file "$UPSTREAM_DIR/$pinned_path")
    if [[ "$actual_sha" != "$pinned_sha" ]]; then
      echo "Refusing to build; patched $pinned_path has an unexpected SHA-256:" >&2
      echo "  expected: $pinned_sha" >&2
      echo "  actual:   $actual_sha" >&2
      echo "Run engine/vendor.sh to refresh the verified upstream checkout." >&2
      exit 1
    fi
  done <"$PINNED_PATCHED_FILES"
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
  elif [[ "$status" == " M" ]]; then
    if [[ "$path" == "settings.gradle" ]]; then
      allowed=true
    else
      for patched_path in "${PATCHED_FILE_PATHS[@]}"; do
        if [[ "$path" == "$patched_path" ]]; then
          allowed=true
          break
        fi
      done
    fi
  fi

  if [[ "$allowed" != true ]]; then
    unexpected_status+=("$status_line")
  fi
done < <(git -C "$UPSTREAM_DIR" status --porcelain=v1)

if ((${#unexpected_status[@]} > 0)); then
  echo "Refusing to build; vendored tree has unexpected local changes:" >&2
  printf '  %s\n' "${unexpected_status[@]}" >&2
  echo "Run engine/vendor.sh to refresh the verified upstream checkout." >&2
  exit 1
fi

mkdir -p -- "$DIST_DIR"

(
  cd "$UPSTREAM_DIR"
  env -u DISABLE_ADDITIONAL_FEATURES -u DOCKER_ENABLE_SECURITY \
    STIRLING_FLAVOR=core ./gradlew :stirling-pdf:bootJar \
    "-PjpdfiumPlatforms=$PLATFORM" \
    -x test -x spotlessCheck
)

JAR_PATH="$UPSTREAM_DIR/app/core/build/libs/stirling-pdf-${PINNED_TAG#v}.jar"
if [[ ! -f "$JAR_PATH" ]]; then
  echo "Expected bootJar output was not found: $JAR_PATH" >&2
  exit 1
fi

if ! JAR_ENTRIES=$(unzip -Z1 "$JAR_PATH"); then
  echo "Could not list JAR entries for verification: $JAR_PATH" >&2
  exit 1
fi
if grep -Ei 'proprietary|saas' <<<"$JAR_ENTRIES"; then
  echo "Refusing to publish JAR; proprietary or SaaS entries were found." >&2
  exit 1
fi

DIST_JAR="$DIST_DIR/stirling-pdf-${PINNED_TAG#v}-${PLATFORM}.jar"
DIST_SOURCE="$DIST_JAR.source"
cp -- "$JAR_PATH" "$DIST_JAR"
DIST_SHA=$(sha256_file "$DIST_JAR")
cat >"$DIST_SOURCE" <<EOF
tag=$PINNED_TAG
commit=$PINNED_COMMIT
platform=$PLATFORM
sha256=$DIST_SHA
EOF

printf 'Built JAR: %s\n' "$JAR_PATH"
printf 'JAR size: %s\n' "$(du -h "$JAR_PATH" | awk '{print $1}')"
printf 'Copied to: %s\n' "$DIST_JAR"
printf 'Source manifest: %s\n' "$DIST_SOURCE"
