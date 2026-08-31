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
# a *different* repo (naming collision), or with no forge metadata at all
# (a legacy pre-cutover container, or one left behind by a provisioning run
# that failed before user.forge.repo was recorded) — instead of silently
# reusing it either way.
check_container_name_collision() {
  local container="$1" owner_repo="$2" existing existing_lc owner_repo_lc
  if lxc info "$container" > /dev/null 2>&1; then
    existing=$(forge_container_repo "$container")
    if [ -z "$existing" ]; then
      echo "Error: container $container already exists but has no user.forge.repo metadata (a legacy or partially-provisioned container). Refusing to reuse it — delete it first, or set the metadata manually: lxc config set $container user.forge.repo $owner_repo" >&2
      return 1
    fi
    existing_lc=$(echo "$existing" | tr '[:upper:]' '[:lower:]')
    owner_repo_lc=$(echo "$owner_repo" | tr '[:upper:]' '[:lower:]')
    if [ "$existing_lc" != "$owner_repo_lc" ]; then
      echo "Error: container $container already exists for a different repo ($existing), refusing to reuse it for $owner_repo." >&2
      return 1
    fi
  fi
}

# Prints each feature worktree dir for a container (one per line), excluding
# the main /workspace clone. Container must be running.
#
# Defense in depth: also drops any entry whose basename doesn't match the
# same charset enforced on branch names ([A-Za-z0-9._-]) before it ever
# reaches a further `su -c` (see _forge_check_one_worktree / forge-list.sh).
# A worktree can only be created via `worktree_relpath`/validate_task_name,
# so this should never trigger in practice — it's a filter, not a hard
# error, so one hostile entry doesn't abort the rest.
_forge_worktree_dirs() {
  local container="$1"
  lxc exec "$container" -- su - aiuser -c "cd /workspace && git worktree list --porcelain" \
    | awk '/^worktree /{print $2}' \
    | grep -vx '/workspace' \
    | awk -F/ '$NF ~ /^[A-Za-z0-9._-]+$/' || true
}

# Menu numéroté partagé par les commandes interactives : affiche la liste et
# l'invite sur stderr, écrit l'index 1-based choisi sur stdout — pour que
# `idx=$(forge_pick ...)` reste propre.
#
# On rend l'index et non la valeur pour que l'appelant puisse afficher un
# libellé annoté ("cli (worktree existant)") tout en récupérant la valeur
# brute dans son propre tableau.
#
# Retourne 1 sans rien demander si la liste est vide ou si stdin n'est pas un
# terminal : un appel scripté ne doit pas se bloquer sur une invite que
# personne ne lira, il retombe sur le message d'usage de l'appelant.
forge_pick() {
  local label="$1"; shift
  local -a items=("$@")
  local n=${#items[@]} i choice

  [ "$n" -eq 0 ] && return 1
  [ -t 0 ] || return 1

  while :; do
    for ((i = 0; i < n; i++)); do
      printf '%2d) %s\n' "$((i + 1))" "${items[$i]}" >&2
    done
    printf '%s> ' "$label" >&2
    read -r choice || return 1
    if [[ "$choice" =~ ^[0-9]+$ ]] && [ "$choice" -ge 1 ] && [ "$choice" -le "$n" ]; then
      echo "$choice"
      return 0
    fi
    echo "Choix invalide." >&2
  done
}

# Repos gérés, un owner/repo par ligne. Ne lit que des clés de config LXD :
# aucun `lxc exec`, pour rester assez rapide à alimenter une complétion ou un
# picker interactif.
forge_repos() {
  local name repo
  for name in $(list_forge_containers); do
    repo=$(forge_container_repo "$name")
    [ -n "$repo" ] && echo "$repo"
  done
  return 0
}

# Noms de tâches (basename des worktrees) d'un container, un par ligne.
# Container must be running.
forge_task_names() {
  local dir
  while IFS= read -r dir; do
    [ -z "$dir" ] && continue
    basename "$dir"
  done < <(_forge_worktree_dirs "$1")
}

# Vrai si le container tourne.
forge_container_running() {
  [ "$(lxc list "$1" -f json | jq -r '.[0].status')" = "Running" ]
}

# Sépare les positionnels des flags. Nécessaire depuis que les positionnels
# peuvent manquer : `forge stop --force` prendrait sinon "--force" pour un nom
# de repo. Renseigne FORGE_ARGS (tableau) et FORGE_FORCE.
forge_parse_args() {
  local a
  FORGE_ARGS=()
  FORGE_FORCE=""
  for a in "$@"; do
    case "$a" in
      --force) FORGE_FORCE="--force" ;;
      *)       FORGE_ARGS+=("$a") ;;
    esac
  done
}

# Résout l'argument <owner/repo> : rendu tel quel s'il est fourni, sinon
# demandé parmi les repos gérés. Le message d'usage sert de repli quand on ne
# peut pas demander (pas de TTY, ou l'utilisateur a interrompu la saisie).
forge_resolve_repo() {
  local owner_repo="$1" usage="$2" idx
  local -a repos

  if [ -n "$owner_repo" ]; then
    echo "$owner_repo"
    return 0
  fi

  mapfile -t repos < <(forge_repos)
  if [ "${#repos[@]}" -eq 0 ]; then
    echo "Error: no forge container yet. Run 'forge start <owner/repo> <task>' first." >&2
    return 1
  fi

  idx=$(forge_pick "Repo" "${repos[@]}") || { echo "$usage" >&2; return 1; }
  echo "${repos[$((idx - 1))]}"
}

