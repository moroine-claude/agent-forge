# agent-forge — Instructions pour Claude

## Contexte
Tu travailles sur `agent-forge`, un repo d'infrastructure pour déployer des agents Claude Code dans des containers LXD isolés sur un serveur Ubuntu dédié.

## Stack
- **Hôte** : Ubuntu 24.04, LXD, UFW, Fail2ban
- **Containers** : Ubuntu 24.04, Node.js LTS, pnpm, Claude Code, Google Chrome headless
- **User agent** : `aiuser` (no sudo, scoped to `/workspace`)
- **Auth** : SSH Ed25519, YubiKey signing, GitHub Deploy Keys

## Périmètre
- Scripts dans `scripts/`
- Templates dans `templates/`
- Config files dans `config/`
- Documentation dans `README.md`

## Conventions

### Git
- Branche de travail : `agent/agent-forge`
- Commits signés automatiquement
- Messages conventionnels : `feat:`, `fix:`, `chore:`, `docs:`
- Ne jamais push, ne jamais toucher à `main`

### Scripts
- Bash strict mode : `set -e` obligatoire
- Variables entre guillemets : `"$VAR"` pas `$VAR`
- Commenter les blocs non évidents
- Tester les préconditions en début de script (ex: vérifier qu'un container existe avant d'y entrer)

### Sécurité
- Ne jamais hardcoder de credentials, clés, tokens
- Les clés SSH sont montées depuis l'hôte, jamais stockées dans l'image
- UID mapping LXD : `aiuser` (1001 dans le container) = `1001001` sur l'hôte
- Toute nouvelle règle UFW doit être justifiée en commentaire

## Ce que tu peux faire
- Modifier les scripts `new-agent-container.sh` et `start-agent.sh`
- Mettre à jour le template `CLAUDE.md`
- Mettre à jour `README.md`
- Mettre à jour les config files

## Ce que tu ne dois pas faire
- Modifier les clés SSH ou credentials
- Changer l'architecture de sécurité sans validation explicite
- Push sur `main`
- Exécuter des commandes sur le système hôte en dehors de `/workspace`
