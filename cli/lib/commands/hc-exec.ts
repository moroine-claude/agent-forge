// forge hc-exec <container> <line>   (on the host)
//
// The host end of Herdr App's transport: runs hc's own shell line in a member's
// container, as aiuser. The line comes from the human's hc client, through the
// human's SSH session: never from an agent. Only containers the host's config
// declares are served: no other container of the host, and no name that is not
// one, reaches `incus exec`.
import type { Context } from "../context.ts";
import { ForgeError } from "../context.ts";
import { loadConfig } from "../config.ts";
import { incus } from "../incus.ts";
import { configPath } from "../paths.ts";
import { memberNamed } from "../team.ts";
import { validateContainerName } from "../validate.ts";

export async function cmdHcExec(ctx: Context, container: string | undefined, line: string | undefined): Promise<number> {
  validateContainerName(container ?? "");
  if (line === undefined || line === "") throw new ForgeError("Usage: forge hc-exec <container> <line>");
  memberNamed(loadConfig(configPath()), container as string);
  return ctx.attach(incus("exec", "-T", container as string, "--", "su", "-", "aiuser", "-c", line));
}
