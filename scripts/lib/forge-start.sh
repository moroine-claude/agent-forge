# forge start <owner/repo> [task-name]
# Provisions a container if none exists yet for the repo, then starts/attaches
# a Claude Code session inside it. See design spec §2.

cmd_forge_start() {
  local owner_repo="$1" task_name="${2:-init}"

  if [ -z "$owner_repo" ]; then
    echo "Usage: forge start <owner/repo> [task-name]" >&2
    return 1
  fi
  validate_owner_repo "$owner_repo" || return 1
  validate_task_name "$task_name" || return 1

  local container
  container=$(sanitize_container_name "$owner_repo")
  check_container_name_collision "$container" "$owner_repo" || return 1

  if lxc info "$container" > /dev/null 2>&1; then
    if [ -n "${2:-}" ]; then
      echo "Warning: container $container already exists; task-name '$task_name' ignored." >&2
    fi
  else
    _forge_provision_container "$container" "$owner_repo" "$task_name" || return 1
  fi

  echo "Starting container $container..."
  if [ "$(lxc list "$container" -f json | jq -r '.[0].status')" != "Running" ]; then
    lxc start "$container"
  fi

  echo "Attaching to $container as aiuser..."
  lxc exec "$container" -- su - aiuser -c "
    cd /workspace
    tmux new-session -A -s claude 'claude --permission-mode auto --remote-control ${container}'
  "
}

_forge_provision_container() {
  local container="$1" owner_repo="$2" task_name="$3"

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
  lxc exec "$container" -- su - aiuser -c "cd /workspace && git lfs install && grep -qxF '.trees/' .git/info/exclude || echo '.trees/' >> .git/info/exclude"

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
