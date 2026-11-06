#!/bin/bash
# Vérifie les documents de publication open source : licence AGPL-3.0-only
# (LICENSE, package.json, package-lock.json, section License du README).
# Lancer : bash tests/test-open-source-docs.sh
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0
FAIL=0

pass() { PASS=$((PASS + 1)); }
fail() { FAIL=$((FAIL + 1)); echo "FAIL: $1"; }

# assert_contains <fichier> <texte> : le fichier (relatif à la racine) contient le texte
assert_contains() {
  if grep -qF -- "$2" "$ROOT/$1"; then pass; else fail "$1 devrait contenir: $2"; fi
}

# assert_not_contains <fichier> <texte>
assert_not_contains() {
  if grep -qF -- "$2" "$ROOT/$1"; then fail "$1 ne devrait pas contenir: $2"; else pass; fi
}

# assert_equals <description> <attendu> <obtenu>
assert_equals() {
  if [ "$2" = "$3" ]; then pass; else fail "$1: attendu '$2', obtenu '$3'"; fi
}

# --- LICENSE ---
if [ -f "$ROOT/LICENSE" ]; then
  first="$(head -n 1 "$ROOT/LICENSE" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
  assert_equals "LICENSE première ligne" "GNU AFFERO GENERAL PUBLIC LICENSE" "$first"
  assert_contains LICENSE 'Version 3, 19 November 2007'
  assert_contains LICENSE 'END OF TERMS AND CONDITIONS'
  size="$(wc -c < "$ROOT/LICENSE" | tr -d '[:space:]')"
  if [ "$size" -gt 30000 ]; then pass; else fail "LICENSE trop petit ($size octets)"; fi
else
  fail "LICENSE absent"
fi

# --- package.json et package-lock.json ---
cd "$ROOT"
assert_equals "package.json license" "AGPL-3.0-only" "$(node -p "require('./package.json').license")"
assert_equals "package.json private" "true" "$(node -p "require('./package.json').private")"
assert_equals "package-lock.json license" "AGPL-3.0-only" \
  "$(node -p "require('./package-lock.json').packages[''].license")"

# --- README : section License, dernière section de niveau 2 ---
assert_contains README.md '## License'
assert_contains README.md 'AGPL-3.0-only'
assert_contains README.md 'the agent-forge contributors'
assert_contains README.md '[LICENSE](LICENSE)'
last_heading="$(grep '^## ' "$ROOT/README.md" | tail -n 1)"
assert_equals "dernier titre ## du README" "## License" "$last_heading"

# --- SECURITY.md ---
for t in 'Report a vulnerability' '7 days' 'main' 'not maintained' \
  'not a security boundary' 'container/pre-bash.sh' 'upstream'; do
  assert_contains SECURITY.md "$t"
done

# --- CONTRIBUTING.md ---
for t in 'fork' 'signed' '--force-rebase --gpg-sign' '--force-with-lease' \
  'npm test' 'npm run check' 'npm run test:ansible' 'FORGE_INTEGRATION=1' \
  'ansible/tests/vm-test.sh' 'npm run hooks:install' 'betterleaks version' \
  '--validation' '.betterleaksignore' '--ignore-gitleaks-allow' \
  '--report-format json --report-path -' 'betterleaks.toml' '.gitleaksignore' \
  'npm run hooks:install -- --force' 'from a checkout of `main`' 'upstream/main' \
  'CLAUDE.md' 'SECURITY.md' \
  'AGPL-3.0-only' 'feat:'; do
  assert_contains CONTRIBUTING.md "$t"
done

# --- README : section Developing agent-forge ---
dev_section="$(sed -n '/^## Developing agent-forge/,/^## License/p' "$ROOT/README.md")"
for t in 'CONTRIBUTING.md' 'npm run hooks:install'; do
  case "$dev_section" in *"$t"*) pass ;; *) fail "README Developing: manque $t" ;; esac
done

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
