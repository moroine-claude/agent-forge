// The ship plan: from the recorded bases and the fetched refs of the
// developer's clone, which commits of a task to replay, onto what, and the base
// of its PR. Pure planning: nothing is signed or pushed here.
//
// Every ref handed to git is a full refs/remotes/… name: git looks a short
// name up in refs/tags/ first, so a tag named origin/main would otherwise
// decide what is replayed, and onto what. And a full name only reaches git
// once refExists has seen that very ref: missing, git would fall back to
// refs/tags/<the full name>.
import { ForgeError, mustSucceed, type Context } from "../context.ts";

export type Base =
  | { kind: "task"; task: string }
  | { kind: "branch"; branch: string; assumed: boolean };

const MAIN: Base = { kind: "branch", branch: "main", assumed: true };

// Turns the base `forge task-base` recorded into what it designates. A tag, a
// SHA or a branch that is gone cannot be a PR base: assume main.
export function resolveBase(recorded: string | undefined, tasks: Set<string>, onGithub: (branch: string) => boolean): Base {
  if (!recorded) return MAIN;
  if (recorded.startsWith("origin/")) return { kind: "branch", branch: recorded.slice("origin/".length), assumed: false };
  const task = recorded.startsWith("agent/") ? recorded.slice("agent/".length) : undefined;
  if (task !== undefined && tasks.has(task)) return { kind: "task", task };
  return onGithub(recorded) ? { kind: "branch", branch: recorded, assumed: false } : MAIN;
}

// The tasks from the lowest of the stack up to `task`, bottom first.
export function chainFor(task: string, bases: Map<string, Base>): string[] {
  const chain = [task];
  for (let base = bases.get(task); base?.kind === "task"; base = bases.get(base.task)) {
    if (chain.includes(base.task)) {
      // chain is top first: the cycle runs from base.task down to the last entry.
      const cycle = [...chain.slice(chain.indexOf(base.task)), base.task];
      throw new ForgeError(`tasks base on each other in a cycle: ${cycle.join(" -> ")}`);
    }
    chain.push(base.task);
  }
  return chain.reverse();
}

// A task's PR base: its base branch, or the branch of the task below, unless
// that task's PR is merged: then the base that PR had.
export function prBaseFor(base: Base, below?: { prBase: string; merged: boolean }): string {
  if (base.kind === "branch") return base.branch;
  return below?.merged ? below.prBase : `agent/${base.task}`;
}

// The refs of the developer's clone: a task's branch as fetched from the
// remote, a branch as fetched from GitHub.
export const agentRef = (remote: string, task: string): string => `refs/remotes/${remote}/agent/${task}`;
export const githubRef = (branch: string): string => `refs/remotes/origin/${branch}`;

// What a task started from, in the clone.
export function limitRef(remote: string, base: Base): string {
  return base.kind === "task" ? agentRef(remote, base.task) : githubRef(base.branch);
}

export type TaskPlan = {
  task: string;
  tip: string;            // refs/remotes/<remote>/agent/<task>
  limit: string;          // what the task started from, as a full ref name
  commits: string[];      // to replay, oldest first
  onto: string;           // a full ref name; the merge-base SHA on the first ship of a branch-based task
  prBase: string;
  shipped: boolean;       // refs/remotes/origin/agent/<task> exists
};

// `below`: the task this one is stacked on, once the caller knows its PR is
// merged; the task then goes onto that PR's base instead.
export async function planTask(
  ctx: Context, root: string, remote: string, task: string, base: Base,
  below?: { prBase: string; merged: boolean },
): Promise<TaskPlan> {
  const git = async (...args: string[]) =>
    (await mustSucceed(`git ${args[0]}`, ctx.exec(["git", ...args], { cwd: root }))).stdout.trim();
  const exists = (ref: string) => refExists(ctx, root, ref);

  const tip = agentRef(remote, task);
  const own = githubRef(`agent/${task}`);
  const limit = limitRef(remote, base);
  if (!(await exists(limit))) {
    throw new ForgeError(base.kind === "task"
      ? `agent/${task}: its base agent/${base.task} is gone from the team mirror`
      : `agent/${task}: its base ${base.branch} is gone from GitHub`);
  }
  const shipped = await exists(own);
  const upstream = shipped ? own : limit;

  // git cherry skips merge commits, so they are looked for on their own.
  const merges = await git("rev-list", "--merges", tip, `^${upstream}`, `^${limit}`);
  if (merges) throw new ForgeError(`agent/${task} has a merge commit (${merges.split("\n")[0].slice(0, 12)}): rebase it, forge ship replays commits one by one`);

  // "+" lines: the commits that have no equivalent patch upstream yet.
  const cherry = await git("cherry", upstream, tip, limit);
  const commits = cherry.split("\n").filter((l) => l.startsWith("+ ")).map((l) => l.slice(2));

  const prBase = prBaseFor(base, below);
  let onto: string;
  if (base.kind === "task") {
    onto = shipped ? own : githubRef(prBase);
  } else {
    // The first ship signs in place (same parents, same content) onto the
    // merge base, unless cherry dropped a commit whose patch is already
    // upstream: replaying the others without it could conflict for no reason,
    // so they go onto the branch itself.
    const dropped = cherry.split("\n").some((l) => l.startsWith("- "));
    onto = shipped ? own : dropped ? limit : await git("merge-base", limit, tip);
  }
  return { task, tip, limit, commits, onto, prBase, shipped };
}

// How many commits of a merged task GitHub has no patch-equivalent of: on its
// own branch while it is there, else on the branch its PR went into. null when
// that cannot be told (a branch gone). A PR squash-merged from several commits
// and its branch deleted counts them all: the squash matches none of them.
export async function notShipped(
  ctx: Context, root: string, remote: string, task: string, base: Base,
  below?: { prBase: string; merged: boolean },
): Promise<number | null> {
  const own = githubRef(`agent/${task}`);
  const upstream = (await refExists(ctx, root, own)) ? own : githubRef(prBaseFor(base, below));
  const limit = limitRef(remote, base);
  if (!(await refExists(ctx, root, upstream)) || !(await refExists(ctx, root, limit))) return null;
  const r = await ctx.exec(["git", "cherry", upstream, agentRef(remote, task), limit], { cwd: root });
  return r.code === 0 ? r.stdout.split("\n").filter((l) => l.startsWith("+ ")).length : null;
}

// show-ref --verify takes the exact ref only: rev-parse --verify would, for a
// missing refs/remotes/origin/agent/<t>, answer with a tag of that name.
export async function refExists(ctx: Context, root: string, ref: string): Promise<boolean> {
  return (await resolveRef(ctx, root, ref)) !== null;
}

// The commit a full ref name points at, or null when that very ref is missing.
export async function resolveRef(ctx: Context, root: string, ref: string): Promise<string | null> {
  const r = await ctx.exec(["git", "show-ref", "--verify", "--hash", ref], { cwd: root });
  return r.code === 0 ? r.stdout.trim() : null;
}

// A short name for messages: refs/remotes/origin/main reads origin/main.
export const shortRef = (ref: string): string =>
  /^[0-9a-f]{40,64}$/.test(ref) ? ref.slice(0, 12) : ref.replace(/^refs\/remotes\//, "");
