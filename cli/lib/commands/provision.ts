// Provisioning d'un container neuf (spec v2, « Provisioning »). C'est la
// seule commande qui modifie l'hôte : elle crée un miroir nu de GitHub (par
// SSH, avec l'agent de l'humain) et ~/workspaces/<container>, cloné ensuite
// depuis le container. Un seul mode : supervised — aucun
// credential GitHub, aucune clé de signature, aucun compte bot dans le
// container. Les chemins hôte restent surchargeables par variable
// d'environnement (paths.ts) pour que les tests ne touchent jamais un vrai home.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Context, ExecResult } from "../context.ts";
import { ForgeError, mustSucceed } from "../context.ts";
import {
  BASE_IMAGE, latestImageCommit, PROVISIONING_KEY, PROVISIONING_WORKSPACE_KEY, provisioningMarker,
} from "../containers.ts";
import {
  configSet, configUnset, deleteInstance, execAsAgent, execAsAgentArgv, forgeProject, imageExists, incus, listObjects, waitReady,
} from "../incus.ts";
import {
  cloneWorkspace, ensureMirror, HOST_GIT_CWD, MIRROR_MOUNT, mirrorRepo, ORIGIN_DEVICE, pointOriginAtMirror,
  requireMirrorOf,
} from "../mirror.ts";
import { CLAUDE_TOKEN_FILE } from "../laptop/host-steps.ts";
import { PROFILE } from "../objects.ts";
import { allowlistPath, forgeHome, mirrorPath, repoRoot, workspacesDir } from "../paths.ts";
import { applyStrictSettings, requireStrictRuntime, strictLaunchArgs } from "../strict.ts";
import { egressNames } from "../objects.ts";

// Le concept de mode reste (pre-bash.sh, CLAUDE.md, user.forge.mode) : le mode
// autonome pourra revenir sans restructurer. v2 n'en provisionne qu'un.
const MODE = "supervised";
// Le token Claude dans le container (DX 5, décision 20) : un fichier mode 600
// dans un répertoire 700. Le lanceur forge-agent le lit et l'exporte pour le
// seul processus de l'agent.
export const CONTAINER_TOKEN_DIR = "/home/aiuser/.config/forge";
export const CONTAINER_TOKEN_PATH = `${CONTAINER_TOKEN_DIR}/claude-token`;
// Le miroir ne contient aucun objet LFS (mirror.ts clone déjà avec
// GIT_LFS_SKIP_SMUDGE=1) : les fichiers LFS restent des pointeurs dans le
// container. Sans ce drapeau, `git worktree add` (et tout checkout) tente de
// télécharger ces objets et échoue, ce qui bloque `forge start`. Exportées
// pour le test de contrat qui les rejoue avec un vrai git-lfs.
export const LFS_FILTERS_INSTALL = "git lfs install --skip-repo --skip-smudge";
export const LFS_HOOKS_INSTALL = "git lfs install --skip-smudge";

// Défait un provisioning interrompu. Règle : rien de ce qui existait avant la
// tentative échouée n'est supprimé. Le workspace marqué "kept" peut porter la
// seule copie d'un travail non récupéré ; le miroir n'est jamais touché. Le
// marqueur se lit avant la suppression de l'instance, qui l'emporte avec elle.
// Retourne ce qu'il est advenu du workspace : "emptied" (créé par la tentative
// échouée, donc vidé) ou "kept" (préexistant, ou dans le doute).
export async function discardHalfProvisioned(ctx: Context, container: string): Promise<"emptied" | "kept"> {
  const marker = await provisioningMarker(ctx, container);
  await mustSucceed("incus delete", deleteInstance(ctx, container));
  if (marker?.workspace !== "new") return "kept";
  const workspaceDir = join(workspacesDir(), container);
  if (!existsSync(workspaceDir)) return "emptied";
  // Le contenu seulement : le répertoire est reconstruit par le prochain launch.
  for (const entry of readdirSync(workspaceDir)) {
    rmSync(join(workspaceDir, entry), { recursive: true, force: true });
  }
  return "emptied";
}

