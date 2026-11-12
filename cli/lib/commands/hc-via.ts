// forge hc-via <alias> <container> <line>   (on the Mac)
//
// What Herdr App's machine runs (`hc machine add --via`): hc hands it a shell
// line to run on the machine as its last argument, and the bytes go both ways
// untouched through ssh to `forge hc-exec` on the host. No secret passes here:
// the agent is not forwarded, and nothing is asked (BatchMode).
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";
import { remoteCommand } from "../laptop/remote.ts";
import { validateContainerName } from "../validate.ts";

// An ssh alias, not an option: it never starts with a dash.
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function cmdHcVia(ctx: Context, alias: string | undefined, container: string | undefined, line: string | undefined): Promise<number> {
  if (alias === undefined || !ALIAS.test(alias)) throw new ForgeError("Usage: forge hc-via <host alias> <container> <line>");
  validateContainerName(container ?? "");
  if (line === undefined || line === "") throw new ForgeError("Usage: forge hc-via <host alias> <container> <line>");
  return ctx.attach(["ssh", "-T", "-o", "BatchMode=yes", "-o", "ForwardAgent=no", alias, "--",
    remoteCommand(["forge", "hc-exec", container as string, line])]);
}
