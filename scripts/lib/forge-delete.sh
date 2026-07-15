# forge delete <owner/repo> [--force]
# WIP pre-flight unless --force or the container is already stopped
# (stop already ran the pre-flight). The workspace directory itself is
# host-mounted and survives regardless — this check exists to surface
# *forgotten* WIP before re-provisioning re-clones fresh, not to prevent
# actual data loss.

cmd_forge_delete() {
  local owner_repo="$1" force="${2:-}" container status

  if [ -z "$owner_repo" ]; then
    echo "Usage: forge delete <owner/repo> [--force]" >&2
    return 1
  fi
  container=$(require_container_for_repo "$owner_repo") || return 1

  status=$(lxc info "$container" | awk '/^Status:/ {print $2}')
  if [ "$force" != "--force" ] && [ "$status" = "Running" ]; then
    forge_check_wip "$container" || return 1
  fi

  echo "Deleting container $container..."
  lxc delete "$container" --force
}