// `strict` : le container naît strict — jamais lancé ouvert, puis restreint :
// l'ACL, les actions par défaut et l'environnement du proxy sont posés par le
// launch lui-même.
export async function provisionContainer(
  ctx: Context, container: string, ownerRepo: string, opts: { strict?: boolean } = {},
): Promise<{ mirror: "created" | "kept" }> {
  const strict = opts.strict === true;
  // Préconditions, toutes vérifiées avant de rien créer.
  const tokenFile = join(forgeHome(), CLAUDE_TOKEN_FILE);
  if (!existsSync(tokenFile) || statSync(tokenFile).size === 0) {
    throw new ForgeError(`${tokenFile} not found or empty. Run 'forge install' from your machine to store the Claude token.`);
  }
  const identity = await hostGitIdentity(ctx);
  await requireRuntime(ctx);
  const plan = strict ? await requireStrictRuntime(ctx) : null;
  const workspaceDir = join(workspacesDir(), container);
  const mirror = mirrorPath(container);
  // Seul le miroir (possédé par forge) se questionne avec git : le workspace,
  // lui, est écrit par l'agent, donc l'hôte n'y lance jamais git. Le refus
  // d'un miroir étranger passe avant celui du workspace : c'est lui qui nomme
  // la vraie cause.
  const existing = await mirrorRepo(ctx, mirror);
  const mirrorExists = existsSync(mirror);
  if (mirrorExists) requireMirrorOf(mirror, ownerRepo, existing);
  const reuseWorkspace = workspaceIsReusable(workspaceDir, mirror, ownerRepo, existing);

  // Le miroir se crée avant le lancement : un échec SSH ne laisse pas de
  // container. Un miroir existant vient d'être vérifié : pas de seconde sonde.
  ctx.out(mirrorExists ? `Reusing the host mirror ${mirror}...` : `Fetching ${ownerRepo} into the host mirror...`);
  const mirrorOutcome = mirrorExists ? "kept" : await ensureMirror(ctx, mirror, ownerRepo);

  ctx.out(`Creating container ${container}...`);
  const strictArgs = plan ? strictLaunchArgs(plan, egressNames(forgeProject())) : [];
  await mustSucceed("incus launch", ctx.exec(incus("launch", BASE_IMAGE, container, "--profile", PROFILE,
    // Marqueurs de provisioning : retirés en tout dernier, ils permettent de
    // reconnaître (et de relancer) un provisioning interrompu.
    "-c", `${PROVISIONING_KEY}=${ownerRepo}`,
    "-c", `${PROVISIONING_WORKSPACE_KEY}=${reuseWorkspace ? "kept" : "new"}`,
    ...strictArgs)));
  await waitReady(ctx, container);
  // Dès que le container tourne, avant tout accès réseau (plugins, apt).
  if (plan) await applyStrictSettings(ctx, container, plan);

  mkdirSync(workspaceDir, { recursive: true });
  // Le miroir est monté en lecture seule : le container clone depuis lui et
  // n'a jamais de credential GitHub.
  ctx.out("Mounting the mirror and the workspace...");
  await mustSucceed("mount mirror", ctx.exec(incus("config", "device", "add", container, ORIGIN_DEVICE, "disk",
    `source=${mirror}`, `path=${MIRROR_MOUNT}`, "readonly=true")));
  // raw.idmap (profil agent-forge) mappe l'utilisateur hôte sur aiuser : pas
  // de shift sur ce device — un projet restreint l'interdirait de toute façon.
  await mustSucceed("mount workspace", ctx.exec(incus("config", "device", "add", container, "workspace", "disk",
    `source=${workspaceDir}`, "path=/workspace")));
  if (reuseWorkspace) {
    // Le clone survivant a pu être fait par un container v1 (origin sur GitHub) :
    // on le réaligne sur le miroir, depuis le container.
    ctx.out(`Reusing the existing clone in ${workspaceDir}...`);
    await mustSucceed("realign origin remote", pointOriginAtMirror(ctx, container));
  } else {
    ctx.out(`Cloning ${ownerRepo} in the container...`);
    await mustSucceed("clone repository", cloneWorkspace(ctx, container));
  }

  // L'agent commite sous l'identité de l'humain, sans signature : l'humain
  // re-signe en publiant. Le trailer Co-Authored-By de Claude Code marque
  // toujours les commits de l'agent.
  ctx.out("Configuring git (your identity, unsigned commits)...");
  for (const [key, value] of [["user.name", identity.name], ["user.email", identity.email], ["commit.gpgsign", "false"]]) {
    await mustSucceed(`git config ${key}`, execAsAgentArgv(ctx, container, ["git", "config", "--global", key, value]));
  }

  // Le token est poussé comme fichier (incus file push lit le fichier hôte) :
  // jamais dans un argv, un journal ou la mémoire de forge.
  ctx.out("Pushing the Claude token...");
  await mustSucceed("create .claude directory", execAsAgent(ctx, container, "mkdir -p /home/aiuser/.claude"));
  await mustSucceed("create token directory",
    execAsAgentArgv(ctx, container, ["mkdir", "-p", "-m", "700", CONTAINER_TOKEN_DIR]));
  await pushFile(ctx, "push Claude token", tokenFile, container, CONTAINER_TOKEN_PATH, 1001, "600");

  ctx.out("Pre-accepting Claude Code onboarding...");
  await pushFile(ctx, "push onboarding state", join(repoRoot(), "container", "claude.json"),
    container, "/home/aiuser/.claude.json", 1001, "600");

  ctx.out("Installing Claude global instructions...");
  await pushFile(ctx, "push CLAUDE.md", join(repoRoot(), "container", "CLAUDE.md"),
    container, "/home/aiuser/.claude/CLAUDE.md", 1001, "644");

  // Le lanceur de l'agent (token + marqueur de la tâche) : root, 755.
  await pushFile(ctx, "push forge-agent", join(repoRoot(), "container", "forge-agent"),
    container, "/usr/local/bin/forge-agent", 0, "755");

  // Le hook et les réglages appartiennent à root : l'agent ne peut pas les
  // réécrire en place.
  ctx.out("Installing Claude security hooks...");
  await mustSucceed("create hooks directory",
    ctx.exec(incus("exec", container, "--", "mkdir", "-p", "/home/aiuser/.claude/hooks")));
  await pushFile(ctx, "push pre-bash.sh", join(repoRoot(), "container", "pre-bash.sh"),
    container, "/home/aiuser/.claude/hooks/pre-bash.sh", 0, "755");
  await pushFile(ctx, "push Claude settings", join(repoRoot(), "container", "settings.json"),
    container, "/home/aiuser/.claude/settings.json", 0, "644");
  await requireHookBlocks(ctx, container, ownerRepo);

  await refreshClaude(ctx, container, strict);

  ctx.out("Recording forge mode marker...");
  await mustSucceed("record forge mode marker",
    execAsAgent(ctx, container, `echo '${MODE}' > /home/aiuser/.claude/forge-mode`));
  await mustSucceed("record forge mode", configSet(ctx, container, "user.forge.mode", MODE));

  // Les trois étapes ci-dessous n'ont ni la même cible ni la même fiabilité :
  // elles restent séparées (v1).
  ctx.out("Installing git-lfs filters...");
  // `--skip-repo` : les filtres clean/smudge/process, dans la config globale,
  // sans toucher aux hooks du dépôt. Déterministe, donc fatal s'il échoue.
  await mustSucceed(`git-lfs filters in ${container}`,
    execAsAgent(ctx, container, LFS_FILTERS_INSTALL));

  ctx.out("Ignoring worktrees in the main clone...");
  // .trees/ ne doit jamais apparaître dans le status du clone principal.
  await mustSucceed(`worktree exclude in ${container}`, execAsAgent(ctx, container,
    "cd /workspace && { grep -qxF '.trees/' .git/info/exclude || echo '.trees/' >> .git/info/exclude; }"));

  ctx.out("Installing git-lfs hooks in /workspace...");
  // Best-effort : `git lfs install` refuse d'écraser un pre-push qu'il ne
  // reconnaît pas (husky, lefthook, hooks d'un autre git-lfs). Les filtres
  // sont là, seul le hook d'upload manque. Cette commande réécrit aussi les
  // filtres globaux : elle garde `--skip-smudge`, sinon elle l'annulerait.
  const hooks = await execAsAgent(ctx, container, `cd /workspace && ${LFS_HOOKS_INSTALL}`);
  if (hooks.code !== 0) {
    ctx.err(`WARNING: installing git-lfs hooks in /workspace failed: ${hooks.stderr.trim() || `exit code ${hooks.code}`}`);
    ctx.err("The LFS filters are installed, so LFS files still check out (as pointers) and commit; only the pre-push");
    ctx.err("upload hook is missing. Expected when the project manages its own hooks (husky, lefthook) or when");
    ctx.err("they were written by another git-lfs version. If a task touches LFS-tracked files, run");
    ctx.err("'git lfs update --manual' in /workspace to merge the hooks by hand.");
  }

  ctx.out("Stamping the image build this container came from...");
  await mustSucceed("stamp image commit",
    configSet(ctx, container, "user.forge.image_commit", await latestImageCommit(ctx)));

  // user.forge.repo reste la clé que checkNameCollision reconnaît ; les
  // marqueurs de provisioning ne partent qu'après elle, en tout dernier.
  ctx.out("Recording forge metadata...");
  await mustSucceed("record forge repo", configSet(ctx, container, "user.forge.repo", ownerRepo));
  await mustSucceed("clear provisioning marker", configUnset(ctx, container, PROVISIONING_KEY));
  await mustSucceed("clear provisioning marker", configUnset(ctx, container, PROVISIONING_WORKSPACE_KEY));

  ctx.out(`Container ${container} provisioned.`);
  return { mirror: mirrorOutcome };
}

