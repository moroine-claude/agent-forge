// Replays a task's commits in a temporary worktree of the developer's clone,
// signs them with the developer's own git configuration, and pushes
// agent/<task> to GitHub. The developer's checkout is never touched, and the
// push never forces: if GitHub's branch moved, it is refused.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ForgeError, mustSucceed, type Context } from "../context.ts";
import { shortRef, type TaskPlan } from "./ship-plan.ts";

// No hook runs in or around the temporary worktree: its tree is the agent's.
// A relative core.hooksPath (.githooks, husky's .husky/_) resolves inside it,
// a hook manager in .git/hooks (lefthook, pre-commit) runs what that tree
// configures, and a pre-push running the tests runs the agent's code. So every
// git command here runs without hooks, which also skips git-lfs's pre-push:
// the LFS write path is designed separately.
const gitIn = (dir: string, ...args: string[]): string[] => ["git", "-C", dir, "-c", "core.hooksPath=/dev/null", ...args];

export async function replayAndPush(
  ctx: Context, root: string, plan: TaskPlan, opts: { sign: boolean },
): Promise<"pushed" | "nothing"> {
  if (plan.commits.length === 0) return "nothing";

  // onto is a merge-base SHA or a full ref name, the latter read exactly: a
  // missing ref (origin/agent/<below> not fetched, a base gone) must not fall
  // back to a tag of that name.
  let start = plan.onto;
  if (!/^[0-9a-f]{40,64}$/.test(start)) {
    const r = await ctx.exec(gitIn(root, "show-ref", "--verify", "--hash", plan.onto));
    if (r.code !== 0) throw new ForgeError(`agent/${plan.task}: ${shortRef(plan.onto)} is not in this clone: nothing was pushed`);
    start = r.stdout.trim();
  }

  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "forge-ship-")), "wt");
  // Ctrl-C is the natural way out of a signing prompt (a terminal pinentry, a
  // touch on a hardware key) and of an SSH key's touch at the push: a no-op
  // handler keeps node alive, so the signal still reaches git and ssh (same
  // process group), which exit non-zero, and the abort and cleanup below run
  // instead of leaking the worktree.
  const ignoreSigint = () => {};
  process.on("SIGINT", ignoreSigint);
  try {
    await mustSucceed("git worktree add", ctx.exec(gitIn(root, "worktree", "add", "--detach", tmp, start)));

    // attach, not exec: a signing key may need a terminal pinentry or a touch
    // on a hardware key, which only an inherited terminal can show.
    // --allow-empty keeps an originally empty commit; a commit that becomes
    // empty on `onto` still stops like a conflict.
    // The advice texts tell how to continue a pick in a worktree about to be deleted.
    const code = await ctx.attach(gitIn(tmp,
      "-c", "advice.mergeConflict=false", "-c", "advice.resolveConflict=false",
      "cherry-pick", "--allow-empty", ...(opts.sign ? ["-S"] : []), ...plan.commits,
    ));
    if (code !== 0) throw new ForgeError(await stoppedAt(ctx, tmp, plan));

    // The push's output is captured to read a rejection: an SSH key's touch
    // prompt would go unseen, so this line says what is waiting.
    ctx.out(`Pushing agent/${plan.task}…`);
    const push = await ctx.exec(gitIn(tmp, "push", "origin", `HEAD:refs/heads/agent/${plan.task}`));
    if (push.code !== 0) {
      throw new ForgeError(/\[rejected\][^\n]*\((fetch first|non-fast-forward)\)/.test(push.stderr)
        ? `GitHub's agent/${plan.task} moved since the fetch: run forge ship again.`
        : `git push failed: ${push.stderr.trim() || push.stdout.trim()}`);
    }
    return "pushed";
  } finally {
    // --force only discards the temporary worktree, which may be mid cherry-pick.
    const removed = await ctx.exec(gitIn(root, "worktree", "remove", "--force", tmp));
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    // Never a repository-wide prune: it would also drop the developer's other worktrees.
    if (removed.code !== 0) await ctx.exec(gitIn(root, "worktree", "remove", "--force", tmp));
    process.off("SIGINT", ignoreSigint);
  }
}

// Names the commit the cherry-pick stopped on, then abandons the pick. Without
// a CHERRY_PICK_HEAD (a signing failure), rev-parse could find a tag of that
// name: only one of the commits being replayed is named.
async function stoppedAt(ctx: Context, tmp: string, plan: TaskPlan): Promise<string> {
  const head = await ctx.exec(gitIn(tmp, "rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"));
  let what = "a commit";
  if (head.code === 0 && plan.commits.includes(head.stdout.trim())) {
    const sha = head.stdout.trim();
    const subject = await ctx.exec(gitIn(tmp, "log", "-1", "--format=%h %s", sha));
    if (subject.code === 0) what = subject.stdout.trim();
  }
  await ctx.exec(gitIn(tmp, "cherry-pick", "--abort"));
  return `agent/${plan.task}: replaying ${what} onto ${shortRef(plan.onto)} stopped (conflict, or the signing failed): nothing was pushed`;
}
