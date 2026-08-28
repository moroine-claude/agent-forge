# forge resume <owner/repo> <task>
# Re-attaches the tmux session for an existing task worktree. No fetch, no
# rebranch — that's what `forge start` does. Errors if the worktree is absent.

cmd_forge_resume() {
  local owner_repo="$1" task_name="$2" container

  if [ -z "$owner_repo" ] || [ -z "$task_name" ]; then
    echo "Usage: forge resume <owner/repo> <task>" >&2
    return 1
  fi
  validate_owner_repo "$owner_repo" || return 1
  validate_task_name "$task_name" || return 1
  container=$(require_container_for_repo "$owner_repo") || return 1

  echo "Starting container $container..."
  if [ "$(lxc list "$container" -f json | jq -r '.[0].status')" != "Running" ]; then
    lxc start "$container"
  fi

  if ! lxc exec "$container" -- su - aiuser -c "test -e /workspace/.trees/$task_name"; then
    echo "Error: no worktree .trees/$task_name in $container. Start it with 'forge start $owner_repo $task_name'." >&2
    return 1
  fi

  _forge_attach_task "$container" "$task_name"
}
