# forge start [<owner/repo>] [<task>]
# Provisions a container if none exists yet for the repo, then puts the task's
# worktree in place and attaches its own Claude Code session inside it.
# See design spec §2.
#
# Les deux positionnels sont demandés quand ils manquent (cf. forge_pick), et
# la branche de la tâche est résolue au lieu de partir systématiquement de
# origin/main : c'est ce qui permet de reprendre une tâche existante (branche
# locale laissée par `forge finish`, ou branche déjà poussée depuis un autre
# container — une PR ouverte).

cmd_forge_start() {
  local owner_repo task_name container ref=""
  local usage="Usage: forge start <owner/repo> [<task>]"

  forge_parse_args "$@"
  owner_repo=$(_forge_start_resolve_repo "${FORGE_ARGS[0]:-}" "$usage") || return 1
  validate_owner_repo "$owner_repo" || return 1
  task_name="${FORGE_ARGS[1]:-}"

  container=$(sanitize_container_name "$owner_repo")
  check_container_name_collision "$container" "$owner_repo" || return 1

  if ! lxc info "$container" > /dev/null 2>&1; then
    # Un container neuf n'a ni worktree ni branche à proposer : le menu de
    # tâches n'aurait rien à montrer, on demande simplement un nom.
    if [ -z "$task_name" ]; then
      task_name=$(forge_ask "New task name") || { echo "$usage" >&2; return 1; }
    fi
    validate_task_name "$task_name" || return 1
    _forge_provision_container "$container" "$owner_repo" || return 1
  fi

  echo "Starting container $container..."
  if ! forge_container_running "$container"; then
    lxc start "$container"
  fi

  # Avant le menu, pas après : les branches d'origin qu'il propose doivent
  # être à jour.
  _forge_refresh_main "$container"

  if [ -z "$task_name" ]; then
    _forge_pick_start_task "$container" "$usage" || return 1
    task_name="$FORGE_START_TASK"
    ref="$FORGE_START_REF"
  fi

  validate_task_name "$task_name" || return 1
  if [ -n "$ref" ]; then
    validate_git_ref "$ref" || return 1
  fi

  _forge_add_worktree "$container" "$task_name" "$ref" || return 1
  _forge_attach_task "$container" "$task_name"
}

# Comme forge_resolve_repo, mais avec une entrée de plus : `forge start` est la
# seule commande qui peut travailler sur un repo pas encore provisionné.
_forge_start_resolve_repo() {
  local owner_repo="$1" usage="$2" idx
  local -a repos

  if [ -n "$owner_repo" ]; then
    echo "$owner_repo"
    return 0
  fi

  mapfile -t repos < <(forge_repos)
  if [ "${#repos[@]}" -eq 0 ]; then
    echo "Error: no forge container yet. Name the repo: forge start <owner/repo> <task>." >&2
    return 1
  fi

  idx=$(forge_pick "Repo" "${repos[@]}" "autre repo…") || { echo "$usage" >&2; return 1; }
  if [ "$idx" -gt "${#repos[@]}" ]; then
    forge_ask "owner/repo" || { echo "$usage" >&2; return 1; }
    return
  fi
  echo "${repos[$((idx - 1))]}"
}

# Fetch + fast-forward de main. Un container supervised n'a aucune credential
# pour joindre origin : on reste sur les refs déjà connues localement.
_forge_refresh_main() {
  local container="$1"

  if [ "$(forge_container_mode "$container")" = "supervised" ]; then
    echo "Supervised container: skipping origin fetch (no credential); working from the last-known origin refs." >&2
    return 0
  fi

  echo "Refreshing main..."
  lxc exec "$container" -- su - aiuser -c "git -C /workspace fetch origin && git -C /workspace merge --ff-only origin/main"
}

# Les noms de tâches derrière les branches agent/* d'un container, un par
# ligne, pour un espace de refs donné (refs/heads/agent ou
# refs/remotes/origin/agent).
#
# Le filtre de charset est la même défense en profondeur que
# _forge_worktree_dirs : ces noms repartent dans un `su -c`.
_forge_agent_branches() {
  local container="$1" refspace="$2"
  lxc exec "$container" -- su - aiuser -c \
    "git -C /workspace for-each-ref --format='%(refname:short)' $refspace" 2>/dev/null \
    | sed -E 's#^(origin/)?agent/##' \
    | awk '$0 ~ /^[A-Za-z0-9._-]+$/' || true
}

