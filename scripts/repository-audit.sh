#!/usr/bin/env bash
set -euo pipefail

repository_root=$(git rev-parse --show-toplevel)
cd "$repository_root"

git diff --check

tracked=$(git ls-files)
for forbidden in .env .idea dist web/test-results playwright-report; do
  if grep -Eq "^${forbidden}(/|$)" <<<"$tracked"; then
    printf 'forbidden tracked path: %s\n' "$forbidden" >&2
    exit 1
  fi
done

if command -v gitleaks >/dev/null 2>&1; then
  gitleaks git --no-banner --redact --config .gitleaks.toml
else
  printf 'gitleaks not installed; skipped secret-history scan\n' >&2
fi
