// forge fetch: in the developer's clone, fetch the agents' agent/* branches
// from the container through the forge host, refresh origin, and list the tasks.
import { ForgeError, mustSucceed, type Context } from "../context.ts";
import { ensureForgeRemote, forgeRemoteHost, openClone } from "../laptop/clone.ts";
import { remoteExec } from "../laptop/remote.ts";
import { agentRef, githubRef, limitRef, refExists, resolveBase } from "../laptop/ship-plan.ts";
import { loadHosts, selectHost, type LaptopHost } from "../laptop/state.ts";

export type Fetched = {
  root: string; ownerRepo: string; container: string; host: LaptopHost;
  // task -> the ref it started from, as `forge task-base` records it
  bases: Map<string, string>;
};

// GitHub's agent branches, whatever the clone's own refspecs fetch.
const AGENT_BRANCHES = "+refs/heads/agent/*:refs/remotes/origin/agent/*";

export async function fetchAgents(ctx: Context, opts: { host?: string; cwd?: string } = {}): Promise<Fetched> {
  const { root, ownerRepo, container } = await openClone(ctx, opts.cwd);
  // --host wins; else the host the clone's forge remote already names, when
  // hosts.json still lists it; else the usual selection.
  const alias = await forgeRemoteHost(ctx, root, container);
  const known = alias !== null && opts.host === undefined ? loadHosts().find((h) => h.name === alias) : undefined;
  const host = known ?? (await selectHost(ctx, opts.host));
  // A change to the developer's clone is said.
  const remote = await ensureForgeRemote(ctx, root, container, host.name);
  if (remote === "added") ctx.out(`Added remote ${container} (${host.name}:${container}) to this clone.`);
  if (remote === "fixed") ctx.out(`Fixed remote ${container} (${host.name}:${container}) in this clone.`);

  // git's output is captured: an SSH key's touch prompt would go unseen, so a
  // line says which fetch is waiting.
  ctx.out(`Fetching ${container}…`);
  // --no-tags on top of the remote's tagOpt: the agent's tags never land in the clone.
  await mustSucceed(`git fetch ${container}`, ctx.exec(["git", "fetch", "--prune", "--no-tags", container], { cwd: root }));
  ctx.out("Fetching origin…");
  // --prune: a branch merged and deleted on GitHub must disappear. Refspecs on
  // the command line replace the configured ones, so those are passed too; the
  // agent branches are added because a single-branch clone never fetches them.
  const configured = (await ctx.exec(["git", "config", "--get-all", "remote.origin.fetch"], { cwd: root })).stdout
    .split("\n").map((s) => s.trim()).filter(Boolean);
  await mustSucceed("git fetch origin",
    ctx.exec(["git", "fetch", "--prune", "origin", ...configured, AGENT_BRANCHES], { cwd: root }));

  const listed = await remoteExec(ctx, host, ["forge", "task-base", container]);
  if (listed.code !== 0) {
    throw new ForgeError(`forge task-base ${container} failed on ${host.name}: ${listed.stderr.trim() || `exit code ${listed.code}`}`);
  }
  const bases = new Map<string, string>();
  for (const line of listed.stdout.split("\n")) {
    const [task, base] = line.split("\t");
    if (task && base) bases.set(task, base.trim());
  }
  return { root, ownerRepo, container, host, bases };
}

export async function cmdFetch(ctx: Context, opts: { host?: string; cwd?: string } = {}): Promise<number> {
  const { root, container, bases: recorded } = await fetchAgents(ctx, opts);
  const git = async (...args: string[]) =>
    (await mustSucceed(`git ${args[0]}`, ctx.exec(["git", ...args], { cwd: root }))).stdout;
  const names = async (prefix: string) =>
    (await git("for-each-ref", "--format=%(refname)", prefix)).split("\n").filter(Boolean).map((r) => r.slice(prefix.length));

  // forge reads full ref names, but a review by hand (git log -p
  // origin/main..<container>/agent/<task>, or main..) uses short ones, which
  // git looks up in refs/tags/ first.
  const shadowing = await git("for-each-ref", "--format=%(refname:strip=2)", "refs/tags/origin", `refs/tags/${container}`, "refs/tags/main");
  for (const tag of shadowing.split("\n").filter(Boolean)) {
    ctx.err(`WARNING: tag ${tag} hides the branch ${tag} in git commands: delete it (git tag -d ${tag}) unless you made it`);
  }

  const tasks = await names(`refs/remotes/${container}/agent/`);
  if (tasks.length === 0) ctx.out("no agent branches yet");
  // The base as ship reads it: a tag, a SHA or a branch gone from GitHub is main, assumed.
  const known = new Set(tasks);
  const github = new Set((await names("refs/remotes/origin/")).filter((b) => b !== "HEAD"));
  for (const task of tasks) {
    const head = agentRef(container, task);
    const given = recorded.get(task);
    const base = resolveBase(given, known, (b) => github.has(b));
    const limit = limitRef(container, base);
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
