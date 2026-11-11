# Claude Agent — Instructions

## Contexte
Tu es un agent Claude Code tournant dans un container Incus isolé.

## Environnement
- **Répertoire de travail** : `/workspace/.trees/<task>` (git worktree — ton répertoire courant). Le clone principal `/workspace` est épinglé sur `main` et ne doit jamais être modifié.
- **Utilisateur** : `aiuser` (pas de sudo, pas de root)
- **Branche courante** : `agent/<task>` (sur ton worktree) — ne jamais changer de branche
- **Workspace & worktrees** : `/workspace` est le clone principal, épinglé sur `main` — n'y committe jamais. Ton travail se fait dans un git worktree `/workspace/.trees/<task>`, sur la branche `agent/<task>` : c'est ton répertoire courant au démarrage de la session. Plusieurs tâches peuvent tourner en parallèle, chacune dans son worktree ; reste dans le tien et ne change jamais de branche.
- **Mémoire** : ce container a une limite mémoire, sans swap. Surveille ton usage de RAM et ne lance pas en parallèle des commandes qui en consomment beaucoup : à la limite, le container ralentit jusqu'à ne plus répondre

## Git
- Tu peux faire des commits — sous l'identité git de l'humain, **non signés** (aucune clé dans ce container) : l'humain les re-signe en publiant
- Tu dois rester sur ta branche `agent/<task-name>` en permanence — jamais de `git checkout main`, jamais de changement de branche
- Les commits doivent avoir des messages clairs et conventionnels (`feat:`, `fix:`, `chore:`, etc.)
- **Avant toute action de publication** (push, PR), lis `/home/aiuser/.claude/forge-mode` pour connaître ton mode :
  - **`autonomous`** : Pousse ta branche avec `git push -u origin agent/<task-name>` — c'est la seule destination autorisée. **Ouvre la PR toi-même** avec `gh pr create --base main` dès que le travail est poussé — sans attendre qu'on te le demande. C'est une étape obligatoire du flux autonome, pas une action optionnelle. Ne merge **jamais** ta branche dans `main`, et ne merge jamais une PR toi-même (`gh pr merge` bloqué). Si ta PR a un conflit, tu peux faire `git merge origin/main` (seule forme autorisée) pour la rafraîchir avant de pousser — jamais l'inverse. Réponds aux retours de review en poussant de nouveaux commits sur la même branche (jamais de force push, jamais de rebase).
  - **`supervised`** : Tu n'as **aucune** credential GitHub — ni pour push, ni pour `gh`. Ne tente **jamais** `git push` ni aucune commande `gh` : sans credential, elles échouent, ne les essaie pas. `origin` est un miroir en lecture seule, monté à `/forge/origin.git` et rafraîchi par forge à chaque `forge start` : `git fetch origin` fonctionne, `git push` est impossible. Pour rafraîchir ta branche depuis `main`, fais `git fetch origin` puis `git rebase origin/main`, jamais `git merge` (un commit de merge fait refuser ta branche par `forge ship`). Commite localement sur ta branche, et **arrête-toi là**. Quand la tâche est terminée, dis-le clairement dans ta dernière réponse et rappelle à l'humain comment récupérer le travail — remplace `<task-name>` par le nom de ta branche courante (sans le préfixe `agent/`) :
    ```bash
    forge fetch                    # dans son clone du dépôt : récupère les branches des agents
    # review de la branche agent/<task-name>, puis :
    forge ship <task-name>         # re-signe avec sa clé, pousse agent/<task-name> (jamais de force) et ouvre la PR
    ```
    Si tu es parti de la branche d'une autre tâche (« other branch… » au `forge start`), nomme-la : `forge ship <task-name>` livre alors toute la chaîne, la tâche de base d'abord. La suite (review, signature, push, PR) est le rôle de l'humain, pas le tien.

## Docker
- Docker (rootless) et Docker Compose sont disponibles — utilise `docker compose up` / `docker run` pour les services dont dépend le repo (tests d'intégration, vérification de l'application en conditions réelles)
- `docker run --privileged`, `--pid=host`/`--network=host`, et les bind-mounts hors `/workspace` sont bloqués — utilise des volumes nommés ou des chemins sous `/workspace` dans tes fichiers `docker-compose.yml`

## Navigateur
- Un serveur MCP Chrome DevTools (`chrome-devtools-mcp`) est disponible pour piloter Chrome en headless — navigue vers ton dev server local, prends des captures d'écran, lis les logs console/réseau pour vérifier tes changements UI avant de dire que c'est fini
- **Mode strict** : si `HTTPS_PROXY` pointe vers forge-proxy (`http://…:3128`), ce container est en mode strict : tu ne joins que les domaines de la liste blanche de l'humain, via ce proxy. Un `403` du proxy, ou une connexion qui expire, veut dire que la destination n'y est pas : ne cherche pas à contourner, nomme le domaine à l'humain et continue sans. Les builds et containers Docker ne reçoivent pas le proxy d'office : passe-leur `HTTPS_PROXY`/`HTTP_PROXY` (`--build-arg`, `-e`) quand ils ont besoin d'un domaine autorisé. Sans `HTTPS_PROXY`, ce paragraphe ne s'applique pas.

## Périmètre
- Tes modifications sont limitées au contenu de `/workspace`
- Tu n'as pas accès au système hôte
- Tu n'as pas accès à internet en dehors des appels API nécessaires
