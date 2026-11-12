import type { Context } from "./context.ts";
import { ForgeError } from "./context.ts";

// herdr-core (hc), pinned (DX 5 spec §5.6). The image's Ansible role pins the
// same version, `forge_image_hc_version` in
// ansible/roles/forge_image/defaults/main.yml: tests/hc.test.ts keeps the two
// equal. The Mac's check of its own hc is checkLocalHc.
export const HC_VERSION = "0.1.20";

// Herdr App's machines go through the Mac's own hc, and hc talks to a core of
// its own version: a different one is refused before a machine is added.
export async function checkLocalHc(ctx: Context): Promise<void> {
  const r = await ctx.exec(["hc", "--version"]);
  const found = r.code === 0 ? r.stdout.trim() : "";
  if (found.split(/\s+/).includes(HC_VERSION)) return;
  throw new ForgeError(
    `forge needs hc ${HC_VERSION} on this machine, ${found ? `found ${found}` : "found no hc"}. ` +
    `Install or update herdr-core to ${HC_VERSION} (https://herdr.dev: read its installer before running it), ` +
    "then run the command again.");
}
