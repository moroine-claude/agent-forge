# forge stop <owner/repo> [--force]
# WIP pre-flight (dirty tree / unpushed commits) unless --force.

cmd_forge_stop() {
  local owner_repo="$1" force="${2:-}" container

  if [ -z "$owner_repo" ]; then
    echo "Usage: forge stop <owner/repo> [--force]" >&2
    return 1
  fi
  container=$(require_container_for_repo "$owner_repo") || return 1

  if [ "$force" != "--force" ]; then
    forge_check_wip "$container" || return 1
  fi

  echo "Stopping container $container..."
  lxc stop "$container"
}
