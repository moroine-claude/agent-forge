#!/bin/bash
set -e

if [ -z "$1" ]; then
  echo "Usage: $0 <project-name>"
  exit 1
fi

PROJECT=$1
CONTAINER="agent-$PROJECT"

echo "Creating container $CONTAINER..."
lxc launch agent-base "$CONTAINER" --profile agent

echo "Mounting workspace..."
if [ ! -d "/home/moroine/workspaces/$PROJECT" ]; then
  mkdir -p /home/moroine/workspaces/$PROJECT
  sudo chown 1001001:1001001 /home/moroine/workspaces/$PROJECT
  chmod 750 /home/moroine/workspaces/$PROJECT
fi
lxc config device add "$CONTAINER" workspace disk \
  source=/home/moroine/workspaces/$PROJECT \
  path=/workspace

echo "Copying GitHub SSH keys..."
lxc file push /home/moroine/.ssh/github_agents "$CONTAINER"/home/aiuser/.ssh/id_ed25519 --uid 1001 --gid 1001 --mode 600
lxc file push /home/moroine/.ssh/github_agents_signing "$CONTAINER"/home/aiuser/.ssh/id_ed25519_signing --uid 1001 --gid 1001 --mode 600

echo "Adding GitHub known_hosts..."
lxc exec "$CONTAINER" -- su - aiuser -c "cat >> /home/aiuser/.ssh/known_hosts << KEYS
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl
github.com ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBEmKSENjQEezOmxkZMy7opKgwFoVAbemAniT4QKZaTaQFe3JTCEJnqxlxbZ7mFRoNUFH2VoMiKNHzLq51Rcfoto=
github.com ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABgQCj7ndNxQowgcQnjshcLrqPEiiphnt+VTTvDP6mHZtalk9Sh9VTGjRz+O7vGnGBulJ7KorCAMHsSMHHXblDZyh/Gi36Q3Nqz4iat7uCMFHDR9hI+kOUGMU9R7YLCVMmHjfC/C8B/Z2jyNfHfGcHfnCakGNdNKkAlP27eTSIb1PKdwOOQ0GCTj7gUQbWMMd9fFWzToMWFGvhpHxSKJDmCqrLtEJNv6RqJd4pHxFHVp4Vq7sCiF/o5i9yHrHhA5RwMW4AaKuVjFT5c6BO7OB2yzLMzTQPzHBHMHEDxM83I3JxJA9n1Z+rHNEZ8Bvkz7Dxs4Mik3C6pInRvYDxGiMiQ4CPQM5BDQCo+3MaVLCmJzZNKSwLqB9WJ0MPMZq5aPR1sMzJ6pM8FUCGcqv7p+7gShBnxLsRKcg2i9gfFQTmXCVuRicF3grFVvt0q8=
KEYS"

echo "Configuring git..."
lxc exec "$CONTAINER" -- su - aiuser -c "
git config --global user.name 'Claude Agent'
git config --global user.email 'moroine-claude@users.noreply.github.com'
git config --global gpg.format ssh
git config --global user.signingkey /home/aiuser/.ssh/id_ed25519_signing
git config --global commit.gpgsign true
"

echo "Installing Claude security hooks..."
lxc exec "$CONTAINER" -- su - aiuser -c "mkdir -p /home/aiuser/.claude/hooks"
lxc file push /home/moroine/agent-forge/.claude/hooks/pre-bash.sh \
  "$CONTAINER"/home/aiuser/.claude/hooks/pre-bash.sh \
  --uid 1001 --gid 1001 --mode 755
lxc file push /home/moroine/agent-forge/config/claude-container-settings.json \
  "$CONTAINER"/home/aiuser/.claude/settings.json \
  --uid 1001 --gid 1001 --mode 644

echo "Detecting repo from Deploy Key..."
REPO=$(lxc exec "$CONTAINER" -- su - aiuser -c "ssh -T git@github.com 2>&1" | grep -oP "Hi \K[^!]+")
echo "Repo: $REPO"

echo "Cloning and creating branch..."
lxc exec "$CONTAINER" -- su - aiuser -c "git clone git@github.com:$REPO.git /workspace && cd /workspace && git checkout -b agent/$PROJECT"

echo "Container $CONTAINER ready."
lxc list "$CONTAINER"
