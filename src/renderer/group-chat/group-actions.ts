/** Group-panel actions that need no React, so they can be tested with a fake `api`. */

/** The slice of `window.api` these helpers use. */
export interface InvokeApi {
  invoke(channel: 'groups:say', req: { id: string; text: string }): Promise<unknown>;
}

/** Sends the user's message to everyone in the group; an empty message sends nothing. */
export async function sayToGroup(api: InvokeApi, id: string, text: string): Promise<boolean> {
  const t = text.trim();
  if (!t) return false;
  await api.invoke('groups:say', { id, text: t });
  return true;
}

/** Rounds per message from the user, 1–10, from what was typed in the rounds box; null if not a number. */
export function clampRounds(raw: string): number | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || raw.trim() === '') return null;
  return Math.min(10, Math.max(1, Math.round(n)));
}
