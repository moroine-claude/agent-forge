// La clé que GitHub accepte, et l'agent SSH qui la porte. La liste des clés doit
// venir de l'agent que ssh utilise réellement pour github.com (un `IdentityAgent`
// peut ne viser que lui) : sinon le clone de l'hôte échoue plus tard en
// `Permission denied (publickey)`.
import { homedir } from "node:os";
import { ForgeError, type Context } from "../context.ts";

// L'agent propre à github.com, ou undefined si c'est l'agent par défaut
// (absent, `SSH_AUTH_SOCK`, ou la même socket que SSH_AUTH_SOCK).
export async function githubAgent(ctx: Context): Promise<string | undefined> {
  const r = await ctx.exec(["ssh", "-G", "github.com"]);
  if (r.code !== 0) return undefined;
  // stdout seul (stderr peut porter d'autres messages). La valeur est tout ce
  // qui suit la clé, espaces compris : `ssh -G` ne la met pas entre guillemets.
  let value: string | undefined;
  for (const line of r.stdout.split("\n")) {
    const m = /^identityagent[ \t]+(.+?)\s*$/i.exec(line);
    if (m) { value = m[1]; break; }
  }
  if (!value || value === "SSH_AUTH_SOCK") return undefined;
  // Un OpenSSH ancien peut rendre le `~/` tel quel.
  if (value.startsWith("~/")) value = `${homedir()}/${value.slice(2)}`;
  if (value === process.env.SSH_AUTH_SOCK) return undefined;
  return value;
}

// Une clé publique par ligne, telle que `ssh-add -L` la rend.
export async function listAgentKeys(ctx: Context, agent: string | undefined): Promise<string[]> {
  const r = await ctx.exec(["ssh-add", "-L"], agent ? { env: { SSH_AUTH_SOCK: agent } } : undefined);
  // 1 : l'agent répond mais ne tient aucune clé.
  if (r.code === 1) return [];
  if (r.code !== 0) {
    throw new ForgeError(
      "No SSH agent is reachable. Start an SSH agent and add the key GitHub accepts with ssh-add, then run forge install again.",
    );
  }
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

// Type + commentaire ; sans commentaire, le type et un préfixe de la clé.
export function keyLabel(key: string): string {
  const [type, blob, ...comment] = key.split(/\s+/);
  if (comment.length) return `${type} ${comment.join(" ")}`;
  return `${type} ${(blob ?? "").slice(0, 12)}…`;
}

// La ligne publique complète de la clé choisie (type, base64, commentaire).
export async function chooseKey(ctx: Context, keys: string[]): Promise<string> {
  if (keys.length === 0) {
    throw new ForgeError("The SSH agent holds no key. Add the key GitHub accepts with ssh-add, then run forge install again.");
  }
  if (keys.length === 1) return keys[0];
  const i = await ctx.prompt.pick("Key GitHub accepts", keys.map(keyLabel));
  if (i === null || i < 0 || i >= keys.length) throw new ForgeError("No key chosen.");
  return keys[i];
}
