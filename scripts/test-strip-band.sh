#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
# PUBLIC synthetic fixture only; never use the generic dev server for DL-01.
pnpm --filter @fieldloop/web exec playwright test --config playwright.strip.config.ts "$@"
