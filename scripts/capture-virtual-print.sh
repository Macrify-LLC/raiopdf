#!/bin/sh
# Only the canary's synthetic virtual IPP queue calls this capture command.
set -eu
last=""
for arg in "$@"; do last="$arg"; done
base="/tmp/rp-cups-out/captured-$$"
if [ -f "$last" ]; then cp "$last" "$base.pdf"; else cat > "$base.pdf"; fi
# ippeveprinter exports job attributes separately from printer defaults.
# Capture only settings under test, never the process's full environment.
printf 'IPP_MEDIA=%s\nIPP_MEDIA_COL=%s\nIPP_MEDIA_SOURCE=%s\nIPP_COPIES=%s\n' \
  "${IPP_MEDIA-}" "${IPP_MEDIA_COL-}" "${IPP_MEDIA_SOURCE-}" "${IPP_COPIES-}" > "$base.ticket"
