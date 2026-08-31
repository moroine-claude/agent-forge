# forge finish [<owner/repo>] [<task>] [--force]
# Removes a task's worktree once its work is safely committed/pushed. Runs the
# WIP pre-flight on that worktree unless --force. The branch ref stays in .git,
# so a merged/abandoned branch can still be inspected or re-checked-out later.
#
# Les deux positionnels sont demandés quand ils manquent (cf. forge_pick).

cmd_forge_finish() {
  local owner_repo task_name container dir
  local usage="Usage: forge finish <owner/repo> <task> [--force]"

  forge_parse_args "$@"
  owner_repo=$(forge_resolve_repo "${FORGE_ARGS[0]:-}" "$usage") || return 1
  validate_owner_repo "$owner_repo" || return 1
  container=$(require_container_for_repo "$owner_repo") || return 1

  task_name=$(forge_resolve_task "$container" "${FORGE_ARGS[1]:-}" "$usage") || return 1
  validate_task_name "$task_name" || return 1

  dir=$(worktree_abspath "$task_name")
  if ! lxc exec "$container" -- su - aiuser -c "test -e $dir"; then
    echo "Error: no worktree .trees/$task_name in $container." >&2
    return 1
  fi

  if [ "$FORGE_FORCE" != "--force" ]; then
    _forge_check_one_worktree "$container" "$dir" || return 1
  fi

  echo "Removing worktree .trees/$task_name..."
  if [ "$FORGE_FORCE" = "--force" ]; then
    lxc exec "$container" -- su - aiuser -c "git -C /workspace worktree remove --force .trees/$task_name"
  else
    lxc exec "$container" -- su - aiuser -c "git -C /workspace worktree remove .trees/$task_name"
  fi

  # Best-effort: tear down the task's session if it's still around.
  lxc exec "$container" -- su - aiuser -c "tmux kill-session -t $task_name 2>/dev/null || true"

  echo "Finished task $task_name (branch agent/$task_name retained)."
}
