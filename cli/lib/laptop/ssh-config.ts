// Forge's own SSH block on the laptop, kept in <sshDir>/config.d/agent-forge so
// that ~/.ssh/config itself only ever gains one `Include` line.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "../context.ts";
import { sshDir } from "../paths.ts";
import type { LaptopHost } from "./state.ts";

const HEADER = "# Managed by forge install: edits are overwritten.";

function forgeFile(): string {
  return join(sshDir(), "config.d", "agent-forge");
}

// ssh_config quotes a value that holds a space; plain values stay bare.
function value(v: string): string {
  return /\s/.test(v) ? `"${v}"` : v;
}

export function renderForgeSshConfig(
  hosts: LaptopHost[],
  o: { knownHosts: string; keyPath: (name: string) => string },
): string {
  const blocks = hosts.map((h) => {
    const lines = [
      `Host ${h.name}`,
      `  HostName ${h.address}`,
      `  Port ${h.port}`,
      `  User ${h.user}`,
    ];
    // Lima's port and host key change when the VM is recreated: pin the key
    // under a stable alias and accept the first one.
    if (h.kind === "lima") lines.push(`  HostKeyAlias ${h.name}`, "  StrictHostKeyChecking accept-new");
    lines.push(
      `  UserKnownHostsFile ${value(o.knownHosts)}`,
      `  IdentityFile ${value(o.keyPath(h.name))}`,
      "  IdentitiesOnly yes",
    );
    if (h.identityAgent) lines.push(`  IdentityAgent ${value(h.identityAgent)}`);
    lines.push("  ForwardAgent yes");
    return lines.join("\n");
  });
  return [HEADER, ...blocks].join("\n\n") + "\n";
}

// Atomic write: temp file next to the target, then rename; 0600 file in 0700 directories.
export function writeForgeSshConfig(text: string): void {
  const path = forgeFile();
  for (const dir of [sshDir(), join(sshDir(), "config.d")]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmp = `${path}.forge-tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600); // the umask may have narrowed the mode above
  renameSync(tmp, path);
}

// True when forge's own file exists and defines `Host <name>`.
export function forgeSshConfigDefines(name: string): boolean {
  let text: string;
  try {
    text = readFileSync(forgeFile(), "utf8");
  } catch {
    return false;
  }
  return text.split("\n").some((l) => {
    const m = /^\s*host(?:\s*=\s*|\s+)(.*)$/i.exec(l);
    return m !== null && m[1].split(/\s+/).includes(name);
  });
}

// Is forge's file already pulled in by a top-level Include (one before any
// Host or Match line, where it applies to every host)?
export function includeState(configText: string): "covered" | "missing" {
  const wanted = new Set([
    "config.d/*", "config.d/agent-forge", "~/.ssh/config.d/*", "~/.ssh/config.d/agent-forge",
    join(sshDir(), "config.d", "*"), join(sshDir(), "config.d", "agent-forge"),
  ]);
  for (const raw of configText.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    if (/^(host|match)(\s|=|$)/i.test(line)) return "missing";
    const m = /^include(?:\s*=\s*|\s+)(.*)$/i.exec(line);
    if (!m) continue;
    const patterns = m[1].match(/"[^"]*"|\S+/g) ?? [];
    if (patterns.some((p) => wanted.has(p.replace(/^"|"$/g, "")))) return "covered";
  }
  return "missing";
}

// The Include goes at the very top (below a Host line it would only apply to
// that host); every byte of the input follows unchanged.
export function addInclude(configText: string): string {
  return configText === "" ? "Include config.d/*\n" : `Include config.d/*\n\n${configText}`;
}

// Before forge's block exists for `name`: does `ssh -G` already resolve it to
// another HostName? Then someone else's config defines that name.
export async function hostDefinedElsewhere(ctx: Context, name: string): Promise<boolean> {
  const r = await ctx.exec(["ssh", "-G", name]);
  if (r.code !== 0) return false;
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*hostname\s+(\S+)/i.exec(line);
    if (m) return m[1].toLowerCase() !== name.toLowerCase();
  }
  return false;
}
