# Shared helpers for the forge CLI: name sanitization, owner/repo
# validation, and container discovery via LXD config keys — no separate
# registry file (docs/superpowers/specs/2026-07-14-agent-forge-cli-design.md §1).

# Derives the deterministic container name for a given owner/repo.
# Lowercases, then collapses any run of non-[a-z0-9-] chars to a single "-".
sanitize_container_name() {
  local owner_repo="$1"
  local sanitized
  sanitized=$(echo "$owner_repo" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9-]+/-/g')
  echo "agent-${sanitized}"
}

# Validates <owner>/<repo> format. Prints an error and returns 1 on mismatch.
validate_owner_repo() {
  local owner_repo="$1"
  if [[ ! "$owner_repo" =~ ^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$ ]]; then
    echo "Error: repo must be <owner>/<repo>, got: $owner_repo" >&2
    return 1
  fi
}

# Validates a task-name argument: it's interpolated into a git checkout -b
# string run inside the container via su -c, so must be restricted to
# characters with no shell-metacharacter risk.
validate_task_name() {
  local task_name="$1"
  if [[ ! "$task_name" =~ ^[A-Za-z0-9._-]+$ ]]; then
    echo "Error: task-name must only contain [A-Za-z0-9._-], got: $task_name" >&2
    return 1
  fi
}

# Lists all agent-* container names, one per line.
list_forge_containers() {
  lxc list -f json | jq -r '.[] | select(.name | startswith("agent-")) | .name'
}

# Echoes the owner/repo stored on a container, empty if unset.
forge_container_repo() {
  lxc config get "$1" user.forge.repo
}

# Echoes the mode stored on a container, empty if unset.
forge_container_mode() {
  lxc config get "$1" user.forge.mode
}

# Echoes the container name already provisioned for a given owner/repo;
# empty output and non-zero exit if none exists yet.
container_for_repo() {
  local owner_repo="$1" name existing owner_repo_lc existing_lc
  owner_repo_lc=$(echo "$owner_repo" | tr '[:upper:]' '[:lower:]')
  for name in $(list_forge_containers); do
    existing=$(forge_container_repo "$name")
    existing_lc=$(echo "$existing" | tr '[:upper:]' '[:lower:]')
    if [ "$existing_lc" = "$owner_repo_lc" ]; then
      echo "$name"
      return 0
    fi
  done
  return 1
}

# Fails loudly if a container already exists under the derived name but for
# a *different* repo (naming collision), instead of silently reusing it.
check_container_name_collision() {
  local container="$1" owner_repo="$2" existing existing_lc owner_repo_lc
  if lxc info "$container" > /dev/null 2>&1; then
    existing=$(forge_container_repo "$container")
    existing_lc=$(echo "$existing" | tr '[:upper:]' '[:lower:]')
    owner_repo_lc=$(echo "$owner_repo" | tr '[:upper:]' '[:lower:]')
    if [ -n "$existing" ] && [ "$existing_lc" != "$owner_repo_lc" ]; then
      echo "Error: container $container already exists for a different repo ($existing), refusing to reuse it for $owner_repo." >&2
      return 1
    fi
  fi
}

# Errors out (stderr) if no container exists yet for the given repo.
require_container_for_repo() {
  local owner_repo="$1" container
  if ! container=$(container_for_repo "$owner_repo"); then
    echo "Error: no container found for $owner_repo. Run 'forge start $owner_repo' first." >&2
    return 1
  fi
  echo "$container"
}
