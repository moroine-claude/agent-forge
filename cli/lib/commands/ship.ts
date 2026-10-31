// forge ship <task>: in the developer's clone, re-sign the agent's commits not
// yet on GitHub, push agent/<task> as a fast-forward and open or find its PR.
// A stacked task ships with the whole chain under it, bottom first.
import { ForgeError, mustSucceed, type Context } from "../context.ts";
import { fetchAgents } from "./fetch.ts";
import { ensurePr, prState, requireGh } from "../laptop/pr.ts";
import { replayAndPush } from "../laptop/replay.ts";
import { chainFor, planTask, prBaseFor, resolveBase, type Base, type TaskPlan } from "../laptop/ship-plan.ts";

const USAGE = "Usage: forge ship <task> [--host <name>]";

const commits = (n: number) => `${n} commit${n === 1 ? "" : "s"}`;

export async function cmdShip(
  ctx: Context, task: string | undefined, opts: { host?: string; cwd?: string; sign?: boolean } = {},
): Promise<number> {
  const sign = opts.sign ?? true;
  await requireGh(ctx, opts.cwd ?? process.cwd());
  const { root, ownerRepo, container, bases: recorded } = await fetchAgents(ctx, { host: opts.host, cwd: opts.cwd });
  const git = async (...args: string[]) =>
    (await mustSucceed(`git ${args[0]}`, ctx.exec(["git", ...args], { cwd: root }))).stdout;
  const names = async (prefix: string) =>
    (await git("for-each-ref", "--format=%(refname)", prefix)).split("\n").filter(Boolean).map((r) => r.slice(prefix.length));

  const tasks = await names(`refs/remotes/${container}/agent/`);
  const wanted = await pickTask(ctx, tasks, task);

  // A recorded base names a branch on GitHub when the fetch brought it as
  // origin/<b>; origin/HEAD only points at one.
  const github = new Set((await names("refs/remotes/origin/")).filter((b) => b !== "HEAD"));
  const known = new Set(tasks);
  const bases = new Map<string, Base>(tasks.map((t) => [t, resolveBase(recorded.get(t), known, (b) => github.has(b))]));
  const chain = chainFor(wanted, bases);

  // The whole chain is planned before anything is signed: questions and
  // refusals come first, and the number of commits to sign is known.
  const plans: { plan: TaskPlan; merged: boolean }[] = [];
  let below: { prBase: string; merged: boolean } | undefined;
  for (const [i, t] of chain.entries()) {
    const base = bases.get(t)!;
    const pr = await prState(ctx, root, ownerRepo, `agent/${t}`);
    const merged = pr.merged && pr.open === undefined;
    // A merged task under the requested one is done: the task above goes onto its PR's base.
    if (t !== wanted && merged) {
      ctx.out(`agent/${t}: merged, skipped`);
      below = { prBase: prBaseFor(base, below), merged: true };
      continue;
    }
    // Only the bottom of a chain has a branch base.
    if (base.kind === "branch" && base.assumed) await confirmMain(ctx, t, recorded.get(t));
    const plan = await planTask(ctx, root, container, t, base, below);
    if (t !== wanted && plan.commits.length === 0 && !plan.shipped) {
      throw new ForgeError(`agent/${t} has no commits of its own and no branch on GitHub, so agent/${chain[i + 1]} has nothing to go onto: nothing shipped`);
    }
    plans.push({ plan, merged });
    below = { prBase: plan.prBase, merged: false };
  }

  const signing = plans.filter(({ plan }) => plan.commits.length > 0);
  const total = signing.reduce((n, { plan }) => n + plan.commits.length, 0);
  ctx.out(total === 0
    ? "Nothing new to sign."
    : `Signing ${commits(total)}: ${signing.map(({ plan }) => `${plan.task} (${plan.commits.length})`).join(", ")}`);

  // Bottom first: each task goes onto the GitHub branch the one below just got.
  // A failure stops here; the lines printed so far say what was shipped.
  for (const { plan, merged } of plans) {
    const branch = `agent/${plan.task}`;
    // Only the requested task can get here with nothing to push and no GitHub
    // branch: the planning stopped on any task below like that.
    if (plan.commits.length === 0 && !plan.shipped) { ctx.out(`${branch}: nothing to ship`); continue; }
    const pushed = (await replayAndPush(ctx, root, plan, { sign })) === "pushed";
    const what = pushed ? `pushed ${commits(plan.commits.length)}` : "nothing new";
    // Without new commits, a merged PR stays merged: no second PR for the same work.
    if (!pushed && merged) { ctx.out(`${branch}: nothing new, PR merged`); continue; }
    try {
      // The explicit refspec creates origin/agent/<t> even with a narrower
      // fetch refspec: the next task's onto and the PR's description read it.
      if (pushed) {
        await mustSucceed(`git fetch origin ${branch}`,
          ctx.exec(["git", "fetch", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: root }));
      }
      const pr = await ensurePr(ctx, root, ownerRepo, branch, plan.prBase);
      ctx.out(`${branch}: ${what}, ${pr.created ? "created" : "existing"} PR ${pr.url}`);
    } catch (e) {
      if (pushed) ctx.out(`${branch}: ${what}, no PR yet`);
      throw e;
    }
  }
  return 0;
}

async function pickTask(ctx: Context, tasks: string[], task: string | undefined): Promise<string> {
  if (tasks.length === 0) throw new ForgeError("no agent branches yet");
  if (task === undefined) {
    const i = await ctx.prompt.pick("Task", tasks);
    if (i === null) throw new ForgeError(USAGE);
    return tasks[i - 1];
  }
  // agent/<t> as printed by fetch and ship: task names never hold a slash.
  const name = task.replace(/^agent\//, "");
  if (!tasks.includes(name)) throw new ForgeError(`unknown task ${task}: the agents' tasks are ${tasks.join(", ")}`);
  return name;
}

// main as the PR base of a task whose recorded base cannot be one, after a yes
// (pick numbers its answers from 1).
async function confirmMain(ctx: Context, task: string, recorded: string | undefined): Promise<void> {
  const why = recorded ? `started from ${recorded}, not a branch on GitHub` : "has no recorded base";
  const yes = await ctx.prompt.pick(`agent/${task} ${why}: open its PR against main?`, ["yes", "no"]);
  if (yes !== 1) throw new ForgeError(`nothing shipped: main was not confirmed as agent/${task}'s PR base`);
}
