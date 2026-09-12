// Provisioning d'un container neuf. C'est la seule commande qui modifie
// l'hôte : elle crée ~/workspaces/<container>, et en mode supervised y clone
// par SSH. Les chemins hôte restent surchargeables par variable
// d'environnement pour que les tests ne touchent jamais un vrai home.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "../context.ts";
import { ForgeError, mustSucceed } from "../context.ts";
import { configSet, execAsAgent } from "../lxd.ts";
import { currentImageCommit } from "../containers.ts";

const home = () => process.env.FORGE_HOME ?? "/home/moroine";
const repoDir = () => process.env.FORGE_REPO_DIR ?? join(home(), "agent-forge");
const workspaces = () => process.env.FORGE_WORKSPACES ?? join(home(), "workspaces");

export async function provisionContainer(ctx: Context, container: string, ownerRepo: string): Promise<void> {
  const credentials = join(home(), ".claude", ".credentials.json");
  if (!existsSync(credentials)) {
    throw new ForgeError(`${credentials} not found. Run 'claude auth login' on the host first.`);
  }
  if ((await ctx.exec(["lxc", "image", "info", "agent-base"])).code !== 0) {
    throw new ForgeError("image agent-base not found. Run 'forge image build' first.");
  }

  const workspaceDir = join(workspaces(), container);
  const reuseWorkspace = await workspaceIsReusable(ctx, workspaceDir, ownerRepo);

  ctx.err("Mode for this container?");
  ctx.err("  [a] autonomous — bot pushes commits and opens PRs itself");
  ctx.err("  [s] supervised — no credential; you retrieve and publish the work yourself");
  const choice = (await ctx.prompt.ask("Choice [a/s]")) ?? "a";
  const mode = choice.toLowerCase().startsWith("s") ? "supervised" : "autonomous";

  ctx.out(`Creating container ${container}...`);
  await mustSucceed("lxc launch", ctx.exec(["lxc", "launch", "agent-base", container, "--profile", "agent"]));

  // Supprime le compte ubuntu laissé par cloud-init, qui peut avoir un accès
  // administrateur sans mot de passe. Tolérant délibérément (comme le
  // `|| true` du bash d'origine, forge-start.sh:263) : le compte peut ne pas
  // exister.
  ctx.out("Removing cloud-init ubuntu backdoor...");
  await ctx.exec(["lxc", "exec", container, "--", "deluser", "--remove-home", "ubuntu"]);
  await mustSucceed("remove cloud-init sudoers file",
    ctx.exec(["lxc", "exec", container, "--", "rm", "-f", "/etc/sudoers.d/90-cloud-init-users"]));

  ctx.out("Mounting workspace...");
  mkdirSync(workspaceDir, { recursive: true });
  // raw.idmap dans le profil mappe moroine (1000) vers aiuser (1001) et gère
  // aussi root : pas besoin d'idmap shifting sur ce device.
  await mustSucceed("mount workspace", ctx.exec(["lxc", "config", "device", "add", container, "workspace", "disk",
    `source=${workspaceDir}`, "path=/workspace"]));

  ctx.out("Copying signing key...");
  await mustSucceed("copy signing key", ctx.exec(["lxc", "file", "push", join(home(), ".ssh", "github_agents_signing"),
    `${container}/home/aiuser/.ssh/id_ed25519_signing`, "--uid", "1001", "--gid", "1001", "--mode", "600"]));

  ctx.out("Configuring git...");
  await mustSucceed("configure git", execAsAgent(ctx, container, [
    "git config --global user.name 'Claude Agent'",
    "git config --global user.email 'moroine-claude@users.noreply.github.com'",
    "git config --global gpg.format ssh",
    "git config --global user.signingkey /home/aiuser/.ssh/id_ed25519_signing",
    "git config --global commit.gpgsign true",
  ].join(" && ")));

  ctx.out("Reusing Claude Code credentials from host...");
  await mustSucceed("create .claude directory", execAsAgent(ctx, container, "mkdir -p /home/aiuser/.claude"));
  await mustSucceed("push Claude credentials", ctx.exec(["lxc", "file", "push", credentials,
    `${container}/home/aiuser/.claude/.credentials.json`, "--uid", "1001", "--gid", "1001", "--mode", "600"]));

  ctx.out("Pre-accepting Claude Code onboarding...");
  await mustSucceed("push onboarding state", ctx.exec(["lxc", "file", "push",
    join(repoDir(), "config", "claude-onboarding-state.json"),
    `${container}/home/aiuser/.claude.json`, "--uid", "1001", "--gid", "1001", "--mode", "600"]));

  ctx.out("Updating Claude Code to latest...");
  await mustSucceed("update Claude Code",
    ctx.exec(["lxc", "exec", container, "--", "npm", "install", "-g", "@anthropic-ai/claude-code@latest"]));

  ctx.out("Installing Claude plugins...");
  await mustSucceed("install Claude plugins", execAsAgent(ctx, container,
    "claude plugin marketplace add anthropics/claude-plugins-official && claude plugin install superpowers@claude-plugins-official"));

  ctx.out("Installing Claude global instructions...");
  await mustSucceed("push CLAUDE.md", ctx.exec(["lxc", "file", "push", join(repoDir(), "templates", "CLAUDE.md"),
    `${container}/home/aiuser/.claude/CLAUDE.md`, "--uid", "1001", "--gid", "1001", "--mode", "644"]));

  ctx.out("Installing Claude security hooks...");
  await mustSucceed("create hooks directory",
    ctx.exec(["lxc", "exec", container, "--", "mkdir", "-p", "/home/aiuser/.claude/hooks"]));
  await mustSucceed("push pre-bash.sh", ctx.exec(["lxc", "file", "push",
    join(repoDir(), ".claude", "hooks", "pre-bash.sh"),
    `${container}/home/aiuser/.claude/hooks/pre-bash.sh`, "--uid", "0", "--gid", "0", "--mode", "755"]));
  await mustSucceed("push Claude settings", ctx.exec(["lxc", "file", "push",
    join(repoDir(), "config", "claude-container-settings.json"),
    `${container}/home/aiuser/.claude/settings.json`, "--uid", "0", "--gid", "0", "--mode", "644"]));

  ctx.out("Recording forge mode marker...");
  await mustSucceed("record forge mode marker",
    execAsAgent(ctx, container, `echo '${mode}' > /home/aiuser/.claude/forge-mode`));

  // Supervised passe par SSH avec l'agent forwardé de l'humain ; autonomous
  // par HTTPS avec le credential helper que `gh auth setup-git` vient d'armer.
  const remote = mode === "supervised"
    ? `git@github.com:${ownerRepo}.git`
    : `https://github.com/${ownerRepo}.git`;

  if (mode === "autonomous") {
    ctx.err("");
    ctx.err("==============================================================");
    ctx.err("  GitHub token required (BOT account, fine-grained PAT)");
    ctx.err(`  Scoped to: ${ownerRepo} only`);
    ctx.err("  Permissions: Contents RW, Pull requests RW, Metadata R");
    ctx.err("  The token is piped into the container and never written");
    ctx.err("  to host disk.");
    ctx.err("==============================================================");
    const token = await ctx.prompt.askSecret("Paste the token (input hidden)");
    if (!token) throw new ForgeError("empty token.");

    ctx.out("Authenticating gh inside the container...");
    // Le token passe par stdin, jamais par argv : argv est visible dans ps.
    await mustSucceed("gh auth login", ctx.exec(
      ["lxc", "exec", container, "--", "su", "-", "aiuser", "-c", "gh auth login --hostname github.com --with-token"],
      { input: token },
    ));
    const status = await execAsAgent(ctx, container, "gh auth status --hostname github.com");
    if (status.code !== 0) throw new ForgeError("the pasted token was rejected by GitHub.");
    await mustSucceed("gh auth setup-git", execAsAgent(ctx, container, "gh auth setup-git"));
  }

  if (reuseWorkspace) {
    // Le clone survivant vient peut-être d'un container de l'autre mode : son
    // origin pointerait alors vers un protocole pour lequel CE container n'a
    // aucun credential. On le réaligne plutôt que de laisser le premier fetch
    // échouer.
    ctx.out(`Reusing the existing clone in ${workspaceDir}...`);
    await mustSucceed("realign origin remote",
      ctx.exec(["git", "-C", workspaceDir, "remote", "set-url", "origin", remote]));
  } else if (mode === "supervised") {
    ctx.out(`Cloning ${ownerRepo} on the host (branch main)...`);
    await mustSucceed("clone repository", ctx.exec(["git", "clone", remote, workspaceDir]));
  } else {
    ctx.out(`Cloning ${ownerRepo} (branch main)...`);
    await mustSucceed("clone repository", execAsAgent(ctx, container, `git clone ${remote} /workspace`));
  }

  ctx.out("Configuring git-lfs and ignoring worktrees...");
  // Passe par mustSucceed comme toute autre étape mutante : ce site d'appel
  // avait été oublié par c89dbf4 et jetait le stderr, ne laissant à
  // l'opérateur qu'un « git-lfs setup failed » sans le motif du refus de git.
  // C'est aussi la première commande du container à toucher /workspace : un
  // montage illisible se manifeste ici, et son message doit être lisible.
  await mustSucceed(`git-lfs setup in ${container}`, execAsAgent(ctx, container,
    "cd /workspace && git lfs install && { grep -qxF '.trees/' .git/info/exclude || echo '.trees/' >> .git/info/exclude; }"));

  ctx.out("Stamping the image build this container came from...");
  await mustSucceed("stamp image commit",
    configSet(ctx, container, "user.forge.image_commit", await currentImageCommit(ctx)));

  ctx.out("Recording forge metadata...");
  await mustSucceed("record forge repo", configSet(ctx, container, "user.forge.repo", ownerRepo));
  await mustSucceed("record forge mode", configSet(ctx, container, "user.forge.mode", mode));

  if (mode === "supervised") {
    ctx.err("");
    ctx.err("Retrieve this container's work from your laptop with:");
    ctx.err(`  git remote add ${container} ssh://moroine@<host>:2222${workspaceDir}`);
  }

  ctx.out(`Container ${container} provisioned.`);
}

