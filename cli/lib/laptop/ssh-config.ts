// Forge's own SSH block on the laptop, kept in <sshDir>/config.d/agent-forge.config
// so that ~/.ssh/config itself gains at most one `Include` line, and none when
// an Include of the developer's (`config.d/*.config`, say) already reads it.
import {
  chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Context } from "../context.ts";
import { forgeHome, sshDir } from "../paths.ts";
import type { LaptopHost } from "./state.ts";

const HEADER = "# Managed by forge install: edits are overwritten.";
const FILE = "agent-forge.config";
// The name earlier versions of forge install wrote.
const OLD_FILE = "agent-forge";
// The line `install` offers to add at the top of ~/.ssh/config.
export const INCLUDE_LINE = `Include config.d/${FILE}`;

export function forgeSshConfigPath(): string {
  return join(sshDir(), "config.d", FILE);
}

// ssh splits a config line, and a `-o` value, on whitespace, honouring its own
// quotes: a value with a space or a quote is double-quoted, `"` and `\`
// escaped inside; plain values stay bare.
function value(v: string): string {
  return /[\s"'\\]/.test(v) ? `"${v.replace(/["\\]/g, "\\$&")}"` : v;
}

// One `-o` option for ssh's argv. Where a shell (or Ansible's shlex) splits it
// first, it is shell-quoted on top.
export function sshOption(name: string, v: string): string {
  return `${name}=${value(v)}`;
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

// Atomic write: temp file next to the target, then rename; 0600 file in 0700
// directories. The temp file is a dotfile, which `Include config.d/*` skips.
export function writeForgeSshConfig(text: string): void {
  const path = forgeSshConfigPath();
  for (const dir of [sshDir(), join(sshDir(), "config.d")]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const tmp = join(sshDir(), "config.d", ".agent-forge.forge-tmp");
  writeFileSync(tmp, text, { mode: 0o600 });
  chmodSync(tmp, 0o600); // the umask may have narrowed the mode above
  renameSync(tmp, path);
  removeOldFile();
}

// config.d/agent-forge, which earlier versions wrote, goes only when forge
// wrote it (its first line is forge's header): any other file, link or
// directory of that name is the developer's.
function removeOldFile(): void {
  const old = join(sshDir(), "config.d", OLD_FILE);
  let text: string;
  try {
    if (!lstatSync(old).isFile()) return;
    text = readFileSync(old, "utf8");
  } catch {
    return;
  }
  if (text.split("\n", 1)[0].trimEnd() === HEADER) unlinkSync(old);
}

// True when forge's own file exists and defines `Host <name>`.
export function forgeSshConfigDefines(name: string): boolean {
  let text: string;
  try {
    text = readFileSync(forgeSshConfigPath(), "utf8");
  } catch {
    return false;
  }
  return text.split("\n").some((l) => {
    const m = /^\s*host(?:\s*=\s*|\s+)(.*)$/i.exec(l);
    return m !== null && m[1].split(/\s+/).includes(name);
  });
}

// The words of a config line's arguments, as ssh splits them (argv_split in
// OpenSSH's misc.c): blanks separate; single or double quotes group; a
// backslash escapes a quote, a backslash or, outside quotes, a blank (any
// other backslash stays, for glob to read); an unquoted # starting a word
// ends the line.
function sshWords(s: string): string[] {
  const words: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === " " || s[i] === "\t") { i++; continue; }
    if (s[i] === "#") break;
    let word = "";
    let quote = "";
    for (; i < s.length; i++) {
      const c = s[i];
      const n = s[i + 1];
      if (c === "\\" && (n === "'" || n === '"' || n === "\\" || (quote === "" && n === " "))) word += s[++i];
      else if (quote === "" && (c === " " || c === "\t")) break;
      else if (quote === "" && (c === '"' || c === "'")) quote = c;
      else if (quote !== "" && c === quote) quote = "";
      else word += c;
    }
    words.push(word);
  }
  return words;
}

// Where ssh looks for an Include argument of the user's config: `~/` is the
// home (`~/.ssh/`, forge's SSH directory), and a relative path is relative to
// ~/.ssh.
function includePath(arg: string): string {
  if (arg.startsWith("~/.ssh/")) return join(sshDir(), arg.slice("~/.ssh/".length));
  if (arg.startsWith("~/")) return join(forgeHome(), arg.slice(2));
  return arg.startsWith("/") ? arg : join(sshDir(), arg);
}

const regexChar = (c: string): string => c.replace(/[\\^$.*+?()[\]{}|\/-]/g, "\\$&");

// One path component of a glob(3) pattern as a regular expression: `*`, `?`,
// `[...]` (`[!...]` negated, ranges), a backslash escaping the next character.
// An unclosed `[` is a plain character. Null when it cannot match anything.
function componentRegex(p: string): RegExp | null {
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "\\" && i + 1 < p.length) re += regexChar(p[++i]);
    else if (c === "*") re += ".*";
    else if (c === "?") re += ".";
    else if (c === "[") {
      let j = i + 1;
      const negate = p[j] === "!" || p[j] === "^";
      if (negate) j++;
      let set = "";
      for (let first = true; j < p.length && (p[j] !== "]" || first); first = false) {
        let a = p[j];
        if (a === "\\" && j + 1 < p.length) a = p[++j];
        if (p[j + 1] === "-" && j + 2 < p.length && p[j + 2] !== "]") {
          let b = p[j + 2];
          j += 2;
          if (b === "\\" && j + 1 < p.length) b = p[++j];
          set += `${regexChar(a)}-${regexChar(b)}`;
        } else {
          set += regexChar(a);
        }
        j++;
      }
      if (j >= p.length) { re += "\\["; continue; }
      re += `[${negate ? "^" : ""}${set}]`;
      i = j;
    } else re += regexChar(c);
  }
  try {
    return new RegExp(`^${re}$`, "s");
  } catch {
    return null; // a range out of order
  }
}

// Does glob(3) return `path` for `pattern`? Component by component, a
// wildcard never crossing a `/` nor matching a leading dot.
function globMatches(pattern: string, path: string): boolean {
  const ps = pattern.split("/");
  const names = path.split("/");
  if (ps.length !== names.length) return false;
  return ps.every((p, i) => {
    if (names[i].startsWith(".") && !p.startsWith(".")) return false;
    return componentRegex(p)?.test(names[i]) ?? false;
  });
}

// Does ~/.ssh/config already read forge's file for every host? An Include
// whose pattern matches it, at the top level (before any Host or Match line),
// under `Match all`, or under a `Host *` with no negated pattern: an Include
// under any other Host or Match line applies to those hosts only.
export function includeState(configText: string): "covered" | "missing" {
  const file = forgeSshConfigPath();
  let everyHost = true;
  for (const raw of configText.split("\n")) {
    // A keyword, then blanks or `=`; a blank line or a comment has no match.
    const m = /^\s*([A-Za-z]+)(?:\s*=\s*|\s+)(.*)$/.exec(raw.trimEnd());
    if (!m) continue;
    const keyword = m[1].toLowerCase();
    const words = sshWords(m[2]);
    if (keyword === "host") everyHost = words.includes("*") && !words.some((w) => w.startsWith("!"));
    else if (keyword === "match") everyHost = words.length === 1 && words[0].toLowerCase() === "all";
    else if (keyword === "include" && everyHost && words.some((w) => globMatches(includePath(w), file))) {
      return "covered";
    }
  }
  return "missing";
}

// The Include goes at the very top (below a Host line it would only apply to
// that host); every byte of the input follows unchanged.
export function addInclude(configText: string): string {
  return configText === "" ? `${INCLUDE_LINE}\n` : `${INCLUDE_LINE}\n\n${configText}`;
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