_forge_branch_exists() {
  lxc exec "$1" -- su - aiuser -c "git -C /workspace show-ref --verify --quiet $2" > /dev/null 2>&1
}

# Menu de tâches de `forge start` : worktrees déjà là, branches agent/* sans
# worktree (locales, ou seulement sur origin — typiquement une PR ouverte
# depuis un autre container), plus "nouvelle tâche" et "autre branche".
#
# Renseigne FORGE_START_TASK et FORGE_START_REF (vide = résolution
# automatique) : deux valeurs à rendre, donc pas de stdout.
_forge_pick_start_task() {
  local container="$1" usage="$2" idx name ref task
  local -a labels=("nouvelle tâche") values=("new")
  local -A seen=()

  while IFS= read -r name; do
    [ -z "$name" ] && continue
    seen[$name]=1
    labels+=("$name (worktree existant — attach)")
    values+=("task:$name")
  done < <(forge_task_names "$container")

  while IFS= read -r name; do
    [ -z "$name" ] || [ -n "${seen[$name]:-}" ] && continue
    seen[$name]=1
    labels+=("$name (branche locale)")
    values+=("task:$name")
  done < <(_forge_agent_branches "$container" refs/heads/agent)

  while IFS= read -r name; do
    [ -z "$name" ] || [ -n "${seen[$name]:-}" ] && continue
    seen[$name]=1
    labels+=("$name (branche sur origin)")
    values+=("task:$name")
  done < <(_forge_agent_branches "$container" refs/remotes/origin/agent)

  labels+=("autre branche…")
  values+=("other")

  idx=$(forge_pick "Task" "${labels[@]}") || { echo "$usage" >&2; return 1; }

  FORGE_START_TASK=""
  FORGE_START_REF=""
  case "${values[$((idx - 1))]}" in
    new)
      FORGE_START_TASK=$(forge_ask "New task name") || { echo "$usage" >&2; return 1; }
      ;;
    other)
      # La branche de départ peut être quelconque, mais on travaille toujours
      # sur agent/<task> : le hook pre-bash.sh n'autorise le push que là.
      ref=$(forge_ask "Ref") || { echo "$usage" >&2; return 1; }
      task=$(forge_ask "New task name") || { echo "$usage" >&2; return 1; }
      FORGE_START_REF="$ref"
      FORGE_START_TASK="$task"
      ;;
    task:*)
      FORGE_START_TASK="${values[$((idx - 1))]#task:}"
      ;;
  esac
}

# Met le worktree de la tâche en place. Ordre de résolution, chaque cas
# annoncé pour qu'on sache sur quoi on atterrit :
#   1. worktree déjà là           -> on s'y rattache (start est idempotent)
#   2. ref explicite              -> nouvelle agent/<task> depuis cette ref
#   3. branche locale agent/<task> -> worktree dessus (cas post-`forge finish`)
#   4. origin/agent/<task>        -> reprise d'une branche poussée ailleurs
#   5. rien                       -> nouvelle agent/<task> depuis origin/main
_forge_add_worktree() {
  local container="$1" task_name="$2" ref="${3:-}"

  if lxc exec "$container" -- su - aiuser -c "test -e /workspace/.trees/$task_name"; then
    echo "Worktree .trees/$task_name is already there — attaching to it."
    return 0
  fi

  if [ -n "$ref" ]; then
    if _forge_branch_exists "$container" "refs/heads/agent/$task_name"; then
      echo "Error: branch agent/$task_name already exists; pick another task name so its history isn't overwritten." >&2
      return 1
    fi
    echo "Creating worktree .trees/$task_name on a new agent/$task_name from $ref..."
    lxc exec "$container" -- su - aiuser -c "git -C /workspace worktree add .trees/$task_name -b agent/$task_name $ref"
  elif _forge_branch_exists "$container" "refs/heads/agent/$task_name"; then
    echo "Resuming the existing local branch agent/$task_name in .trees/$task_name..."
    lxc exec "$container" -- su - aiuser -c "git -C /workspace worktree add .trees/$task_name agent/$task_name"
  elif _forge_branch_exists "$container" "refs/remotes/origin/agent/$task_name"; then
    echo "Resuming agent/$task_name from origin in .trees/$task_name..."
    lxc exec "$container" -- su - aiuser -c "git -C /workspace worktree add .trees/$task_name -b agent/$task_name origin/agent/$task_name"
  else
    echo "Creating worktree .trees/$task_name on a new agent/$task_name from origin/main..."
    lxc exec "$container" -- su - aiuser -c "git -C /workspace worktree add .trees/$task_name -b agent/$task_name origin/main"
  fi
}

