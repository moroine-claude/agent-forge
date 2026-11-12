#!/bin/bash
# Le lanceur forge-agent : le token va à claude et à lui seul, le marqueur de la
# tâche n'est pas transmis, le statut de claude est repris, et sans token le
# lanceur refuse sans jamais afficher de valeur.
set -e
cd "$(dirname "$0")/.."
LAUNCHER="$PWD/container/forge-agent"

TMP=$(mktemp -d)
trap 'rm -r "$TMP"' EXIT
mkdir "$TMP/bin"
# Un faux claude : montre ce qu'il a reçu, sort en 7.
cat > "$TMP/bin/claude" <<'FAKE'
#!/bin/bash
echo "$CLAUDE_CODE_OAUTH_TOKEN|$*"
exit 7
FAKE
chmod +x "$TMP/bin/claude"
printf 'tok-123\n' > "$TMP/token"

FAIL=0
rc=0
out=$(PATH="$TMP/bin:$PATH" FORGE_TOKEN_FILE="$TMP/token" bash "$LAUNCHER" --forge-task agent-x-a --permission-mode auto) || rc=$?
if [ "$out" != "tok-123|--permission-mode auto" ] || [ "$rc" -ne 7 ]; then
  echo "FAIL: token, arguments ou statut (sortie='$out', rc=$rc)"
  FAIL=1
fi

rc=0
out=$(PATH="$TMP/bin:$PATH" FORGE_TOKEN_FILE="$TMP/absent" bash "$LAUNCHER" --forge-task agent-x-a 2>&1) || rc=$?
if [ "$rc" -eq 0 ] || ! printf '%s' "$out" | grep -q 'forge install' || printf '%s' "$out" | grep -q 'tok-123'; then
  echo "FAIL: sans token, le lanceur doit refuser en nommant forge install (rc=$rc)"
  FAIL=1
fi

# Un TERM reçu par le lanceur (forge stop vise son marqueur) atteint claude :
# sans cela claude resterait orphelin, la tâche passant pour arrêtée.
mkdir "$TMP/bin2"
cat > "$TMP/bin2/claude" <<'FAKE'
#!/bin/bash
echo $$ > "$FORGE_TEST_PID"
sleep 30 &
wait
FAKE
chmod +x "$TMP/bin2/claude"
PATH="$TMP/bin2:$PATH" FORGE_TOKEN_FILE="$TMP/token" FORGE_TEST_PID="$TMP/pid" bash "$LAUNCHER" --forge-task agent-x-a &
launcher=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do [ -s "$TMP/pid" ] && break; sleep 0.2; done
kill -TERM "$launcher"
wait "$launcher" 2> /dev/null || true
sleep 0.3
if kill -0 "$(cat "$TMP/pid")" 2> /dev/null; then
  echo "FAIL: claude tourne encore après un TERM envoyé au lanceur"
  kill -KILL "$(cat "$TMP/pid")" 2> /dev/null || true
  FAIL=1
fi

if [ "$FAIL" -eq 0 ]; then echo "PASS: forge-agent"; fi
exit "$FAIL"
