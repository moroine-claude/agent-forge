# Harnais de test : un faux `lxc` sur le PATH, pilote par un etat sur disque.
#
# Les tests forge etaient jusqu'ici purement structurels (grep sur les
# sources), ce qui ne pouvait pas attraper un bug de rendu ou de resolution
# de branche. Ce stub permet d'executer reellement `scripts/forge` sans LXD.
#
# Usage :
#   source tests/lib/fake-lxc.sh
#   fake_lxc_init
#   fake_lxc_image_commit aaaa1111
#   fake_lxc_container agent-moroine-agent-forge Running moroine/agent-forge autonomous aaaa1111
#   fake_lxc_exec_rule 'git worktree list' 0 $'worktree /workspace\nworktree /workspace/.trees/cli'
#   PATH="$FAKE_LXC_BIN:$PATH" scripts/forge list
#   fake_lxc_calls        # tout ce qui a ete appele, une invocation par ligne
#   fake_lxc_cleanup

FAKE_LXC_BIN=""
FAKE_LXC_STATE=""
FAKE_LXC_FORGE=""

# fake_lxc_init [chemin-vers-scripts/forge]
fake_lxc_init() {
  FAKE_LXC_FORGE="${1:-}"
  FAKE_LXC_STATE=$(mktemp -d)
  FAKE_LXC_BIN="$FAKE_LXC_STATE/bin"
  mkdir -p "$FAKE_LXC_BIN"
  : > "$FAKE_LXC_STATE/containers"   # name \t status \t repo \t mode \t image_commit
  : > "$FAKE_LXC_STATE/exec_rules"   # pattern \t exit \t base64(stdout)
  : > "$FAKE_LXC_STATE/calls"
  : > "$FAKE_LXC_STATE/image_commit"
  export FAKE_LXC_STATE

  cat > "$FAKE_LXC_BIN/lxc" <<'STUB'
#!/bin/bash
# Faux lxc : ne couvre que les invocations utilisees par le CLI forge.
state="$FAKE_LXC_STATE"
printf '%s\n' "$*" >> "$state/calls"

emit_json() {
  # $@ = noms de containers ; sort un tableau JSON name/status.
  local first=1 name status
  printf '['
  for name in "$@"; do
    status=$(awk -F'\t' -v n="$name" '$1==n{print $2}' "$state/containers")
    [ -z "$status" ] && continue
    [ "$first" -eq 0 ] && printf ','
    first=0
    printf '{"name":"%s","status":"%s"}' "$name" "$status"
  done
  printf ']\n'
}

case "$1" in
  list)
    if [ "$2" = "-f" ]; then
      emit_json $(cut -f1 "$state/containers")
    else
      emit_json "$2"
    fi
    ;;
  config)
    case "$2" in
      get)
        case "$4" in
          user.forge.repo)         awk -F'\t' -v n="$3" '$1==n{print $3}' "$state/containers" ;;
          user.forge.mode)         awk -F'\t' -v n="$3" '$1==n{print $4}' "$state/containers" ;;
          user.forge.image_commit) awk -F'\t' -v n="$3" '$1==n{print $5}' "$state/containers" ;;
        esac
        ;;
      set) ;;
    esac
    ;;
  image)
    case "$2" in
      get-property) cat "$state/image_commit" ;;
      info) [ -s "$state/image_commit" ] ;;
    esac
    ;;
  info)
    awk -F'\t' -v n="$2" '$1==n{found=1; print "Status: " $2} END{exit !found}' "$state/containers"
    ;;
  exec)
    # La commande reelle est tout ce qui suit le premier `--`.
    shift
    while [ $# -gt 0 ] && [ "$1" != "--" ]; do shift; done
    shift
    cmd="$*"
    while IFS=$'\t' read -r pattern code payload; do
      [ -z "$pattern" ] && continue
      if [[ "$cmd" == *"$pattern"* ]]; then
        [ -n "$payload" ] && printf '%s' "$payload" | base64 -d
        exit "$code"
      fi
    done < "$state/exec_rules"
    exit 0
    ;;
  start|stop|delete|launch|file|profile) ;;
  *) exit 0 ;;
esac
STUB
  chmod +x "$FAKE_LXC_BIN/lxc"
}

# fake_lxc_container <name> <status> <repo> <mode> [image_commit]
fake_lxc_container() {
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "${5:-}" >> "$FAKE_LXC_STATE/containers"
}

fake_lxc_image_commit() { printf '%s' "$1" > "$FAKE_LXC_STATE/image_commit"; }

# fake_lxc_exec_rule <substring-de-la-commande> <exit-code> [stdout]
# Premiere regle qui matche gagne, comme un routeur.
fake_lxc_exec_rule() {
  printf '%s\t%s\t%s\n' "$1" "$2" "$(printf '%s' "${3:-}" | base64 -w0)" >> "$FAKE_LXC_STATE/exec_rules"
}

# Execute `scripts/forge` dans un pty, avec le faux lxc sur le PATH. Les
# commandes interactives refusent de prompter hors TTY, d'ou le detour par
# script(1) ; l'entree simulee est passee en 1er argument.
# Renseigne FORGE_TTY_OUT (stdout+stderr, invites comprises) et FORGE_TTY_RC.
fake_lxc_run_tty() {
  local input="$1"; shift
  local out="$FAKE_LXC_STATE/forge_out" rc="$FAKE_LXC_STATE/forge_rc" args
  args=$(printf '%q ' "$@")
  printf '%s' "$input" | script -qec \
    "PATH='$FAKE_LXC_BIN:$PATH' bash '$FAKE_LXC_FORGE' $args > '$out' 2>&1; echo \$? > '$rc'" \
    /dev/null > /dev/null 2>&1 || true
  FORGE_TTY_OUT=$(tr -d '\r' < "$out")
  FORGE_TTY_RC=$(tr -d '\r\n' < "$rc")
}

fake_lxc_calls() { cat "$FAKE_LXC_STATE/calls"; }
fake_lxc_reset_calls() { : > "$FAKE_LXC_STATE/calls"; }
fake_lxc_reset_rules() { : > "$FAKE_LXC_STATE/exec_rules"; }
fake_lxc_cleanup() { [ -n "$FAKE_LXC_STATE" ] && rm -r "$FAKE_LXC_STATE"; }
