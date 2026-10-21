// forge open (spec "forge open"): herdr on the selected forge host, through
// its SSH alias, with the server's keybindings.
import { ForgeError, type Context } from "../context.ts";
import { limaInstance } from "../laptop/lima.ts";
import { selectHost } from "../laptop/state.ts";

export async function cmdOpen(ctx: Context, opts: { host?: string } = {}): Promise<number> {
  const host = await selectHost(ctx, opts.host);
  if (host.kind === "lima") await startLimaVm(ctx, host.name);
  return ctx.attach(["herdr", "--remote", host.name, "--remote-keybindings", "server"]);
}

// After a laptop reboot the local VM is stopped: started here, in the
// terminal, rather than failing inside herdr.
async function startLimaVm(ctx: Context, name: string): Promise<void> {
  const vm = await limaInstance(ctx, name);
  if (!vm) {
    throw new ForgeError(`${name}'s Lima VM is gone: forge install offers to forget it and install a new one`);
  }
  if (vm.status !== "Stopped") return;
  const code = await ctx.attach(["limactl", "start", "--tty=false", name]);
  if (code !== 0) throw new ForgeError(`limactl start ${name} failed (exit code ${code})`);
}
