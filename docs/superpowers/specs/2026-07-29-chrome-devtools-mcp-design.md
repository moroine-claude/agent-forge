# Chrome DevTools MCP dans agent-base

## Contexte

`agent-base` installe déjà Google Chrome (headless) dans chaque container, mais
rien ne le pilote : pas d'extension `claude-in-chrome` (elle suppose un Chrome
desktop avec affichage, inapplicable dans un container headless sans écran),
pas de serveur MCP branché dessus. Un agent qui travaille sur du frontend n'a
donc aucun moyen de suivre la consigne déjà en place ("pour un changement UI,
lance le dev server et utilise la fonctionnalité dans un navigateur avant de
dire que c'est fini") — il n'a pas d'outil pour ouvrir un navigateur.

Cette lacune a été identifiée lors d'un audit préventif de l'outillage
disponible pour des tâches de dev web (frontend + backend), avant qu'un plus
grand nombre de repos passe par agent-forge — pas suite à un incident observé
sur un agent en particulier.

## Objectif

Équiper chaque container, sans configuration par repo, d'un moyen pour l'agent
de piloter le Chrome déjà installé : naviguer, prendre des captures d'écran,
lire les logs console et les requêtes réseau, cliquer/saisir du texte.

## Approches considérées

- **Chrome DevTools MCP (Google, officiel)** — serveur MCP conçu précisément
  pour attacher un agent à une instance Chrome existante via CDP (Chrome
  DevTools Protocol). Pilote directement le `google-chrome-stable` déjà
  installé — aucun binaire navigateur supplémentaire. Orienté
  debug/inspection (console, réseau, perf), ce qui correspond bien au besoin
  de vérification visuelle. **Retenu.**
- **Playwright MCP (Microsoft, officiel)** — alternative tout aussi mature,
  ciblage d'éléments par arbre d'accessibilité (souvent plus robuste pour un
  LLM que le DOM brut). Écarté ici parce que Playwright veut par défaut
  télécharger ses propres binaires navigateur ; le forcer à réutiliser le
  Chrome déjà installé demande une configuration supplémentaire
  (`--executable-path`) sans bénéfice net pour ce cas d'usage.
- **Wrapper Puppeteer maison (sans MCP)** — contrôle total, mais réinvente un
  problème déjà résolu par les deux options ci-dessus, sort de l'écosystème
  MCP que Claude Code découvre nativement, et devient un fardeau de
  maintenance propre à agent-forge. Écarté.

## Architecture

```
forge-image.sh (build)
  └── npm install -g chrome-devtools-mcp@<version épinglée>

forge-start.sh (provisioning initial d'un nouveau container uniquement)
  └── lxc file push config/claude-onboarding-state.json → ~/.claude.json
        (ajout d'une clé "mcpServers" globale, comme le reste du fichier)

Session claude (runtime)
  └── MCP server "chrome-devtools" lance Chrome headless (--no-sandbox, profil isolé)
        └── l'agent navigue vers localhost:<port du dev server qu'il vient de lancer>
        └── screenshot / logs console / requêtes réseau remontent comme résultats d'outil MCP
```

Le trafic Chrome → dev-server reste en loopback interne au container ; il ne
sort jamais sur `lxdbr0`, donc les règles UFW qui bloquent les plages RFC1918
côté hôte ne s'appliquent pas et n'ont pas besoin d'être modifiées. Le serveur
MCP tourne comme sous-processus de la session Claude, pas via Bash — aucune
interaction avec les guardrails de `pre-bash.sh`.

## Composants

**1. `scripts/lib/forge-image.sh`**

Installation globale du paquet npm, en root (même convention que
`@anthropic-ai/claude-code` à la ligne 39 — pas besoin d'`aiuser`, qui
n'existe d'ailleurs pas encore à ce point du script) :

```bash
lxc exec "$setup" -- npm install -g chrome-devtools-mcp@<version épinglée>
```

Version épinglée explicitement (jamais `@latest`) — même principe que le
reste de l'image : reproductible, pas de dérive silencieuse entre deux
`forge image build`. La version exacte à épingler est vérifiée sur le
registre npm au moment de l'implémentation.

**2. `config/claude-onboarding-state.json`**

Poussé vers `~/.claude.json` une seule fois, à la création initiale d'un
container (`_forge_provision_container` dans `forge-start.sh:96`) — jamais
re-poussé sur un container déjà provisionné, ni par un `forge start`
ultérieur ni par `next-task`. Ajoute une clé `mcpServers` à la racine :

```json
"mcpServers": {
  "chrome-devtools": {
    "command": "chrome-devtools-mcp",
    "args": [
      "--headless=true",
      "--executablePath=/usr/bin/google-chrome-stable",
      "--isolated=true"
    ]
  }
}
```

`--isolated=true` donne un profil Chrome temporaire par lancement, pour éviter
les conflits de verrou de profil. Les noms de flags exacts (et l'ajout
éventuel de `--no-sandbox`, voir "Risques") sont vérifiés contre la doc CLI de
`chrome-devtools-mcp` au moment de l'implémentation — le principe (headless,
exécutable existant, profil isolé) est ce qui compte dans ce document.