// Sondes : un code non nul veut dire « pas réglé ». Depuis HOST_GIT_CWD : lancé
// dans ~/workspaces/<c>, git y découvrirait le dépôt de l'agent (les includeIf
// de la config globale s'évaluent contre lui).
async function hostGitIdentity(ctx: Context): Promise<{ name: string; email: string }> {
  const opts = { cwd: HOST_GIT_CWD };
  const name = (await ctx.exec(["git", "config", "--global", "--includes", "user.name"], opts)).stdout.trim();
  const email = (await ctx.exec(["git", "config", "--global", "--includes", "user.email"], opts)).stdout.trim();
  if (!name || !email) {
    throw new ForgeError(
      "the agent commits under your git identity, which is not set on this host. Run:\n" +
      '  git config --global user.name "Your Name"\n' +
      "  git config --global user.email you@example.com\n" +
      "then run forge start again.");
  }
  return { name, email };
}

// `forge start` vérifie, avant de rien créer, que `forge setup` et
// `forge image build` sont passés.
async function requireRuntime(ctx: Context): Promise<void> {
  if (!(await listObjects(ctx, "profile")).some((p) => p.name === PROFILE)) {
    throw new ForgeError(`profile ${PROFILE} not found in Incus project ${forgeProject()}. Run 'forge setup' first.`);
  }
  if (!(await imageExists(ctx, BASE_IMAGE))) {
    throw new ForgeError(`image ${BASE_IMAGE} not found. Run 'forge image build' first.`);
  }
}

