# forge completion — la fonction bash à évaluer, plus les deux sous-commandes
# à sortie machine qui l'alimentent.
#
# La fonction parsait auparavant la sortie humaine de `forge list`
# (awk '{print $2}') : toute correction de mise en forme la cassait, et
# chaque TAB déclenchait un `lxc exec` par worktree. `forge completion repos`
# et `forge completion tasks` donnent une sortie stable, une entrée par
# ligne — et servent aussi de source aux pickers interactifs.

# Un owner/repo par ligne.
cmd_forge_completion_repos() {
  forge_repos
}

# Un nom de tâche par ligne pour le repo donné. Container arrêté : rien à
# lister, mais ce n'est pas une erreur (on ne peut juste pas l'inspecter).
cmd_forge_completion_tasks() {
  local owner_repo="$1" container
  if [ -z "$owner_repo" ]; then
    echo "Usage: forge completion tasks <owner/repo>" >&2
    return 1
  fi
  validate_owner_repo "$owner_repo" || return 1
  container=$(require_container_for_repo "$owner_repo") || return 1
  forge_container_running "$container" || return 0
  forge_task_names "$container"
}

cmd_forge_completion_bash() {
  cat <<'EOF'
_forge_completions() {
  local cur cmd
  cur="${COMP_WORDS[COMP_CWORD]}"
  cmd="${COMP_WORDS[1]}"

  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=($(compgen -W "start resume finish stop delete list image completion" -- "$cur"))
    return
  fi

  case "$cmd" in
    start|resume|finish|stop|delete)
      case "$COMP_CWORD" in
        2)
          COMPREPLY=($(compgen -W "$(forge completion repos 2>/dev/null)" -- "$cur"))
          ;;
        3)
          case "$cmd" in
            start|resume|finish)
              COMPREPLY=($(compgen -W "$(forge completion tasks "${COMP_WORDS[2]}" 2>/dev/null)" -- "$cur"))
              ;;
            stop|delete)
              COMPREPLY=($(compgen -W "--force" -- "$cur"))
              ;;
          esac
          ;;
        4)
          if [ "$cmd" = "finish" ]; then
            COMPREPLY=($(compgen -W "--force" -- "$cur"))
          fi
          ;;
      esac
      ;;
    image)
      [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "build update" -- "$cur"))
      ;;
    completion)
      [ "$COMP_CWORD" -eq 2 ] && COMPREPLY=($(compgen -W "bash repos tasks" -- "$cur"))
      ;;
  esac
  return 0
}
complete -F _forge_completions forge
EOF
}
