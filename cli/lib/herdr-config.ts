// The herdr key bindings forge installs (spec "forge setup: the herdr config
// block"). herdr has no include mechanism, so `forge setup` owns a delimited,
// idempotent block in the forge user's herdr config. The block is always kept
// LAST in the file: a bare TOML key written after it would land in its last
// [[keys.command]] table (herdr 0.9.5: "unknown config key keys.command.0.bogus").
// On the laptop, `forge install` owns another block, with its own markers:
// herdr's toasts (the laptop block, below).
import {
  chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ForgeError, type Context } from "./context.ts";
import { forgeCommand, forgeHome, herdrConfigPath } from "./paths.ts";
import { shellQuote } from "./shell.ts";

export const BLOCK_START = "# >>> agent-forge >>>";
export const BLOCK_END = "# <<< agent-forge <<<";

// A block's markers, and its name in error messages.
type Markers = { start: string; end: string; name: string };
const HOST_MARKERS: Markers = { start: BLOCK_START, end: BLOCK_END, name: "agent-forge block" };
export const LAPTOP_MARKERS: Markers = {
  start: "# >>> agent-forge laptop >>>", end: "# <<< agent-forge laptop <<<", name: "agent-forge laptop block",
};

// The two keys forge binds.
const KEYS = ["prefix+f", "prefix+shift+f"];

// A TOML basic string: only backslash and double quote need escaping for a
// path we accept; a control character cannot be represented, so it is refused.
function tomlString(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) throw new ForgeError(`${value}: a control character cannot go in the herdr config`);
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function binding(key: string, command: string, description: string): string[] {
  return [
    "[[keys.command]]",
    `key = "${key}"`,
    'type = "popup"',
    `command = ${tomlString(command)}`,
    `description = "${description}"`,
    'width = "90%"',
    'height = "90%"',
  ];
}

// The block, with \n line endings, ending with a newline.
export function renderBlock(forge: string): string {
  const q = shellQuote(forge);
  return [
    BLOCK_START,
    "# Managed by `forge setup`: edits inside this block are overwritten.",
    "# Keep your own settings above it.",
    ...binding("prefix+f", `${q} start`, "forge: start or open a task"),
    "",
    ...binding("prefix+shift+f", `${q} resume --all`, "forge: resume agents stopped by a herdr restart"),
    BLOCK_END,
    "",
  ].join("\n");
}

type Line = { start: number; end: number; text: string };

// Lines with their byte offsets; `end` includes the line terminator, `text`
// excludes \n and a trailing \r (so CRLF markers are still found).
function lines(text: string): Line[] {
  const out: Line[] = [];
  let start = 0;
  while (start < text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl + 1;
    out.push({ start, end, text: text.slice(start, nl === -1 ? end : nl).replace(/\r$/, "") });
    start = end;
  }
  return out;
}

// Locates the block: [from, to) covers the start-marker line through the
// end-marker line, terminator included. Null when there is none. A marker may
// be followed by blanks (an editor's leftovers); a second marker of either
// kind is refused rather than guessed around.
function findBlock(text: string, m: Markers = HOST_MARKERS): { from: number; to: number } | null {
  const ls = lines(text);
  const starts = ls.filter((l) => l.text.trimEnd() === m.start);
  const ends = ls.filter((l) => l.text.trimEnd() === m.end);
  if (starts.length > 1) throw new Error(`more than one ${m.name}: remove the extra ones by hand`);
  if (ends.length > 1) {
    throw new Error(`more than one "${m.end}" in the ${m.name}: remove the extra ones by hand`);
  }
  if (starts.length === 0 && ends.length === 0) return null;
  if (starts.length === 0) throw new Error(`found "${m.end}" without a start marker in the ${m.name}`);
  if (ends.length === 0 || ends[ends.length - 1].start < starts[0].start) {
    throw new Error(`found "${m.start}" without an end marker in the ${m.name}`);
  }
  const end = ends.find((l) => l.start > starts[0].start)!;
  return { from: starts[0].start, to: end.end };
}

// forge setup's block by default; the laptop block with LAPTOP_MARKERS.
export function spliceBlock(
  text: string, block: string, markers: Markers = HOST_MARKERS,
): { text: string; outcome: "created" | "updated" | "unchanged" } {
  const found = findBlock(text, markers);
  if (!found) {
    if (text === "") return { text: block, outcome: "created" };
    const sep = (text.endsWith("\n") ? "" : "\n") + "\n";
    return { text: text + sep + block, outcome: "created" };
  }
  const existing = text.slice(found.from, found.to);
  // The block may have lost its final newline (end marker at end of file).
  const normalised = existing.replaceAll("\r\n", "\n");
  if (normalised === block || normalised + "\n" === block) return { text, outcome: "unchanged" };
  return { text: text.slice(0, found.from) + block + text.slice(found.to), outcome: "updated" };
}

