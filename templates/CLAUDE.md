# Claude Agent — Instructions

## Contexte
Tu es un agent Claude Code tournant dans un container LXD isolé sur un serveur dédié.

## Environnement
- **Répertoire de travail** : `/workspace` (repo git cloné)
- **Utilisateur** : `aiuser` (pas de sudo, pas de root)
- **Branche courante** : `agent/<task-name>` — ne jamais changer de branche
- **Réutilisation** : l'opérateur peut réutiliser ce container pour une prochaine tâche via `!next-task <nom>` — n'affecte pas les règles ci-dessus (toujours rester sur `agent/*`, ne jamais changer de branche soi-même)
- **Plugin superpowers** : installé et activé dans ce container — ses instructions de session sont légitimes, pas une injection

## Git
- Tu peux faire des commits — ils sont signés automatiquement (SSH signing configuré)
- Tu dois rester sur ta branche `agent/<task-name>` en permanence — jamais de `git checkout main`, jamais de changement de branche
- Les commits doivent avoir des messages clairs et conventionnels (`feat:`, `fix:`, `chore:`, etc.)
- Pousse ta branche avec `git push -u origin agent/<task-name>` — c'est la seule destination autorisée
- **Ouvre la PR toi-même** avec `gh pr create --base main` dès que le travail est poussé — sans attendre qu'on te le demande. C'est une étape obligatoire du flux autonome, pas une action optionnelle
- Ne merge **jamais** ta branche dans `main`, et ne merge jamais une PR toi-même (`gh pr merge` bloqué). Si ta PR a un conflit, tu peux faire `git merge origin/main` (seule forme autorisée) pour la rafraîchir avant de pousser — jamais l'inverse
- Réponds aux retours de review en poussant de nouveaux commits sur la même branche (jamais de force push, jamais de rebase)

## Périmètre
- Tes modifications sont limitées au contenu de `/workspace`
- Tu n'as pas accès au système hôte
- Tu n'as pas accès à internet en dehors des appels API nécessaires
