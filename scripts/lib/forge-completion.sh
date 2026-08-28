# forge completion bash — prints a bash completion function to stdout.
# Usage: eval "$(forge completion bash)"

cmd_forge_completion_bash() {
  cat <<'EOF'
_forge_completions() {
  local cur prev
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "start stop delete list image completion resume finish" -- "$cur"))
    return
  fi

  case "$prev" in
    start|stop|delete|resume|finish)
      local repos
      repos=$(forge list 2>/dev/null | awk '/^agent-/{print $2}' | grep -v '^-$')
      COMPREPLY=($(compgen -W "$repos" -- "$cur"))
      ;;
    image)
      COMPREPLY=($(compgen -W "build update" -- "$cur"))
      ;;
    completion)
      COMPREPLY=($(compgen -W "bash" -- "$cur"))
      ;;
  esac
}
complete -F _forge_completions forge
EOF
}
