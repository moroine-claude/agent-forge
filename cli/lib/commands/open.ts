// forge open (spec "forge open"): herdr on the selected forge host, through
// its SSH alias, with the server's keybindings.
import type { Context } from "../context.ts";
import { selectHost } from "../laptop/state.ts";

export async function cmdOpen(ctx: Context, opts: { host?: string } = {}): Promise<number> {
  const host = await selectHost(ctx, opts.host);
  return ctx.attach(["herdr", "--remote", host.name, "--remote-keybindings", "server"]);
}
