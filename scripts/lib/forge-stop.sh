# forge stop [<owner/repo>] [--force]
# WIP pre-flight (dirty tree / unpushed commits) unless --force.
# Le repo est demandé quand il manque (cf. forge_pick).

cmd_forge_stop() {
  local owner_repo container
  local usage="Usage: forge stop <owner/repo> [--force]"

  forge_parse_args "$@"
  owner_repo=$(forge_resolve_repo "${FORGE_ARGS[0]:-}" "$usage") || return 1
  validate_owner_repo "$owner_repo" || return 1
  container=$(require_container_for_repo "$owner_repo") || return 1

  if [ "$FORGE_FORCE" != "--force" ]; then
    forge_check_wip "$container" || return 1
  fi

  echo "Stopping container $container..."
  lxc stop "$container"
}
