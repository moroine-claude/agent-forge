// forge fetch: in the developer's clone, fetch the agents' agent/* branches
// from the team mirror through the forge host, refresh origin, and list the tasks.
import { ForgeError, mustSucceed, type Context } from "../context.ts";
import { ensureForgeRemote, forgeRemoteAliases, legacyRemote, openClone, teamRemote } from "../laptop/clone.ts";
import { remoteExec } from "../laptop/remote.ts";
import { agentRef, githubRef, limitRef, refExists, resolveBase } from "../laptop/ship-plan.ts";
import { loadHosts, selectHost, type LaptopHost } from "../laptop/state.ts";
import { printable } from "../printable.ts";
import { isTaskName } from "../validate.ts";

export type Fetched = {
  root: string; ownerRepo: string; team: string; remote: string; host: LaptopHost;
  // task -> the ref it started from, as `forge team task-base` records it
  bases: Map<string, string>;
};

// GitHub's agent branches, whatever the clone's own refspecs fetch.
const AGENT_BRANCHES = "+refs/heads/agent/*:refs/remotes/origin/agent/*";
// What the host answers to `forge team for-repo`: a team name, checked before it
// becomes a git remote's name.
const TEAM_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export async function fetchAgents(ctx: Context, opts: { host?: string; cwd?: string } = {}): Promise<Fetched> {
  const { root, ownerRepo } = await openClone(ctx, opts.cwd);
  // --host wins; else a host this clone's forge remotes already name, when
  // hosts.json still lists it; else the usual selection.
  const aliases = opts.host === undefined ? await forgeRemoteAliases(ctx, root) : [];
  const known = loadHosts().find((h) => aliases.includes(h.name));
  const host = known ?? (await selectHost(ctx, opts.host));

  const asked = await remoteExec(ctx, host, ["forge", "team", "for-repo", ownerRepo]);
  const team = asked.stdout.trim();
  if (asked.code !== 0 || team === "") {
    // Exit 1 and no output: the host answered, and no team holds this repository.
    throw new ForgeError(asked.code === 1 && team === ""
      ? `${host.name} has no team for ${ownerRepo}: no team of its forge config declares that repository ` +
        "(forge team up, after declaring one in ~/.config/agent-forge/config.json on the host)."
      : `forge team for-repo ${ownerRepo} failed on ${host.name}: ${asked.stderr.trim() || `exit code ${asked.code}`}`);
  }
  if (!TEAM_NAME.test(team)) throw new ForgeError(`${host.name} answered a team name that is not one: ${printable(team)}`);
  const remote = teamRemote(team);

  const legacy = await legacyRemote(ctx, root, ownerRepo);
  if (legacy !== null) ctx.out(`Remote ${legacy} is a single-agent remote, no longer fetched: left in place.`);
  // A change to the developer's clone is said.
  const ensured = await ensureForgeRemote(ctx, root, team, host.name);
  if (ensured === "added") ctx.out(`Added remote ${remote} (${host.name}:team-${team}) to this clone.`);
  if (ensured === "fixed") ctx.out(`Fixed remote ${remote} (${host.name}:team-${team}) in this clone.`);

  // git's output is captured: an SSH key's touch prompt would go unseen, so a
  // line says which fetch is waiting.
  ctx.out(`Fetching ${remote}…`);
  // The agent's tags never land in the clone: --no-tags on top of the remote's
  // tagOpt, and --no-prune-tags on top of its pruneTags, since the developer's
  // fetch.pruneTags turns a pruning fetch into one of refs/tags/* as well.
  await mustSucceed(`git fetch ${remote}`,
    ctx.exec(["git", "fetch", "--prune", "--no-tags", "--no-prune-tags", remote], { cwd: root }));
  ctx.out("Fetching origin…");
  // --prune: a branch merged and deleted on GitHub must disappear. Refspecs on
  // the command line replace the configured ones, so those are passed too; the
  // agent branches are added because a single-branch clone never fetches them.
  // --no-prune-tags: forge's own --prune never deletes the developer's tags.
  const configured = (await ctx.exec(["git", "config", "--get-all", "remote.origin.fetch"], { cwd: root })).stdout
    .split("\n").map((s) => s.trim()).filter(Boolean);
  await mustSucceed("git fetch origin",
    ctx.exec(["git", "fetch", "--prune", "--no-prune-tags", "origin", ...configured, AGENT_BRANCHES], { cwd: root }));

  const listed = await remoteExec(ctx, host, ["forge", "team", "task-base", team]);
  if (listed.code !== 0) {
    throw new ForgeError(`forge team task-base ${team} failed on ${host.name}: ${listed.stderr.trim() || `exit code ${listed.code}`}`);
  }
  const bases = new Map<string, string>();
  for (const line of listed.stdout.split("\n")) {
    const [task, base] = line.split("\t");
    if (task && base) bases.set(task, base.trim());
  }
  return { root, ownerRepo, team, remote, host, bases };
}

