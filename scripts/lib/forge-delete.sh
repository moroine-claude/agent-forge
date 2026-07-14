# forge delete <owner/repo> [--force]
# WIP pre-flight (dirty tree / unpushed commits) unless --force. The
# workspace directory itself is host-mounted and survives regardless — this
# check exists to surface *forgotten* WIP before re-provisioning re-clones
# fresh, not to prevent actual data loss.

cmd_forge_delete() {
  local owner_repo="$1" force="${2:-}" container

  if [ -z "$owner_repo" ]; then
    echo "Usage: forge delete <owner/repo> [--force]" >&2
    return 1
  fi
  container=$(require_container_for_repo "$owner_repo") || return 1

  if [ "$force" != "--force" ]; then
    _forge_check_wip_before_delete "$container" || return 1
  fi

  echo "Deleting container $container..."
  lxc delete "$container" --force
}

_forge_check_wip_before_delete() {
  local container="$1" dirty unpushed branch

  dirty=$(lxc exec "$container" -- su - aiuser -c "cd /workspace && git status --porcelain")
  if [ -n "$dirty" ]; then
    echo "Error: $container has uncommitted changes in /workspace:" >&2
    echo "$dirty" >&2
    echo "Commit/discard them, or pass --force." >&2
    return 1
  fi

  branch=$(lxc exec "$container" -- su - aiuser -c "cd /workspace && git rev-parse --abbrev-ref HEAD")
  unpushed=$(lxc exec "$container" -- su - aiuser -c "cd /workspace && git log --oneline origin/$branch..$branch" 2>/dev/null || true)
  if [ -n "$unpushed" ]; then
    echo "Error: $container has unpushed commits on $branch:" >&2
    echo "$unpushed" >&2
    echo "Push them, or pass --force." >&2
    return 1
  fi
}
