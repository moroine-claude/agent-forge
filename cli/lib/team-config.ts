// The `teams` and `pilot` keys of forge's configuration (DX 5, spec §5.2):
// a team is a repository and its roles; a role becomes one container, or
// `count` of them. Validated by hand like the rest of config.ts: a typo stops
// forge with the file, the key and the expected form.
import { configHelpers, SIZE } from "./config-fields.ts";
import { validateRepo } from "./validate.ts";
import { ForgeError } from "./context.ts";

export const CAPABILITIES = ["repo", "publish", "read-team", "assign", "ask-human", "tickets", "services"] as const;
export type Capability = (typeof CAPABILITIES)[number];

export type RoleConfig = {
  count: number | null; capabilities: Capability[]; talkTo: string[]; strict: boolean;
  memory: string | null; cpu: number | null; plugins: string[];
};
export type TeamConfig = {
  repo: string; roles: Record<string, RoleConfig>; prompts: string | null;
  gitIdentity: { name: string; email: string } | null;
};
export type PilotConfig = {
  capabilities: Capability[]; talkTo: string[]; strict: boolean; memory: string | null;
  plugins: string[]; prompt: string | null;
};

const TEAM_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const ROLE_NAME = /^[a-z][a-z0-9]*$/;
// A plugin as `claude plugin install` names it: name, or name@marketplace.
const PLUGIN = /^[A-Za-z0-9][A-Za-z0-9._@/-]*$/;
// What `talkTo` may name besides a role: every other member, or the Pilot.
const TALK_WORDS = ["team", "pilot"];

export function parseTeams(path: string, raw: unknown): Record<string, TeamConfig> {
  const { invalid, fields } = configHelpers(path);
  const teams: Record<string, TeamConfig> = {};
  for (const [name, value] of Object.entries(fields(raw, "teams", Object.keys(raw as object ?? {})))) {
    const at = `teams.${name}`;
    if (!TEAM_NAME.test(name)) throw invalid(at, "a team name such as web or data-eng ([a-z0-9], single dashes)", name);
    const team = fields(value, at, ["repo", "roles", "prompts", "gitIdentity"]);
    if (typeof team.repo !== "string") throw invalid(`${at}.repo`, "an owner/repo string", team.repo);
    try {
      validateRepo(team.repo);
    } catch {
      throw invalid(`${at}.repo`, "owner/repo", team.repo);
    }
    const rolesRaw = fields(team.roles ?? {}, `${at}.roles`, Object.keys((team.roles as object) ?? {}));
    const roleNames = Object.keys(rolesRaw);
    const roles: Record<string, RoleConfig> = {};
    for (const [role, roleValue] of Object.entries(rolesRaw)) {
      const rat = `${at}.roles.${role}`;
      if (!ROLE_NAME.test(role)) throw invalid(rat, "a role name such as lead or dev ([a-z0-9], no dash)", role);
      const r = fields(roleValue, rat, ["count", "capabilities", "talkTo", "strict", "memory", "cpu", "plugins"]);
      if (r.count !== undefined && r.count !== null &&
          (typeof r.count !== "number" || !Number.isInteger(r.count) || r.count < 1)) {
        throw invalid(`${rat}.count`, "a positive integer", r.count);
      }
      if (r.cpu !== undefined && r.cpu !== null &&
          (typeof r.cpu !== "number" || !Number.isInteger(r.cpu) || r.cpu < 1)) {
        throw invalid(`${rat}.cpu`, "null or a positive integer", r.cpu);
      }
      roles[role] = {
        count: (r.count as number | null | undefined) ?? null,
        capabilities: capabilities(invalid, `${rat}.capabilities`, r.capabilities),
        talkTo: names(invalid, `${rat}.talkTo`, r.talkTo, [...roleNames, ...TALK_WORDS], "a role of this team, team or pilot"),
        strict: bool(invalid, `${rat}.strict`, r.strict),
        memory: memory(invalid, `${rat}.memory`, r.memory),
        cpu: (r.cpu as number | null | undefined) ?? null,
        plugins: plugins(invalid, `${rat}.plugins`, r.plugins),
      };
    }
    if (team.prompts !== undefined && team.prompts !== null && (typeof team.prompts !== "string" || team.prompts === "")) {
      throw invalid(`${at}.prompts`, "null or a directory path", team.prompts);
    }
    let gitIdentity: TeamConfig["gitIdentity"] = null;
    if (team.gitIdentity !== undefined && team.gitIdentity !== null) {
      const g = fields(team.gitIdentity, `${at}.gitIdentity`, ["name", "email"]);
      for (const k of ["name", "email"] as const) {
        if (typeof g[k] !== "string" || g[k] === "") throw invalid(`${at}.gitIdentity.${k}`, "a non-empty string", g[k]);
      }
      gitIdentity = { name: g.name as string, email: g.email as string };
    }
    teams[name] = { repo: team.repo, roles, prompts: (team.prompts as string | null | undefined) ?? null, gitIdentity };
  }
  return teams;
}

// null when the config has no `pilot`; its `talkTo` is checked against the
// declared teams by parseConfig, which sees both.
export function parsePilot(path: string, raw: unknown): PilotConfig | null {
  if (raw === undefined || raw === null) return null;
  const { invalid, fields } = configHelpers(path);
  const p = fields(raw, "pilot", ["capabilities", "talkTo", "strict", "memory", "plugins", "prompt"]);
  if (p.prompt !== undefined && p.prompt !== null && (typeof p.prompt !== "string" || p.prompt === "")) {
    throw invalid("pilot.prompt", "null or a file path", p.prompt);
  }
  return {
    capabilities: capabilities(invalid, "pilot.capabilities", p.capabilities),
    talkTo: names(invalid, "pilot.talkTo", p.talkTo, null, "a list of team names"),
    strict: bool(invalid, "pilot.strict", p.strict),
    memory: memory(invalid, "pilot.memory", p.memory),
    plugins: plugins(invalid, "pilot.plugins", p.plugins),
    prompt: (p.prompt as string | null | undefined) ?? null,
  };
}

type Invalid = (key: string, expected: string, got: unknown) => ForgeError;

function capabilities(invalid: Invalid, key: string, v: unknown): Capability[] {
  if (v === undefined) return [];
  const ok = Array.isArray(v) && v.every((c) => (CAPABILITIES as readonly unknown[]).includes(c)) && new Set(v).size === v.length;
  if (!ok) throw invalid(key, `a list of distinct capabilities among ${CAPABILITIES.join(", ")}`, v);
  return v as Capability[];
}

function names(invalid: Invalid, key: string, v: unknown, allowed: string[] | null, expected: string): string[] {
  if (v === undefined) return [];
  const ok = Array.isArray(v) && v.every((n) => typeof n === "string" && (allowed === null || allowed.includes(n)));
  if (!ok) throw invalid(key, expected, v);
  return v as string[];
}

function plugins(invalid: Invalid, key: string, v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((p) => typeof p === "string" && PLUGIN.test(p))) {
    throw invalid(key, "a list of plugin names such as name or name@marketplace", v);
  }
  return v as string[];
}

function bool(invalid: Invalid, key: string, v: unknown): boolean {
  if (v === undefined) return false;
  if (typeof v !== "boolean") throw invalid(key, "true or false", v);
  return v;
}

function memory(invalid: Invalid, key: string, v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !SIZE.test(v)) throw invalid(key, 'null or a size (such as "8GiB")', v);
  return v;
}
