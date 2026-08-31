# forge delete [<owner/repo>] [--force]
# WIP pre-flight unless --force or the container is already stopped
# (stop already ran the pre-flight). The workspace directory itself is
# host-mounted and survives regardless — this check exists to surface
# *forgotten* WIP before re-provisioning re-clones fresh, not to prevent
# actual data loss.
#
# Le repo est demandé quand il manque (cf. forge_pick).

cmd_forge_delete() {
  local owner_repo container status
  local usage="Usage: forge delete <owner/repo> [--force]"

  forge_parse_args "$@"
  owner_repo=$(forge_resolve_repo "${FORGE_ARGS[0]:-}" "$usage") || return 1
  validate_owner_repo "$owner_repo" || return 1
  container=$(require_container_for_repo "$owner_repo") || return 1

  status=$(lxc info "$container" | awk '/^Status:/ {print $2}')
  if [ "$FORGE_FORCE" != "--force" ] && [ "$status" = "Running" ]; then
    forge_check_wip "$container" || return 1
  fi

  echo "Deleting container $container..."
  lxc delete "$container" --force
}