// `forge delete` ne supprime QUE le container : ~/workspaces/<container> est
// monté depuis l'hôte et survit délibérément (delete.ts). Un re-provisioning
// tombait donc sur un `git clone` dans un répertoire non vide — et seulement
// après avoir créé le container, monté le disque et fait coller le PAT,
// laissant derrière lui un container à moitié provisionné sans métadonnée
// forge. On tranche ici, avant de rien créer :
//   - clone du même repo  -> on le réutilise (le travail supervised non
//     récupéré est la seule copie qui existe : on n'efface rien) ;
//   - autre chose non vide -> on s'arrête sans y toucher.
async function workspaceIsReusable(ctx: Context, workspaceDir: string, ownerRepo: string): Promise<boolean> {
  if (!existsSync(workspaceDir) || readdirSync(workspaceDir).length === 0) return false;

  // Sonde : un code non nul est une réponse (« pas un dépôt git »), pas une
  // panne — d'où l'absence de mustSucceed.
  const origin = await ctx.exec(["git", "-C", workspaceDir, "remote", "get-url", "origin"]);
  if (origin.code !== 0 || remoteRepo(origin.stdout) !== ownerRepo.toLowerCase()) {
    throw new ForgeError(
      `${workspaceDir} already exists, is not empty, and is not a clone of ${ownerRepo}. ` +
      "It is the only copy of whatever it contains, so provisioning stops rather than overwrite it: " +
      "move it aside (or remove it) and run the command again.");
  }
  return true;
}

// Réduit une URL de remote à son `owner/repo`, quelle que soit sa forme :
// git@github.com:o/r.git, https://github.com/o/r, ssh://git@github.com/o/r.git
// — y compris via un alias SSH (~/.ssh/config), d'où la comparaison sur le
// chemin seul et pas sur l'hôte.
function remoteRepo(url: string): string {
  const match = url.trim().replace(/\.git$/, "").match(/([^/:]+\/[^/]+)$/);
  return match ? match[1].toLowerCase() : "";
}
