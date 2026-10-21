// Commands run on the forge host from the laptop, over the SSH alias forge
// wrote in ~/.ssh/config.d/agent-forge.
import type { Context, ExecResult } from "../context.ts";
import { shellQuote } from "../shell.ts";
import type { LaptopHost } from "./state.ts";

// ssh joins its arguments with spaces and hands them to the remote shell: each
// word is quoted so it arrives as one.
const remoteCommand = (argv: string[]): string => argv.map(shellQuote).join(" ");

// Never prompts (BatchMode): a missing key fails instead of hanging.
export function remoteExec(ctx: Context, host: LaptopHost, argv: string[]): Promise<ExecResult> {
  return ctx.exec(["ssh", "-o", "BatchMode=yes", host.name, "--", remoteCommand(argv)]);
}

// Inherits the terminal; `tty` for a command that asks the user something.
export function remoteAttach(ctx: Context, host: LaptopHost, argv: string[], tty = false): Promise<number> {
  return ctx.attach(["ssh", ...(tty ? ["-t"] : []), host.name, "--", remoteCommand(argv)]);
}
