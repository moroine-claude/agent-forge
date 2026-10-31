// forge ship <task>: in the developer's clone, re-sign the agent's commits not
// yet on GitHub, push agent/<task> as a fast-forward and open or find its PR.
// A stacked task ships with the whole chain under it, bottom first.
import { ForgeError, mustSucceed, type Context } from "../context.ts";
import { fetchAgents } from "./fetch.ts";
import { ensurePr, prState, requireGh } from "../laptop/pr.ts";
import { replayAndPush } from "../laptop/replay.ts";
import {
  chainFor, notShipped, planTask, prBaseFor, resolveBase, type Base, type TaskPlan,
} from "../laptop/ship-plan.ts";

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
    // A merged task under the requested one is done: the task above goes onto
    // its PR's base. Commits it still has are left for `forge ship <t>`.
    if (t !== wanted && merged) {
      const left = await notShipped(ctx, root, container, t, base, below);
      ctx.out(left ? `agent/${t}: merged, skipped (${commits(left)} not shipped: forge ship ${t})` : `agent/${t}: merged, skipped`);
      below = { prBase: prBaseFor(base, below), merged: true };
      continue;
    }
    // Only the bottom of a chain has a branch base.
    if (base.kind === "branch" && base.assumed) await confirmMain(ctx, t, recorded.get(t));
    const plan = await planTask(ctx, root, container, t, base, below);
    if (t !== wanted && plan.commits.length === 0 && !plan.shipped) {
      throw new ForgeError(`agent/${t} has no commits of its own and no branch on GitHub, so agent/${chain[i + 1]} has nothing to go onto: nothing shipped`);
    }
    // A merged PR stays merged: commits pushed now make a second PR. After a
    // squash merge of several commits they may well be the merged ones again.
    if (merged && plan.commits.length > 0) await confirmNewPr(ctx, t, pr.mergedUrl!, plan.commits.length);
    plans.push({ plan, merged });
    below = { prBase: plan.prBase, merged: false };
  }
  await confirmSigning(ctx, root, plans.map(({ plan }) => plan));

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
      // --no-prune-tags: the developer's fetch.prune and fetch.pruneTags would
      // otherwise delete their own tags here.
      if (pushed) {
        ctx.out(`Fetching ${branch} from origin…`);
        await mustSucceed(`git fetch origin ${branch}`, ctx.exec(
          ["git", "fetch", "--no-prune-tags", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { cwd: root }));
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

// Every commit about to be signed is listed, per task and oldest first, then
// one question for the whole chain: ship fetches again, and the agent may have
// committed since the developer's review. Nothing to sign: no question. No
// terminal to ask: nothing is signed.
async function confirmSigning(ctx: Context, root: string, plans: TaskPlan[]): Promise<void> {
  const signing = plans.filter((plan) => plan.commits.length > 0);
  if (signing.length === 0) return;
  for (const plan of signing) {
    // Full SHAs: git takes them as object names, never as ref names.
    const log = await mustSucceed("git log",
      ctx.exec(["git", "log", "--no-walk=unsorted", "--format=%h %s", ...plan.commits], { cwd: root }));
    ctx.out(`agent/${plan.task}:`);
    for (const line of log.stdout.split("\n").filter(Boolean)) ctx.out(`  ${line}`);
  }
  // pick numbers its answers from 1.
  if ((await ctx.prompt.pick("Sign and push them?", ["yes", "no"])) !== 1) {
    throw new ForgeError("nothing shipped: signing was not confirmed");
  }
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

async function confirmNewPr(ctx: Context, task: string, url: string, n: number): Promise<void> {
  const yes = await ctx.prompt.pick(`agent/${task}'s PR ${url} is merged: push ${commits(n)} as a new PR?`, ["yes", "no"]);
  if (yes !== 1) throw new ForgeError(`nothing shipped: agent/${task}'s PR is merged, and a new one was not confirmed`);
}