// The agent's tasks in the clone: the branches refs/remotes/<remote>/agent/*.
// The agent picks those names, and git takes C1 controls in a ref name (U+009B
// is the 8-bit CSI), so only names `forge start` could have given are kept; the
// others are said once, filtered, and neither listed nor offered to ship.
export async function agentTasks(
  ctx: Context, git: (...args: string[]) => Promise<string>, remote: string,
): Promise<string[]> {
  const prefix = `refs/remotes/${remote}/agent/`;
  const all = (await git("for-each-ref", "--format=%(refname)", prefix)).split("\n").filter(Boolean)
    .map((r) => r.slice(prefix.length));
  for (const name of all.filter((n) => !isTaskName(n))) {
    ctx.out(`skipped an agent branch whose task name is not [A-Za-z0-9._-]: agent/${printable(name)}`);
  }
  return all.filter(isTaskName);
}

export async function cmdFetch(ctx: Context, opts: { host?: string; cwd?: string } = {}): Promise<number> {
  const { root, remote, bases: recorded } = await fetchAgents(ctx, opts);
  const git = async (...args: string[]) =>
    (await mustSucceed(`git ${args[0]}`, ctx.exec(["git", ...args], { cwd: root }))).stdout;
  const names = async (prefix: string) =>
    (await git("for-each-ref", "--format=%(refname)", prefix)).split("\n").filter(Boolean).map((r) => r.slice(prefix.length));

  // A review by hand (git log -p origin/main..<remote>/agent/<task>, or
  // main..) uses short names, which git looks up in refs/tags/ first. And a
  // full name (refs/remotes/…) that does not exist yet, say origin/agent/<t>
  // before its first ship, falls back to refs/tags/<that name>.
  const shadowing = await git("for-each-ref", "--format=%(refname:strip=2)",
    "refs/tags/origin", `refs/tags/${remote}`, "refs/tags/main", "refs/tags/refs");
  for (const tag of shadowing.split("\n").filter(Boolean)) {
    // Not a name the clone's own tags would have: shown filtered, with no
    // command to paste.
    if (printable(tag) !== tag) {
      ctx.err(`WARNING: tag ${printable(tag)} hides the branch ${printable(tag)} in git commands: delete it with git tag -d, unless you made it (its name holds control characters)`);
      continue;
    }
    ctx.err(`WARNING: tag ${tag} hides the branch ${tag} in git commands: delete it (git tag -d ${tag}) unless you made it`);
  }

  const tasks = await agentTasks(ctx, git, remote);
  if (tasks.length === 0) ctx.out("no agent branches yet");
  // The base as ship reads it: a tag, a SHA or a branch gone from GitHub is main, assumed.
  const known = new Set(tasks);
  const github = new Set((await names("refs/remotes/origin/")).filter((b) => b !== "HEAD"));
  for (const task of tasks) {
    const head = agentRef(remote, task);
    const given = recorded.get(task);
    const base = resolveBase(given, known, (b) => github.has(b));
    const limit = limitRef(remote, base);
    const label = base.kind === "task" ? `agent/${base.task}`
      : !base.assumed ? `origin/${base.branch}`
      : given ? `main (assumed, started from ${given})` : "main (assumed)";
    // A base can vanish: a merged GitHub branch deleted, then pruned above.
    const baseGone = !(await refExists(ctx, root, limit));
    let line = baseGone
      ? `agent/${task}  base ${label} is gone`
      : `agent/${task}  ${(await git("rev-list", "--count", head, `^${limit}`)).trim()} commits on ${label}`;
    // Shipped = a patch-equivalent commit is already on origin/agent/<task>.
    const shipped = githubRef(`agent/${task}`);
    if (await refExists(ctx, root, shipped)) {
      const cherry = await git("cherry", shipped, head, ...(baseGone ? [] : [limit]));
      line += `, ${cherry.split("\n").filter((l) => l.startsWith("+")).length} not shipped`;
    }
    ctx.out(line);
  }
  return 0;
}