// Preuve que le hook garde vraiment CE container, dans les deux sens. Un hook
// qui ne peut pas lire sa commande (image sans jq, constaté le 2026-10-17)
// laissait tout passer ; devenu fail-closed, il refuse tout — sûr, mais
// l'agent ne peut plus rien lancer. On lui soumet donc, en tant qu'aiuser, une
// commande qu'il doit refuser (exit 2) et une qu'il doit laisser passer
// (exit 0). Les marqueurs forge-hook-probe-* rendent les lignes du journal
// d'audit (/workspace/.claude/bash-audit.log) explicites.
const hookProbe = (command: string) =>
  `printf '%s' '{"tool_name":"Bash","tool_input":{"command":"${command}"}}' | /home/aiuser/.claude/hooks/pre-bash.sh`;

async function requireHookBlocks(ctx: Context, container: string, ownerRepo: string): Promise<void> {
  ctx.out("Checking that the security hook guards the agent...");
  // Le container porte encore ses marqueurs de provisioning : `forge delete`
  // sait le retirer.
  const rebuild = "Rebuild the image ('forge image build'), remove this container with " +
    `'forge delete ${ownerRepo}' (its workspace survives), then start the task again.`;
  // Le hook termine ses phrases par un point : on le retire avant d'enchaîner.
  const detail = (r: ExecResult) => {
    const stderr = r.stderr.trim().replace(/\.+$/, "");
    return stderr ? `: ${stderr}` : "";
  };

  const deny = await execAsAgentArgv(ctx, container, ["bash", "-c", hookProbe("sudo true # forge-hook-probe-deny")]);
  if (deny.code !== 2) {
    throw new ForgeError(
      `the container's security hook let a forbidden command through (exit code ${deny.code}, expected 2)${detail(deny)}. ` +
      `The agent would run unguarded, so provisioning stops. ${rebuild}`);
  }
  const allow = await execAsAgentArgv(ctx, container, ["bash", "-c", hookProbe("true # forge-hook-probe-allow")]);
  if (allow.code !== 0) {
    throw new ForgeError(
      `the container's security hook refuses a harmless command (exit code ${allow.code}, expected 0)${detail(allow)}. ` +
      `The agent could not run anything, so provisioning stops. ${rebuild}`);
  }
}

