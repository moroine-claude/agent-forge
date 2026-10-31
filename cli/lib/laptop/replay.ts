// Replays a task's commits in a temporary worktree of the developer's clone,
// signs them with the developer's own git configuration, and pushes
// agent/<task> to GitHub. The developer's checkout is never touched, and the
// push never forces: if GitHub's branch moved, it is refused.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ForgeError, mustSucceed, type Context } from "../context.ts";
import type { TaskPlan } from "./ship-plan.ts";

export async function replayAndPush(
  ctx: Context, root: string, plan: TaskPlan, opts: { sign: boolean },
): Promise<"pushed" | "nothing"> {
  if (plan.commits.length === 0) return "nothing";

  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "forge-ship-")), "wt");
  try {
    await mustSucceed("git worktree add", ctx.exec(["git", "-C", root, "worktree", "add", "--detach", tmp, plan.onto]));

    // attach, not exec: a signing key may need a terminal pinentry or a touch
    // on a hardware key, which only an inherited terminal can show.
    // --allow-empty keeps an originally empty commit; a commit that becomes
    // empty on `onto` still stops like a conflict.
    const code = await ctx.attach(
      ["git", "-C", tmp, "cherry-pick", "--allow-empty", ...(opts.sign ? ["-S"] : []), ...plan.commits],
    );
    if (code !== 0) throw new ForgeError(await stoppedAt(ctx, tmp, plan));

    const push = await ctx.exec(["git", "-C", tmp, "push", "origin", `HEAD:refs/heads/agent/${plan.task}`]);
    if (push.code !== 0) {
      throw new ForgeError(/rejected|non-fast-forward|fetch first/.test(push.stderr)
        ? `GitHub's agent/${plan.task} moved since the fetch: run forge ship again.`
        : `git push failed: ${push.stderr.trim() || push.stdout.trim()}`);
    }
    return "pushed";
  } finally {
    // --force only discards the temporary worktree, which may be mid cherry-pick.
    await ctx.exec(["git", "-C", root, "worktree", "remove", "--force", tmp]);
    await ctx.exec(["git", "-C", root, "worktree", "prune"]);
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
  }
}

// Names the commit the cherry-pick stopped on, then abandons the pick.
async function stoppedAt(ctx: Context, tmp: string, plan: TaskPlan): Promise<string> {
  const head = await ctx.exec(["git", "-C", tmp, "rev-parse", "-q", "--verify", "CHERRY_PICK_HEAD"]);
  let what = "a commit";
  if (head.code === 0) {
    const sha = head.stdout.trim();
    const subject = await ctx.exec(["git", "-C", tmp, "log", "-1", "--format=%h %s", sha]);
    if (subject.code === 0) what = subject.stdout.trim();
  }
  await ctx.exec(["git", "-C", tmp, "cherry-pick", "--abort"]);
  return `agent/${plan.task}: replaying ${what} onto ${plan.onto} stopped (conflict, or the signing failed): nothing was pushed`;
}
