#!/bin/bash
set -e

# Provisions an autonomous-mode agent container: it authenticates to GitHub
# with a fine-grained PAT from the bot account (pasted at creation time,
# never written to host disk), pushes over HTTPS and opens PRs with gh.

if [ -z "$1" ] || [ -z "$2" ]; then
  echo "Usage: $0 <project-name> <owner/repo>"
  exit 1
fi

PROJECT="$1"
REPO="$2"
CONTAINER="agent-$PROJECT"

# Preconditions
if ! echo "$PROJECT" | grep -qE '^[A-Za-z0-9._-]+$'; then
  echo "Error: project name must only contain [A-Za-z0-9._-], got: $PROJECT"
  exit 1
fi
if ! echo "$REPO" | grep -qE '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'; then
  echo "Error: repo must be <owner>/<repo>, got: $REPO"
  exit 1
fi
if ! lxc image info agent-base > /dev/null 2>&1; then
  echo "Error: image agent-base not found. Build the base image first (see README)."
  exit 1
fi
if lxc info "$CONTAINER" > /dev/null 2>&1; then
  echo "Error: container $CONTAINER already exists."
  exit 1
fi

echo "Creating container $CONTAINER..."
lxc launch agent-base "$CONTAINER" --profile agent

# Supprime le compte ubuntu laissé par cloud-init qui peut avoir NOPASSWD:ALL sudo
echo "Removing cloud-init ubuntu backdoor..."
lxc exec "$CONTAINER" -- deluser --remove-home ubuntu 2>/dev/null || true
lxc exec "$CONTAINER" -- rm -f /etc/sudoers.d/90-cloud-init-users

echo "Mounting workspace..."
mkdir -p "/home/moroine/workspaces/$PROJECT"
chmod 750 "/home/moroine/workspaces/$PROJECT"
# shift=true : idmap shifting LXD — le dossier reste possédé par l'utilisateur
# hôte courant, pas besoin de chown vers l'UID mappé du container.
# Scopé à ce seul point de montage, n'ouvre aucun accès host plus large.
lxc config device add "$CONTAINER" workspace disk \
  source="/home/moroine/workspaces/$PROJECT" \
  path=/workspace \
  shift=true

echo "Copying signing key..."
lxc file push /home/moroine/.ssh/github_agents_signing "$CONTAINER"/home/aiuser/.ssh/id_ed25519_signing --uid 1001 --gid 1001 --mode 600

echo "Configuring git..."
lxc exec "$CONTAINER" -- su - aiuser -c "
git config --global user.name 'Claude Agent'
git config --global user.email 'moroine-claude@users.noreply.github.com'
git config --global gpg.format ssh
git config --global user.signingkey /home/aiuser/.ssh/id_ed25519_signing
git config --global commit.gpgsign true
"

echo "Reusing Claude Code credentials from host..."
if [ ! -f "/home/moroine/.claude/.credentials.json" ]; then
  echo "Error: /home/moroine/.claude/.credentials.json not found. Run 'claude auth login' on the host first."
  exit 1
fi
lxc exec "$CONTAINER" -- mkdir -p /home/aiuser/.claude
lxc file push /home/moroine/.claude/.credentials.json "$CONTAINER"/home/aiuser/.claude/.credentials.json --uid 1001 --gid 1001 --mode 600

echo "Pre-accepting Claude Code onboarding..."
lxc file push /home/moroine/agent-forge/config/claude-onboarding-state.json "$CONTAINER"/home/aiuser/.claude.json --uid 1001 --gid 1001 --mode 600

echo "Updating Claude Code to latest..."
lxc exec "$CONTAINER" -- npm install -g @anthropic-ai/claude-code@latest

echo "Installing Claude plugins..."
lxc exec "$CONTAINER" -- su - aiuser -c "claude plugin marketplace add anthropics/claude-plugins-official && claude plugin install superpowers@claude-plugins-official"

echo "Installing Claude security hooks..."
lxc exec "$CONTAINER" -- mkdir -p /home/aiuser/.claude/hooks
# Hooks possédés par root (uid 0) : aiuser peut les lire/exécuter mais pas les écraser
lxc file push /home/moroine/agent-forge/.claude/hooks/pre-bash.sh \
  "$CONTAINER"/home/aiuser/.claude/hooks/pre-bash.sh \
  --uid 0 --gid 0 --mode 755
lxc file push /home/moroine/agent-forge/config/claude-container-settings.json \
  "$CONTAINER"/home/aiuser/.claude/settings.json \
  --uid 0 --gid 0 --mode 644

echo ""
echo "=============================================================="
echo "  GitHub token required (BOT account, fine-grained PAT)"
echo "  Scoped to: $REPO only"
echo "  Permissions: Contents RW, Pull requests RW, Metadata R"
echo "  The token is piped into the container and never written"
echo "  to host disk."
echo "=============================================================="
read -r -s -p "Paste the token (input hidden): " GH_TOKEN
echo ""
if [ -z "$GH_TOKEN" ]; then
  echo "Error: empty token."
  exit 1
fi

echo "Authenticating gh inside the container..."
printf '%s' "$GH_TOKEN" | lxc exec "$CONTAINER" -- su - aiuser -c "gh auth login --hostname github.com --with-token"
unset GH_TOKEN
# Fail fast if the token is invalid (set -e aborts on non-zero)
lxc exec "$CONTAINER" -- su - aiuser -c "gh auth status --hostname github.com"
lxc exec "$CONTAINER" -- su - aiuser -c "gh auth setup-git"

echo "Cloning $REPO and creating branch agent/$PROJECT..."
lxc exec "$CONTAINER" -- su - aiuser -c "git clone https://github.com/$REPO.git /workspace && cd /workspace && git checkout -b agent/$PROJECT"

echo "Container $CONTAINER ready."
lxc list "$CONTAINER"
