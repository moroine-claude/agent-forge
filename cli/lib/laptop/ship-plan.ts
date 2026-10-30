// The ship plan: from the recorded bases and the fetched refs of the
// developer's clone, which commits of a task to replay, onto what, and the base
// of its PR. Pure planning: nothing is signed or pushed here.
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
  if (recorded.startsWith("agent/")) {
    const task = recorded.slice("agent/".length);
    return tasks.has(task) ? { kind: "task", task } : MAIN;
  }
  return onGithub(recorded) ? { kind: "branch", branch: recorded, assumed: false } : MAIN;
}

// The tasks from the lowest of the stack up to `task`, bottom first.
export function chainFor(task: string, bases: Map<string, Base>): string[] {
  const chain = [task];
  for (let base = bases.get(task); base?.kind === "task"; base = bases.get(base.task)) {
    if (chain.includes(base.task)) {
      throw new ForgeError(`tasks ${[...chain, base.task].reverse().join(" -> ")} base on each other in a cycle`);
    }
    chain.push(base.task);
  }
  return chain.reverse();
}

export type TaskPlan = {
  task: string;
  tip: string;            // <container>/agent/<task>
  limit: string;          // what the task started from, as a ref name
  commits: string[];      // to replay, oldest first
  onto: string;           // a ref name; the merge-base SHA on the first ship of a branch-based task
  prBase: string;
  shipped: boolean;       // origin/agent/<task> exists
};

// `below`: the task this one is stacked on, once the caller knows its PR is
// merged; the task then goes onto that PR's base instead.
export async function planTask(
  ctx: Context, root: string, container: string, task: string, base: Base,
  below?: { prBase: string; merged: boolean },
): Promise<TaskPlan> {
  const git = async (...args: string[]) =>
    (await mustSucceed(`git ${args[0]}`, ctx.exec(["git", ...args], { cwd: root }))).stdout.trim();
  const exists = async (ref: string) =>
    (await ctx.exec(["git", "rev-parse", "-q", "--verify", `${ref}^{commit}`], { cwd: root })).code === 0;

  const tip = `${container}/agent/${task}`;
  const own = `origin/agent/${task}`;
  const limit = base.kind === "task" ? `${container}/agent/${base.task}` : `origin/${base.branch}`;
  const shipped = await exists(own);
  const upstream = shipped ? own : limit;

  // git cherry skips merge commits, so they are looked for on their own.
  const merges = await git("rev-list", "--merges", tip, `^${upstream}`, `^${limit}`);
  if (merges) throw new ForgeError(`agent/${task} has a merge commit (${merges.split("\n")[0].slice(0, 12)}): rebase it, forge ship replays commits one by one`);

  // "+" lines: the commits that have no equivalent patch upstream yet.
  const cherry = await git("cherry", upstream, tip, limit);
  const commits = cherry.split("\n").filter((l) => l.startsWith("+ ")).map((l) => l.slice(2));

  let onto: string;
  let prBase: string;
  if (base.kind === "task") {
    prBase = below?.merged ? below.prBase : `agent/${base.task}`;
    onto = shipped ? own : `origin/${prBase}`;
  } else {
    prBase = base.branch;
    // The first ship signs in place: same parents, same content.
    onto = shipped ? own : await git("merge-base", limit, tip);
  }
  return { task, tip, limit, commits, onto, prBase, shipped };
}
