// Domaine : la correspondance container ↔ repo, le mode, et le tampon d'image.
// Ne sait rien d'argv ni des terminaux.
import type { Context } from "./context.ts";
import { ForgeError } from "./context.ts";
import type { Instance } from "./incus.ts";
import { configGet, imageProperty, instanceExists, instanceStatus, listInstances } from "./incus.ts";

export type BuildStatus = "unknown" | "up-to-date" | "behind";

// Séparé de listForgeContainers pour que `forge list`, qui a déjà besoin des
// statuts, puisse filtrer une liste déjà chargée au lieu de relancer
// `incus list` — la convention de nommage reste définie ici, à un seul endroit.
export function forgeContainerNames(instances: Instance[]): string[] {
  return instances.map((i) => i.name).filter((n) => n.startsWith("agent-"));
}

export async function listForgeContainers(ctx: Context): Promise<string[]> {
  return forgeContainerNames(await listInstances(ctx));
}

export function containerRepo(ctx: Context, name: string): Promise<string> {
  return configGet(ctx, name, "user.forge.repo");
}

// La ref dont est parti le worktree d'une tâche, une clé par tâche.
export const baseKey = (task: string) => `user.forge.base.${task}`;

// Marqueurs posés par `incus launch` et retirés en tout dernier : un container
// qui les porte encore est un provisioning interrompu.
export const PROVISIONING_KEY = "user.forge.provisioning";
export const PROVISIONING_WORKSPACE_KEY = "user.forge.provisioning_workspace";

// null hors provisioning. Une valeur de workspace inconnue se lit "kept" : dans
// le doute, on ne supprime jamais un workspace.
export async function provisioningMarker(
  ctx: Context, name: string,
): Promise<{ repo: string; workspace: "new" | "kept" } | null> {
  const repo = (await configGet(ctx, name, PROVISIONING_KEY)).trim();
  if (!repo) return null;
  const workspace = (await configGet(ctx, name, PROVISIONING_WORKSPACE_KEY)).trim();
  return { repo, workspace: workspace === "new" ? "new" : "kept" };
}

export function containerMode(ctx: Context, name: string): Promise<string> {
  return configGet(ctx, name, "user.forge.mode");
}

// Ne lit que des clés de config : aucun `incus exec`, pour rester assez rapide
// à alimenter une complétion sous TAB ou un menu interactif. Un container à
// moitié provisionné (marqueur, pas de user.forge.repo) compte aussi : sans
// cela, les menus de start et de delete n'offriraient plus son repo.
export async function forgeRepos(ctx: Context): Promise<string[]> {
  const repos: string[] = [];
  for (const name of await listForgeContainers(ctx)) {
    const repo = (await containerRepo(ctx, name)) || (await provisioningMarker(ctx, name))?.repo;
    if (repo && !repos.includes(repo)) repos.push(repo);
  }
  return repos;
}

export async function containerForRepo(ctx: Context, ownerRepo: string): Promise<string | null> {
  const wanted = ownerRepo.toLowerCase();
  for (const name of await listForgeContainers(ctx)) {
    const repo = await containerRepo(ctx, name);
    if (repo.toLowerCase() === wanted) return name;
  }
  return null;
}

export async function requireContainerForRepo(ctx: Context, ownerRepo: string): Promise<string> {
  const container = await containerForRepo(ctx, ownerRepo);
  if (!container) {
    throw new ForgeError(`no container found for ${ownerRepo}. Run 'forge start ${ownerRepo}' first.`);
  }
  return container;
}

// Qui occupe le nom de container d'un repo ? Sonde sans effet de bord ni
// exception : "absent" (rien), "ours" (user.forge.repo est ce repo),
// "half-provisioned" (pas de user.forge.repo, mais le marqueur d'un provisioning
// de CE repo : un lancement interrompu), "unmarked" (aucune métadonnée forge :
// container hérité) ou "other-repo" (user.forge.repo ou marqueur d'un autre repo).
export async function nameOccupant(
  ctx: Context, container: string, ownerRepo: string,
): Promise<"absent" | "ours" | "half-provisioned" | "unmarked" | "other-repo"> {
  if (!(await instanceExists(ctx, container))) return "absent";
  const wanted = ownerRepo.toLowerCase();
  const existing = await containerRepo(ctx, container);
  if (existing) return existing.toLowerCase() === wanted ? "ours" : "other-repo";
  const marker = await provisioningMarker(ctx, container);
  if (!marker) return "unmarked";
  return marker.repo.toLowerCase() === wanted ? "half-provisioned" : "other-repo";
}

// Trois réponses : "absent", "ours" ou "half-provisioned" (un lancement
// interrompu, que `forge start` propose de recréer). Échoue bruyamment pour un
// container d'un *autre* repo ou sans aucune métadonnée forge (container
// hérité) — plutôt que de le réutiliser silencieusement.
export async function checkNameCollision(
  ctx: Context, container: string, ownerRepo: string,
): Promise<"absent" | "ours" | "half-provisioned"> {
  const occupant = await nameOccupant(ctx, container, ownerRepo);
  if (occupant === "unmarked") {
    throw new ForgeError(
      `container ${container} already exists but has no forge metadata. ` +
      `Remove it with: forge delete ${ownerRepo} (its workspace survives).`,
    );
  }
  if (occupant === "other-repo") {
    const other = (await containerRepo(ctx, container)) || (await provisioningMarker(ctx, container))?.repo;
    throw new ForgeError(
      `container ${container} already exists for a different repo (${other}), refusing to reuse it for ${ownerRepo}.`,
    );
  }
  return occupant;
}

export async function isRunning(ctx: Context, name: string): Promise<boolean> {
  return (await instanceStatus(ctx, name)) === "Running";
}

// L'image de base unique : construite par `forge image build`.
export const BASE_IMAGE = "agent-base";

export function containerImageCommit(ctx: Context, name: string): Promise<string> {
  return configGet(ctx, name, "user.forge.image_commit");
}

export function buildStatus(containerCommit: string, latest: string): BuildStatus {
  if (!containerCommit || !latest) return "unknown";
  return containerCommit === latest ? "up-to-date" : "behind";
}

export function latestImageCommit(ctx: Context): Promise<string> {
  return imageProperty(ctx, BASE_IMAGE, "user.forge.commit");
}