**3. `README.md`**

La ligne qui liste ce que `forge image build` installe gagne
`chrome-devtools-mcp`. Une courte section "Vérification visuelle" documente
que l'outil est disponible pour tous les agents sans configuration par repo,
et précise que les deux moitiés (binaire dans l'image, déclaration MCP dans
`.claude.json`) n'atteignent que les *nouveaux* containers — voir "Risques"
pour l'ordre de déploiement à respecter.

**4. `templates/CLAUDE.md`**

Une ligne courte mentionnant que le MCP Chrome DevTools est disponible pour
vérifier les changements UI, dans le même esprit que la ligne existante sur
Docker/Compose.

## Risques et gestion des erreurs

- **Sandbox Chrome vs non-root** : `aiuser` n'a pas de sudo, et LXD n'expose
  pas nécessairement les user-namespaces imbriqués requis par le sandbox
  setuid de Chrome. Comme pour Docker rootless (qui a nécessité
  `security.nesting`), il est probable que Chrome doive tourner avec
  `--no-sandbox` en plus des flags MCP ci-dessus. À vérifier concrètement à
  l'implémentation ; risque acceptable ici puisque Chrome ne charge que le
  code de l'agent lui-même (son propre dev server local), jamais du contenu
  web arbitraire non fiable.
- **Dépendances système manquantes** : le `.deb` Chrome installe déjà ses
  dépendances via `--fix-missing` (ligne existante de `forge-image.sh`) — pas
  de changement attendu, confirmé par le smoke test.
- **Dérive de version** : version npm épinglée explicitement, comme décrit
  plus haut.
- **Containers déjà existants** : ce changement n'affecte que les *nouveaux*
  containers. Aucune des deux moitiés n'atteint un container déjà provisionné
  — ni le binaire (baked dans l'image au moment de `forge image build`), ni
  la déclaration `mcpServers` (poussée vers `~/.claude.json` une seule fois,
  à la création initiale du container, jamais re-poussée ensuite). Un
  container existant ne récupère les deux qu'en le supprimant et en le
  recréant (`forge delete` puis `forge start`) après un rebuild d'image.
- **Ordre de déploiement** : `forge image build` (qui installe le binaire)
  doit être exécuté avant de créer un nouveau container qui référence
  `chrome-devtools` dans `mcpServers` — sinon le serveur MCP pointe vers un
  binaire absent et échoue silencieusement au démarrage de la session. Les
  deux changements (image + `claude-onboarding-state.json`) doivent donc être
  déployés ensemble, dans cet ordre.

## Testing

Le repo a une suite de tests structurels par fichier (`tests/test-*.sh` —
assertions `grep`/JSON sur le contenu des scripts et configs, pas de
container LXD réel), à étendre pour chacun des fichiers touchés :

- `tests/test-forge-image.sh` : assertion que la ligne
  `npm install -g chrome-devtools-mcp` est présente dans
  `scripts/lib/forge-image.sh`, après l'installation de Chrome.
- `tests/test-claude-onboarding-state.sh` : assertion JSON que
  `mcpServers.chrome-devtools.command` vaut `chrome-devtools-mcp` dans
  `config/claude-onboarding-state.json`.
- `tests/test-readme-docs.sh` : assertion que `README.md` mentionne
  `chrome-devtools-mcp`.
- `tests/test-claude-template.sh` : assertion que `templates/CLAUDE.md`
  mentionne le MCP Chrome DevTools.

Au-delà de ces tests structurels, une vérification en usage réel (pas
automatisée, comme le reste du cycle de vie des containers) :

1. `./scripts/forge image build` — l'install `npm install -g chrome-devtools-mcp`
   réussit sans erreur.
2. Provisionner un container jetable, lancer `claude`, vérifier que
   `chrome-devtools` apparaît comme serveur MCP connecté (pas d'erreur de
   démarrage).
3. Smoke test fonctionnel : démarrer un petit serveur HTTP local dans le
   container, demander à l'agent de naviguer dessus via l'outil MCP, prendre
   un screenshot, lire les logs console — confirmer que le flux round-trip
   fonctionne bout en bout.
4. Nettoyage : supprimer le container jetable après test.

## Hors périmètre

Cet audit a été volontairement borné au trou concret identifié (Chrome sans
outil pour le piloter). D'autres manques potentiels pour la productivité sur
des tâches web (client DB/MCP backend, gestionnaire de versions Node pour
supporter plusieurs versions par repo, etc.) n'ont pas été creusés faute de
douleur concrète observée — à traiter dans un audit séparé si le besoin se
matérialise, plutôt que d'être anticipés ici (YAGNI).
