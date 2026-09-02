// Provisioning d'un container neuf. C'est la seule commande qui modifie
// l'hôte : elle crée ~/workspaces/<container>, et en mode supervised y clone
// par SSH. Les chemins hôte restent surchargeables par variable
// d'environnement pour que les tests ne touchent jamais un vrai home.
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Context, ExecResult } from "../context.ts";
import { ForgeError } from "../context.ts";
import { configSet, execAsAgent } from "../lxd.ts";
import { currentImageCommit } from "../containers.ts";

const home = () => process.env.FORGE_HOME ?? "/home/moroine";
const repoDir = () => process.env.FORGE_REPO_DIR ?? join(home(), "agent-forge");
const workspaces = () => process.env.FORGE_WORKSPACES ?? join(home(), "workspaces");

// Le bash original tourne sous `set -e` : n'importe quelle étape en échec
// interrompait tout le provisioning. Cette fonction restaure ce fail-fast
// pour chaque étape mutante — appliquée uniformément plutôt qu'à une
// sélection à la main, faute de quoi une étape non couverte peut échouer en
// silence (c'est exactement ce qui manquait avant : le clone pouvait rater
// et le container se retrouvait quand même timbré avec les métadonnées
// forge, prêt à être réutilisé par erreur par checkNameCollision).
async function mustSucceed(step: string, result: Promise<ExecResult>): Promise<ExecResult> {
  const r = await result;
  if (r.code !== 0) {
    throw new ForgeError(`${step} failed: ${r.stderr.trim() || `exit code ${r.code}`}`);
  }
  return r;
}

export async function provisionContainer(ctx: Context, container: string, ownerRepo: string): Promise<void> {
  const credentials = join(home(), ".claude", ".credentials.json");
  if (!existsSync(credentials)) {
    throw new ForgeError(`${credentials} not found. Run 'claude auth login' on the host first.`);
  }
  if ((await ctx.exec(["lxc", "image", "info", "agent-base"])).code !== 0) {
    throw new ForgeError("image agent-base not found. Run 'forge image build' first.");
  }

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
  const workspaceDir = join(workspaces(), container);
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

  if (mode === "supervised") {
    ctx.out(`Cloning ${ownerRepo} on the host (branch main)...`);
    await mustSucceed("clone repository",
      ctx.exec(["git", "clone", `git@github.com:${ownerRepo}.git`, workspaceDir]));
  } else {
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

    ctx.out(`Cloning ${ownerRepo} (branch main)...`);
    await mustSucceed("clone repository",
      execAsAgent(ctx, container, `git clone https://github.com/${ownerRepo}.git /workspace`));
  }

  ctx.out("Configuring git-lfs and ignoring worktrees...");
  const lfs = await execAsAgent(ctx, container,
    "cd /workspace && git lfs install && { grep -qxF '.trees/' .git/info/exclude || echo '.trees/' >> .git/info/exclude; }");
  if (lfs.code !== 0) throw new ForgeError(`git-lfs setup failed in ${container}.`);

  ctx.out("Stamping the image build this container came from...");
  await configSet(ctx, container, "user.forge.image_commit", await currentImageCommit(ctx));

  ctx.out("Recording forge metadata...");
  await configSet(ctx, container, "user.forge.repo", ownerRepo);
  await configSet(ctx, container, "user.forge.mode", mode);

  if (mode === "supervised") {
    ctx.err("");
    ctx.err("Retrieve this container's work from your laptop with:");
    ctx.err(`  git remote add ${container} ssh://moroine@<host>:2222${workspaceDir}`);
  }

  ctx.out(`Container ${container} provisioned.`);
}