# Attach (or create) the task's tmux session, running claude in its worktree.
#
# tmux MUST stay the direct target of `lxc exec`. With an intermediate
# `su - aiuser -c "..."` shell, SIGWINCH never reaches the tmux client when
# the host terminal is resized: the client keeps the size it read at attach
# time and goes on drawing into a stale grid, so text overwrites dead cells
# (diagnosed 2026-08-31 — the pty itself does resize correctly, only the
# tmux client misses the signal; a tmux.conf cannot fix this).
#
# --user/--group/--cwd replace `su - aiuser` + `cd`. HOME already comes from
# the LXD profile (environment.HOME), but TERM does not: no login shell is
# left to set it, so forward the host's explicitly.
#
# `exec bash -lc` around claude is load-bearing, not cosmetic: `lxc exec`
# sources no rc file, and DOCKER_HOST is exported from .bashrc (see
# forge-image.sh). This puts the login shell *below* tmux, where it restores
# the environment without sitting between the pty and the tmux client.
#
# 1001 is aiuser's UID/GID inside the container (see the raw.idmap block in
# config/lxd-agent-profile.yaml), already relied on elsewhere.
_forge_attach_task() {
  local container="$1" task_name="$2"
  echo "Attaching to $container session '$task_name' as aiuser..."
  lxc exec "$container" --user 1001 --group 1001 \
    --cwd "/workspace/.trees/$task_name" \
    --env "TERM=${TERM:-xterm-256color}" \
    -- tmux new-session -A -s "$task_name" \
       "exec bash -lc 'claude --permission-mode auto --remote-control ${container}-${task_name}'"
}

