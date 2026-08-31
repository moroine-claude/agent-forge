# forge resume [<owner/repo>] [<task>]
# Re-attaches the tmux session for an existing task worktree. No fetch, no
# rebranch — that's what `forge start` does. Errors if the worktree is absent.
#
# Les deux arguments sont demandés quand ils manquent (cf. forge_pick) ; hors
# TTY on retombe sur le message d'usage.

cmd_forge_resume() {
  local owner_repo="$1" task_name="$2" container
  local usage="Usage: forge resume <owner/repo> <task>"

  owner_repo=$(forge_resolve_repo "$owner_repo" "$usage") || return 1
  validate_owner_repo "$owner_repo" || return 1
  container=$(require_container_for_repo "$owner_repo") || return 1

  echo "Starting container $container..."
  if ! forge_container_running "$container"; then
    lxc start "$container"
  fi

  task_name=$(forge_resolve_task "$container" "$task_name" "$usage") || return 1
  validate_task_name "$task_name" || return 1

  if ! lxc exec "$container" -- su - aiuser -c "test -e /workspace/.trees/$task_name"; then
    echo "Error: no worktree .trees/$task_name in $container. Start it with 'forge start $owner_repo $task_name'." >&2
    return 1
  fi

  _forge_attach_task "$container" "$task_name"
}
