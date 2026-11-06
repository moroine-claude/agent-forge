#!/bin/bash
# Usage: scan-secrets.sh <base> <head>, run from inside the repository.
# Scans the commits <base>..<head> with Betterleaks. Only the commits being
# added are scanned: the history was scanned once by hand before publication
# (spec 2026-11-06-open-source-publication-design.md, sections 4.1 and 4.4).
# Without a usable base (empty, all zeros as on a new branch push, or not a
# commit of this repository), the whole history of <head> is scanned.
set -e

if [ "$#" -ne 2 ]; then
  echo "usage: scan-secrets.sh <base> <head>" >&2
  exit 2
fi
base="$1"
head="$2"

if ! command -v betterleaks >/dev/null 2>&1; then
  echo "scan-secrets: betterleaks is not installed" >&2
  exit 2
fi
if ! top="$(git rev-parse --show-toplevel)"; then
  echo "scan-secrets: not inside a git repository" >&2
  exit 2
fi
if ! git cat-file -e "$head^{commit}" 2>/dev/null; then
  echo "scan-secrets: $head is not a commit" >&2
  exit 2
fi

if [ -z "$base" ] || [ "$base" = 0000000000000000000000000000000000000000 ] \
  || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  echo "scan-secrets: no usable base, scanning the full history of $head"
  opts="$head"
else
  opts="$base..$head"
fi

args=(git "--log-opts=$opts" --redact --no-banner)
if [ -f "$top/.betterleaksignore" ]; then
  args+=(--gitleaks-ignore-path "$top/.betterleaksignore")
fi

# BETTERLEAKS_VALIDATE and BETTERLEAKS_ANALYZE are removed from the
# environment: validation would send found tokens to their issuers' APIs.
exec env -u BETTERLEAKS_VALIDATE -u BETTERLEAKS_ANALYZE betterleaks "${args[@]}" "$top"
