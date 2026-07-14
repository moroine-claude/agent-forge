# forge stop <owner/repo>

cmd_forge_stop() {
  local owner_repo="$1" container

  if [ -z "$owner_repo" ]; then
    echo "Usage: forge stop <owner/repo>" >&2
    return 1
  fi
  container=$(require_container_for_repo "$owner_repo") || return 1

  echo "Stopping container $container..."
  lxc stop "$container"
}
