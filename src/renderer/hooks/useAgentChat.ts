/**
 * Live chat-bus entries for one project, plus a `send` helper.
 * Reads `chat:list` once on mount, then tails `chat:changed`.
 */
import { useCallback, useEffect, useState } from 'react';
import { api } from '@renderer/api';
import type { ChatEntry, ChatMention } from '@shared/chat';
import { parseMentions } from '@shared/chat-mention';

const BUFFER_MAX = 1000;

export function useAgentChat(projectId: number): {
  entries: ChatEntry[];
  send(body: string, replyIn?: string): Promise<void>;
} {
  const [entries, setEntries] = useState<ChatEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { entries } = await api.invoke('chat:list', { projectId, limit: 200 });
        if (!cancelled) setEntries(entries);
      } catch { /* ignore */ }
    })();
    const off = api.on('chat:changed', (ev) => {
      if (ev.projectId !== projectId) return;
      setEntries((prev) => {
        // Replace an existing entry with the same id (cap-held re-broadcast
        // of the same post arrives with updated `meta`) rather than pushing
        // a duplicate.
        const i = prev.findIndex((e) => e.id === ev.entry.id);
        const next = i >= 0 ? prev.map((e, j) => (j === i ? ev.entry : e)) : [...prev, ev.entry];
        return next.length > BUFFER_MAX ? next.slice(-BUFFER_MAX) : next;
      });
    });
    return () => { cancelled = true; off(); };
  }, [projectId]);

  const send = useCallback(async (body: string, replyIn?: string) => {
    if (!body.trim()) return;
    const to: ChatMention[] = parseMentions(body);
    await api.invoke('chat:append', {
      projectId,
      from: { shell: -1, agent: 'human' },
      body,
      to,
      ...(replyIn !== undefined ? { reply_in: replyIn } : {}),
    });
  }, [projectId]);

  return { entries, send };
}
