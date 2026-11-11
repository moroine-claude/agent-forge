// A container stuck at its memory limit keeps thrashing without ever OOM-ing
// (#128): Incus answers, but every `incus exec` into it stays blocked in
// state D. forge start gives those calls a deadline, and on expiry says what
// the container's cgroup shows and how to get out.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context, ExecOptions, ExecResult } from "./context.ts";
import { ForgeError } from "./context.ts";
import { forgeProject } from "./incus.ts";

// Longer than any healthy step of forge start (a fetch from the host mirror, a
// worktree checkout), far shorter than the hours a thrashing container holds
// it for.
export const EXEC_DEADLINE_MS = 180_000;

// cgroup v2 root; the variable lets the tests point at a fake tree.
const cgroupRoot = () => process.env.FORGE_CGROUP_ROOT ?? "/sys/fs/cgroup";

// Incus names a container's cgroup after its project.
export const cgroupDir = (container: string): string =>
  join(cgroupRoot(), `lxc.payload.${forgeProject()}_${container}`);

function readKey(dir: string, file: string): string {
  try {
    return readFileSync(join(dir, file), "utf8").trim();
  } catch {
    return "unreadable";
  }
}

const mib = (bytes: string): string => /^\d+$/.test(bytes) ? `${Math.round(Number(bytes) / 1048576)} MiB` : bytes;

// What the cgroup says, read-only from the host. memory.max is "max" when the
// container has no limit.
export function memoryDiagnostic(container: string): string {
  const dir = cgroupDir(container);
  const pressure = readKey(dir, "memory.pressure").split("\n").map((l) => `  ${l}`).join("\n");
  return [
    `  memory.current ${mib(readKey(dir, "memory.current"))}`,
    `  memory.max     ${mib(readKey(dir, "memory.max"))}`,
    pressure,
  ].join("\n");
}

export function unresponsiveMessage(container: string, seconds: number): string {
  const dir = cgroupDir(container);
  return [
    `${container} does not answer: a command in it was stuck for ${seconds} s. Incus itself answers; the inside of the container does not.`,
    `${dir}:`,
    memoryDiagnostic(container),
    "A container at its memory limit with a high 'full' pressure is thrashing, without ever being killed.",
    "Either kill its biggest process from this host (the agent's processes are yours, with the idmap):",
    `  ps -o pid,rss,args --sort=-rss -p "$(find ${dir} -name cgroup.procs -exec cat {} + | paste -sd,)" | head`,
    "  kill <pid>",
    `or restart the container, knowing that the agent running in it is lost (/workspace and its commits stay):`,
    `  incus --project ${forgeProject()} restart --force ${container}`,
  ].join("\n");
}

// `incus exec <container>`, whatever the user or command after it.
const execsIn = (argv: string[], container: string): boolean =>
  argv[0] === "incus" && argv[1] === "--project" && argv[3] === "exec" && argv[4] === container;

// The context for the steps of forge start that run in `container`: a command
// executed there that outlasts the deadline is killed, and start fails with
// the diagnostic instead of waiting for it. Other calls pass through.
export function withExecDeadline(ctx: Context, container: string, deadlineMs = EXEC_DEADLINE_MS): Context {
  return {
    ...ctx,
    exec: async (argv: string[], opts: ExecOptions = {}): Promise<ExecResult> => {
      if (!execsIn(argv, container)) return ctx.exec(argv, opts);
      const r = await ctx.exec(argv, { timeoutMs: deadlineMs, ...opts });
      if (r.timedOut) throw new ForgeError(unresponsiveMessage(container, Math.round(deadlineMs / 1000)));
      return r;
    },
  };
}
