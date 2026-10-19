#!/bin/bash
# Vérifie que README.md documente la v2 par mode (local Lima, distant) et ne
# garde rien de la v1. Les valeurs personnelles ne sont pas vérifiées ici :
# un test permanent devrait les contenir (voir la spec du sous-projet 5).
# Lancer : bash tests/test-readme-docs.sh
set -e

FILE="$(cd "$(dirname "$0")/.." && pwd)/README.md"
PASS=0
FAIL=0

assert_contains() {
  if grep -qF -- "$1" "$FILE"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu présent): $1"
  fi
}

assert_not_contains() {
  if grep -qF -- "$1" "$FILE"; then
    FAIL=$((FAIL + 1))
    echo "FAIL (attendu absent): $1"
  else
    PASS=$((PASS + 1))
  fi
}

# Mode local : VM Lima, inventaire d'exemple, playbook, alias SSH.
assert_contains 'limactl create --name forge-local ansible/lima/forge.yaml'
assert_contains 'limactl start forge-local'
assert_contains 'ansible/inventory.lima.example.yml'
assert_contains 'ansible-galaxy collection install -r ansible/requirements.yml'
assert_contains 'ansible-playbook -i'
assert_contains 'Host forge-local'
assert_contains 'Port 60022'
assert_contains 'User forge'
assert_contains 'HostKeyAlias forge-local'
assert_contains 'ForwardAgent yes'
assert_contains 'IdentityAgent'
assert_contains 'brew install lima'
assert_contains 'pipx install ansible-core'
assert_contains '/dev/kvm'
# Le parcours Ubuntu reste à valider sur une vraie machine.
assert_contains 'not yet validated'

# Sur l'hôte, puis herdr.
assert_contains 'claude auth login'
assert_contains 'forge setup'
assert_contains 'forge image build'
assert_contains 'herdr --remote forge-local --remote-keybindings server'
assert_contains 'prefix+f'
assert_contains 'prefix+shift+f'

# Récupération du travail.
assert_contains 'forge upload-pack'
assert_contains 'uploadpack'

# Commandes du quotidien et mode strict.
assert_contains 'forge resume'
assert_contains 'forge finish'
assert_contains 'forge list'
assert_contains 'forge egress'
assert_contains '--strict'
assert_contains 'egress-allowlist'
assert_contains 'forge completion bash'
assert_contains 'incus --project agent-forge delete --force'

# Mode distant : alias SSH, port 22 par défaut.
assert_contains 'Host forge-vm'
assert_not_contains 'Port 2222'

# Rien de la v1 ni du mode Linux direct.
assert_not_contains 'lxc '
assert_not_contains 'LXD'
assert_not_contains 'scripts/forge'
assert_not_contains 'tmux'
assert_not_contains 'Ctrl+b d'
assert_not_contains 'ufw'
assert_not_contains 'forge image build super'
assert_not_contains 'agent-super'
assert_not_contains 'incus admin init'

echo ""
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