// `incus file push` avec propriétaire et mode. uid 0 : fichier que l'agent ne
// peut pas modifier.
function pushFile(ctx: Context, step: string, source: string, container: string, dest: string, uid: 0 | 1001, mode: string) {
  return mustSucceed(step, ctx.exec(incus("file", "push", source, `${container}${dest}`,
    "--uid", String(uid), "--gid", String(uid), "--mode", mode)));
}

// La version de l'image fonctionne : un échec ici (réseau, dépôt) est un
// avertissement, pas une raison d'abandonner le provisioning.
// En strict, apt ne lit que la source d'Anthropic (les dépôts Ubuntu ne sont
// pas dans la liste blanche), sans purger les listes des autres.
async function refreshClaude(ctx: Context, container: string, strict: boolean): Promise<void> {
  ctx.out("Updating Claude Code...");
  const apt = (...args: string[]) =>
    ctx.exec(incus("exec", container, "--env", "DEBIAN_FRONTEND=noninteractive", "--", "apt-get", ...args));
  let r = await apt("update", ...(strict ? [
    "-o", "Dir::Etc::sourcelist=/etc/apt/sources.list.d/claude-code.sources",
    "-o", "Dir::Etc::sourceparts=-", "-o", "APT::Get::List-Cleanup=0",
  ] : []));
  if (r.code === 0) r = await apt("install", "--only-upgrade", "-y", "claude-code");
  if (r.code !== 0) {
    ctx.err(`WARNING: updating Claude Code failed, the image's version stays: ${r.stderr.trim() || `exit code ${r.code}`}`);
  }
}

// `forge delete` ne supprime QUE le container : ~/workspaces/<container> et le
// miroir survivent délibérément (delete.ts). On tranche ici, avant de rien
// créer, sans jamais lancer git dans le workspace :
//   - vide ou absent       -> on clone dedans ;
//   - non vide, miroir du même repo -> on le réutilise (le travail supervised
//     non récupéré est la seule copie qui existe : on n'efface rien) ;
//   - autre chose non vide -> on s'arrête sans y toucher.
function workspaceIsReusable(workspaceDir: string, mirror: string, ownerRepo: string, existing: string | null): boolean {
  if (!existsSync(workspaceDir) || readdirSync(workspaceDir).length === 0) return false;
  if (existing !== ownerRepo.toLowerCase()) {
    throw new ForgeError(
      `${workspaceDir} already exists and is not empty, and no mirror of ${ownerRepo} vouches for it (${mirror}). ` +
      "It is the only copy of whatever it contains, so provisioning stops rather than overwrite it: " +
      "move it aside (or remove it) and run the command again.");
  }
  return true;
}
