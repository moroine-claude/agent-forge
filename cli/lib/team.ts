// The members of the configured teams: one container per agent, named after
// its team, role and index, with the `talkTo` lists resolved to container
// names. Pure functions: nothing here touches Incus.
import type { ForgeConfig } from "./config.ts";
import { ForgeError } from "./context.ts";
import type { Capability } from "./team-config.ts";
import { validateContainerName } from "./validate.ts";

export const PILOT = "agent-pilot";
const MAX_NAME = 63;

export type Member = {
  name: string; team: string | null; role: string; index: number | null; repo: string | null;
  capabilities: Capability[]; talkTo: string[]; strict: boolean; memory: string | null; cpu: number | null;
  plugins: string[]; prompt: string | null;
};

// Pilot first, then the teams in key order, the roles in key order.
export function members(cfg: ForgeConfig): Member[] {
  const out: Member[] = [];
  const all = (team: string) => out.filter((m) => m.team === team);
  if (cfg.pilot) {
    out.push({
      name: PILOT, team: null, role: "pilot", index: null, repo: null, capabilities: cfg.pilot.capabilities,
      talkTo: [], strict: cfg.pilot.strict, memory: cfg.pilot.memory, cpu: null, plugins: cfg.pilot.plugins,
      prompt: cfg.pilot.prompt,
    });
  }
  for (const [team, t] of Object.entries(cfg.teams)) {
    for (const [role, r] of Object.entries(t.roles)) {
      const indexes: (number | null)[] = r.count === null ? [null] : Array.from({ length: r.count }, (_, i) => i + 1);
      for (const index of indexes) {
        const name = `agent-${team}-${role}${index === null ? "" : `-${index}`}`;
        if (name.length > MAX_NAME) throw new ForgeError(`container name ${name} is longer than ${MAX_NAME} characters: shorten the team or role name`);
        validateContainerName(name);
        out.push({
          name, team, role, index, repo: r.capabilities.includes("repo") ? t.repo : null,
          capabilities: r.capabilities, talkTo: [], strict: r.strict, memory: r.memory, cpu: r.cpu,
          plugins: r.plugins, prompt: t.prompts === null ? null : `${t.prompts}/${role}.md`,
        });
      }
    }
  }
  // talkTo is resolved once every member exists: a role word means every
  // container of that role, `team` every other member of the team, `pilot` the
  // Pilot; for the Pilot, a team name means that team's leads.
  const configured = (m: Member) => m.team === null ? cfg.pilot!.talkTo : cfg.teams[m.team].roles[m.role].talkTo;
  for (const m of out) {
    const names: string[] = [];
    for (const word of configured(m)) {
      if (m.team === null) names.push(...all(word).filter((x) => x.role === "lead").map((x) => x.name));
      else if (word === "pilot") { if (cfg.pilot) names.push(PILOT); }
      else if (word === "team") names.push(...all(m.team).map((x) => x.name));
      else names.push(...all(m.team).filter((x) => x.role === word).map((x) => x.name));
    }
    m.talkTo = [...new Set(names)].filter((n) => n !== m.name);
  }
  return out;
}

export function memberNamed(cfg: ForgeConfig, name: string): Member {
  const all = members(cfg);
  const found = all.find((m) => m.name === name);
  if (!found) throw new ForgeError(`${name} is not declared in the config (declared: ${all.map((m) => m.name).join(", ") || "none"})`);
  return found;
}