// Keys forge binds that the user also binds outside the block. A TOML key
// value may be a basic or a literal string, and be followed by a comment.
export function conflictingKeys(text: string): string[] {
  const found = findBlock(text);
  const outside = found ? text.slice(0, found.from) + text.slice(found.to) : text;
  const keys = new Set<string>();
  for (const l of lines(outside)) {
    const m = /^\s*key\s*=\s*(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/.exec(l.text);
    const key = m ? (m[1] ?? m[2]) : undefined;
    if (key !== undefined && KEYS.includes(key)) keys.add(key);
  }
  return [...keys];
}

// The laptop block: herdr draws a notification, the start popup's warnings
// among them, only if the attached client's config turns toasts on (herdr
// 0.9.5 ships with them off; spec, sub-project 1, Finding). Appended at the
// end like forge setup's block: a bare key written after it would land in
// its [ui.toast] table.
export function renderLaptopBlock(): string {
  return [
    LAPTOP_MARKERS.start,
    "# Added by `forge install`: herdr draws its notifications, among them the",
    "# warnings of forge's start popup. Remove this block to turn them off again.",
    "# Keep your own settings above it.",
    "[ui.toast]",
    'delivery = "herdr"',
    LAPTOP_MARKERS.end,
    "",
  ].join("\n");
}

// A TOML key or header name without its quotes or the blanks around dots:
// `["ui" . 'toast']` and `ui.toast` name the same table.
function bareName(name: string): string {
  return name.replaceAll(/["']/g, "").replaceAll(/\s*\.\s*/g, ".").trim();
}

// True when the user's own settings, outside forge's laptop block, set the
// toasts: a `[ui.toast]` (or `[ui.toast.*]`) table, a `ui.toast...` key at
// the top level, a `toast...` key under `[ui]`, or a top-level `ui = ...` key
// (an inline table, which a `[ui.toast]` header cannot extend). forge's
// `[ui.toast]` would then override their choice or break the file (herdr
// rejects a table defined twice). Quoted names count as unquoted ones.
function userSetsToasts(text: string): boolean {
  const found = findBlock(text, LAPTOP_MARKERS);
  const outside = found ? text.slice(0, found.from) + text.slice(found.to) : text;
  let table = "";
  for (const l of lines(outside)) {
    const header = /^\s*\[\[?\s*([^\]]*?)\s*\]\]?\s*(?:#.*)?$/.exec(l.text);
    if (header) {
      table = bareName(header[1]);
      if (table === "ui.toast" || table.startsWith("ui.toast.")) return true;
      continue;
    }
    const eq = l.text.indexOf("=");
    if (eq === -1) continue;
    const key = bareName(l.text.slice(0, eq));
    if (table === "") {
      if (key === "ui" || key === "ui.toast" || key.startsWith("ui.toast.")) return true;
    } else if (table === "ui") {
      if (key === "toast" || key.startsWith("toast.")) return true;
    }
  }
  return false;
}

// What the laptop's herdr config says about toasts: forge's laptop block is
// there, the user sets them, or neither. A broken laptop block throws.
export function laptopToasts(text: string): "forge" | "user" | "none" {
  if (findBlock(text, LAPTOP_MARKERS)) return "forge";
  return userSetsToasts(text) ? "user" : "none";
}

// The laptop block added at the end of the config, which is created when
// missing (as writeConfig does for forge setup's block).
export function addLaptopBlock(path: string, text: string): void {
  writeConfig(path, spliceBlock(text, renderLaptopBlock(), LAPTOP_MARKERS).text);
}

export function readConfig(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

// Atomic write: temp file next to the target, then rename. The mode of an
// existing file is kept; a new file is 0644 and its directory 0700. A
// symlinked config (stow, chezmoi) stays a link: the file it points to is
// the one replaced.
function writeConfig(configPath: string, text: string): void {
  const path = existsSync(configPath) ? realpathSync(configPath) : configPath;
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o644;
  const tmp = `${path}.forge-tmp`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode); // the umask may have narrowed the mode above
  renameSync(tmp, path);
}

// HERDR_BIN_PATH, then forge's own install location, then the PATH.
async function findHerdr(ctx: Context): Promise<string | null> {
  const fromEnv = process.env.HERDR_BIN_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const local = join(forgeHome(), ".local", "bin", "herdr");
  if (existsSync(local)) return local;
  return (await ctx.exec(["herdr", "--version"])).code === 0 ? "herdr" : null;
}

export async function ensureHerdrConfig(ctx: Context): Promise<void> {
  const path = herdrConfigPath();
  const text = readConfig(path);
  let spliced;
  try {
    spliced = spliceBlock(text, renderBlock(forgeCommand()));
  } catch (e) {
    throw new ForgeError(`${path}: ${(e as Error).message}`);
  }
  if (spliced.outcome !== "unchanged") writeConfig(path, spliced.text);
  ctx.out(`herdr config ${path}: ${spliced.outcome}`);
  for (const key of conflictingKeys(spliced.text)) {
    ctx.err(`WARNING: ${path} also binds ${key} outside forge's block; herdr may run either.`);
  }

  const bin = await findHerdr(ctx);
  if (!bin) {
    // Normal on a fresh host: herdr installs itself on the first remote attach.
    ctx.err("NOTICE: herdr is not installed on this host yet, which is expected before your first attach. From your " +
      "machine, `herdr --remote <this host> --remote-keybindings server` installs it here, and forge's keys " +
      "(prefix+f) then work.");
    return;
  }

  // `config check` reports problems with the whole file, not only our block.
  const check = await ctx.exec([bin, "config", "check"], { env: { HERDR_CONFIG_PATH: path } });
  for (const line of `${check.stdout}\n${check.stderr}`.split("\n").map((l) => l.trim())) {
    if (line && line !== "config: ok" && line !== "config: issues found") {
      ctx.err(`WARNING: herdr config check: ${line}`);
    }
  }

  // Make a running server pick the bindings up.
  const reload = await ctx.exec([bin, "server", "reload-config"], { env: { HERDR_CONFIG_PATH: path } });
  let parsed: { result?: { status?: string }; error?: { code?: string } } | null = null;
  try { parsed = JSON.parse(reload.stdout); } catch { /* reported below */ }
  if (parsed?.result?.status === "applied") return;
  if (parsed?.error?.code === "server_not_running") {
    ctx.err("NOTICE: no herdr server is running: the bindings apply when it starts.");
    return;
  }
  ctx.err(`WARNING: herdr server reload-config: ${(reload.stdout + reload.stderr).trim()}`);
}