_forge_provision_container() {
  local container="$1" owner_repo="$2"

  if [ ! -f "/home/moroine/.claude/.credentials.json" ]; then
    echo "Error: /home/moroine/.claude/.credentials.json not found. Run 'claude auth login' on the host first." >&2
    return 1
  fi
  if ! lxc image info agent-base > /dev/null 2>&1; then
    echo "Error: image agent-base not found. Run 'forge image build' first." >&2
    return 1
  fi

  echo "Mode for this container?"
  echo "  [a] autonomous — bot pushes commits and opens PRs itself"
  echo "  [s] supervised — no credential; you retrieve and publish the work yourself"
  read -r -p "Choice [a/s]: " MODE_CHOICE
  local mode
  case "$MODE_CHOICE" in
    s|S) mode="supervised" ;;
    *) mode="autonomous" ;;
  esac

  echo "Creating container $container..."
  lxc launch agent-base "$container" --profile agent

  # Supprime le compte ubuntu laissé par cloud-init qui peut avoir NOPASSWD:ALL sudo
  echo "Removing cloud-init ubuntu backdoor..."
  lxc exec "$container" -- deluser --remove-home ubuntu 2>/dev/null || true
  lxc exec "$container" -- rm -f /etc/sudoers.d/90-cloud-init-users

  echo "Mounting workspace..."
  local workspace_dir="/home/moroine/workspaces/$container"
  mkdir -p "$workspace_dir"
  # raw.idmap dans le profil mappe moroine (1000) → aiuser (1001) et gère aussi root :
  # les fichiers créés par root (UID 0 container) sont stockés UID 1000000 sur l'hôte,
  # re-mappés vers UID 0 à la lecture. Pas besoin d'idmap shifting sur ce device.
  lxc config device add "$container" workspace disk \
    source="$workspace_dir" \
    path=/workspace

  echo "Copying signing key..."
  lxc file push /home/moroine/.ssh/github_agents_signing "$container"/home/aiuser/.ssh/id_ed25519_signing --uid 1001 --gid 1001 --mode 600

  echo "Configuring git..."
  lxc exec "$container" -- su - aiuser -c "
    git config --global user.name 'Claude Agent'
    git config --global user.email 'moroine-claude@users.noreply.github.com'
    git config --global gpg.format ssh
    git config --global user.signingkey /home/aiuser/.ssh/id_ed25519_signing
    git config --global commit.gpgsign true
  "

  echo "Reusing Claude Code credentials from host..."
  lxc exec "$container" -- su - aiuser -c "mkdir -p /home/aiuser/.claude"
  lxc file push /home/moroine/.claude/.credentials.json "$container"/home/aiuser/.claude/.credentials.json --uid 1001 --gid 1001 --mode 600

  echo "Pre-accepting Claude Code onboarding..."
  lxc file push /home/moroine/agent-forge/config/claude-onboarding-state.json "$container"/home/aiuser/.claude.json --uid 1001 --gid 1001 --mode 600

  echo "Updating Claude Code to latest..."
  lxc exec "$container" -- npm install -g @anthropic-ai/claude-code@latest

  echo "Installing Claude plugins..."
  lxc exec "$container" -- su - aiuser -c "claude plugin marketplace add anthropics/claude-plugins-official && claude plugin install superpowers@claude-plugins-official"

  echo "Installing Claude global instructions..."
  lxc file push /home/moroine/agent-forge/templates/CLAUDE.md \
    "$container"/home/aiuser/.claude/CLAUDE.md \
    --uid 1001 --gid 1001 --mode 644

  echo "Installing Claude security hooks..."
  lxc exec "$container" -- mkdir -p /home/aiuser/.claude/hooks
  lxc file push /home/moroine/agent-forge/.claude/hooks/pre-bash.sh \
    "$container"/home/aiuser/.claude/hooks/pre-bash.sh \
    --uid 0 --gid 0 --mode 755
  lxc file push /home/moroine/agent-forge/config/claude-container-settings.json \
    "$container"/home/aiuser/.claude/settings.json \
    --uid 0 --gid 0 --mode 644

  echo "Recording forge mode marker..."
  lxc exec "$container" -- su - aiuser -c "echo '$mode' > /home/aiuser/.claude/forge-mode"

  if [ "$mode" = "supervised" ]; then
    echo "Cloning $owner_repo on the host (branch main)..."
    git clone "git@github.com:$owner_repo.git" "$workspace_dir"
  else
    echo ""
    echo "=============================================================="
    echo "  GitHub token required (BOT account, fine-grained PAT)"
    echo "  Scoped to: $owner_repo only"
    echo "  Permissions: Contents RW, Pull requests RW, Metadata R"
    echo "  The token is piped into the container and never written"
    echo "  to host disk."
    echo "=============================================================="
    read -r -s -p "Paste the token (input hidden): " GH_TOKEN
    echo ""
    if [ -z "$GH_TOKEN" ]; then
      echo "Error: empty token." >&2
      return 1
    fi

    echo "Authenticating gh inside the container..."
    printf '%s' "$GH_TOKEN" | lxc exec "$container" -- su - aiuser -c "gh auth login --hostname github.com --with-token"
    unset GH_TOKEN
    # Fail fast if the token is invalid (set -e aborts on non-zero)
    lxc exec "$container" -- su - aiuser -c "gh auth status --hostname github.com"
    lxc exec "$container" -- su - aiuser -c "gh auth setup-git"

    echo "Cloning $owner_repo (branch main)..."
    lxc exec "$container" -- su - aiuser -c "git clone https://github.com/$owner_repo.git /workspace"
  fi

  echo "Configuring git-lfs and ignoring worktrees..."
  lxc exec "$container" -- su - aiuser -c "cd /workspace && git lfs install && { grep -qxF '.trees/' .git/info/exclude || echo '.trees/' >> .git/info/exclude; }" || {
    echo "Error: git-lfs setup failed in $container." >&2
    return 1
  }

  echo "Stamping the image build this container came from..."
  lxc config set "$container" user.forge.image_commit "$(current_image_commit)"

  echo "Recording forge metadata..."
  lxc config set "$container" user.forge.repo "$owner_repo"
  lxc config set "$container" user.forge.mode "$mode"

  if [ "$mode" = "supervised" ]; then
    echo ""
    echo "Retrieve this container's work from your laptop with:"
    echo "  git remote add $container ssh://moroine@<host>:2222$workspace_dir"
  fi

  echo "Container $container provisioned."
}
