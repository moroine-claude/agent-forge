// Politique d'acquittement de la popup herdr : ce que l'exécution écrit et que
// l'utilisateur doit lire (lignes WARNING/NOTICE sur stderr, ctx.notify) est
// collecté ici, puis envoyé en une notification herdr par main.
import type { Context } from "./context.ts";

export const MAX_NOTICE_LINES = 10;

// Le contexte rendu transmet tout à `base` ; les lignes à retenir sont en plus
// ajoutées à `notices`, dans l'ordre. Rien de global : l'état vit dans l'appel.
export function collectNotices(base: Context): { ctx: Context; notices: string[] } {
  const notices: string[] = [];
  const ctx: Context = {
    ...base,
    err: (line) => {
      if (line.startsWith("WARNING") || line.startsWith("NOTICE")) notices.push(line);
      base.err(line);
    },
    notify: (line) => { notices.push(line); base.out(line); },
  };
  return { ctx, notices };
}

// Corps de la notification : au-delà de MAX_NOTICE_LINES lignes, on garde les
// premières et on compte le reste.
export function noticeBody(lines: string[]): string {
  if (lines.length <= MAX_NOTICE_LINES) return lines.join("\n");
  const kept = lines.slice(0, MAX_NOTICE_LINES - 1);
  return [...kept, `…and ${lines.length - kept.length} more`].join("\n");
}

// Décision après l'exécution : "close" (le processus se termine), "notify"
// (notification herdr des lignes collectées) ou "wait" (Entrée). Une erreur
// ou un code non nul attend dans la popup comme dans un pane d'attach ; une
// exception n'envoie jamais de notification ; hors herdr, on ne fait rien.
// `code` vaut null quand l'exécution a levé une exception.
export function ackAfterRun(s: {
  popup: boolean; attachPane: boolean; code: number | null; threw: boolean; notices: number;
}): "close" | "notify" | "wait" {
  if (!s.popup && !s.attachPane) return "close";
  if (s.threw || (s.code ?? 0) !== 0) return "wait";
  return s.popup && s.notices > 0 ? "notify" : "close";
}
