#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PINNED_TAG=$(<"$SCRIPT_DIR/PINNED_TAG")
UPSTREAM_DIR="$SCRIPT_DIR/upstream"
DIST_DIR="$SCRIPT_DIR/dist"
PLATFORM=${PLATFORM:-windows-x64}

if [[ ! -x "$UPSTREAM_DIR/gradlew" ]]; then
  echo "Missing upstream Gradle wrapper. Run engine/vendor.sh first." >&2
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
cp -- "$JAR_PATH" "$DIST_JAR"

printf 'Built JAR: %s\n' "$JAR_PATH"
printf 'JAR size: %s\n' "$(du -h "$JAR_PATH" | awk '{print $1}')"
printf 'Copied to: %s\n' "$DIST_JAR"