# Résout l'argument <task> parmi les worktrees existants d'un container.
# Ne sert qu'aux commandes qui agissent sur une tâche *déjà là* (resume,
# finish) ; `forge start` a son propre menu, qui propose aussi de créer.
forge_resolve_task() {
  local container="$1" task_name="$2" usage="$3" idx
  local -a tasks

  if [ -n "$task_name" ]; then
    echo "$task_name"
    return 0
  fi

  if ! forge_container_running "$container"; then
    echo "Error: container $container is stopped, so its tasks can't be listed. Name the task explicitly, or start it." >&2
    return 1
  fi

  mapfile -t tasks < <(forge_task_names "$container")
  if [ "${#tasks[@]}" -eq 0 ]; then
    echo "Error: no task worktree in $container. Create one with 'forge start'." >&2
    return 1
  fi

  idx=$(forge_pick "Task" "${tasks[@]}") || { echo "$usage" >&2; return 1; }
  echo "${tasks[$((idx - 1))]}"
}

# WIP pre-flight for a single worktree dir. Always checks the dirty tree; in
# autonomous mode also the branch-name safety regex and unpushed commits.
# Supervised containers have no credential to have pushed with, so only the
# dirty check applies there.
_forge_check_one_worktree() {
  local container="$1" dir="$2" dirty branch mode ahead unpushed

  dirty=$(lxc exec "$container" -- su - aiuser -c "cd $dir && git status --porcelain")
  if [ -n "$dirty" ]; then
    echo "Error: $container has uncommitted changes in $dir:" >&2
    echo "$dirty" >&2
    echo "Commit/discard them, or pass --force." >&2
    return 1
  fi

  mode=$(forge_container_mode "$container")
  if [ "$mode" = "supervised" ]; then
    return 0
  fi

  branch=$(lxc exec "$container" -- su - aiuser -c "cd $dir && git rev-parse --abbrev-ref HEAD")
  if [[ ! "$branch" =~ ^agent/[A-Za-z0-9._-]+$ ]]; then
    echo "Error: unexpected branch name '$branch' in $dir ($container); refusing to proceed." >&2
    return 1
  fi

  ahead=$(lxc exec "$container" -- su - aiuser -c "cd $dir && git log --oneline origin/main..$branch")
  if [ -n "$ahead" ]; then
    if ! lxc exec "$container" -- su - aiuser -c "cd $dir && git rev-parse --verify origin/$branch" > /dev/null 2>&1; then
      echo "Error: $container's branch $branch has no origin/$branch — it has never been pushed." >&2
      echo "Push it, or pass --force." >&2
      return 1
    fi
    unpushed=$(lxc exec "$container" -- su - aiuser -c "cd $dir && git log --oneline origin/$branch..$branch")
    if [ -n "$unpushed" ]; then
      echo "Error: $container has unpushed commits on $branch:" >&2
      echo "$unpushed" >&2
      echo "Push them, or pass --force." >&2
      return 1
    fi
  fi
}

# WIP pre-flight across every feature worktree. Container must be running.
# Used by stop and delete. The main clone (/workspace, on main) is never
# committed to, so it is not checked — only .trees/* worktrees are.
forge_check_wip() {
  local container="$1" dir
  while IFS= read -r dir; do
    [ -z "$dir" ] && continue
    _forge_check_one_worktree "$container" "$dir" || return 1
  done < <(_forge_worktree_dirs "$container")
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

# Path of the agent-forge checkout on the host (used to read the commit an
# image was built from). Overridable for tests.
FORGE_REPO_DIR="${FORGE_REPO_DIR:-/home/moroine/agent-forge}"

# Worktree paths for a task. Container-side: the main clone is /workspace and
# every feature is a worktree under .trees/. worktree_relpath is what we pass
# to `git -C /workspace worktree add`; worktree_abspath is the cd target for
# the tmux/claude session.
worktree_relpath() { echo ".trees/$1"; }
worktree_abspath() { echo "/workspace/.trees/$1"; }

# Commit the current agent-base image was built from (empty if the image is
# missing or unstamped).
current_image_commit() {
  lxc image get-property agent-base user.forge.commit 2>/dev/null || true
}

# Commit of the image a container was created from (empty if unset).
container_image_commit() {
  lxc config get "$1" user.forge.image_commit 2>/dev/null || true
}

# Pure comparison of a container's build stamp against the latest image build.
# Prints: unknown | up-to-date | behind.
build_status() {
  local container_commit="$1" latest_commit="$2"
  if [ -z "$container_commit" ] || [ -z "$latest_commit" ]; then
    echo "unknown"
  elif [ "$container_commit" = "$latest_commit" ]; then
    echo "up-to-date"
  else
    echo "behind"
  fi
}
