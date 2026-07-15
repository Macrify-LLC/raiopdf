#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)

echo "installer/assemble-payload.sh is a compatibility entrypoint; use run-payload-assembler.mjs --platform <id>." >&2
exec node "$SCRIPT_DIR/run-payload-assembler.mjs" "$@"
