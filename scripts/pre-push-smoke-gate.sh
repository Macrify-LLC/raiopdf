#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

echo "[pre-push] Running @raiopdf/ui typecheck, unit tests, and Playwright smoke suite."
echo "[pre-push] Emergency bypass: git push --no-verify"

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[pre-push] pnpm is required. Run 'corepack enable' and 'pnpm install', then push again." >&2
  exit 1
fi

echo "[pre-push] Typechecking @raiopdf/ui..."
pnpm --filter @raiopdf/ui run typecheck

echo "[pre-push] Running @raiopdf/ui unit tests..."
pnpm --filter @raiopdf/ui test

echo "[pre-push] Ensuring Playwright Chromium is installed..."
if ! pnpm --filter @raiopdf/ui exec playwright install chromium; then
  echo "[pre-push] Could not install Playwright Chromium." >&2
  echo "[pre-push] Run 'pnpm --filter @raiopdf/ui exec playwright install chromium' and retry." >&2
  exit 1
fi

echo "[pre-push] Running @raiopdf/ui smoke tests..."
pnpm --filter @raiopdf/ui test:smoke
