import { useRef, useState, type KeyboardEvent } from 'react';
import { useAgentChat } from '@renderer/hooks/useAgentChat';
import { formatMention } from '@shared/chat-mention';

/**
 * Agents pane. Left column shows every poster the thread has mentioned —
 * a cheap roster that shows up as soon as a message arrives. Right column
 * is the thread; the composer at the bottom sends via useAgentChat.
 */
export function AgentChatTab({ projectId, selfDevice }: { projectId: number; selfDevice: string }) {
  const { entries, send } = useAgentChat(projectId);
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  // Simple derived roster: distinct `from` mentions seen in the thread.
  const roster = Array.from(
    new Map(
      entries.map((e) => [
        `${e.from.agent}#${e.from.shell}@${e.from.device}`,
        {
          agent: e.from.agent,
          shell: e.from.shell,
          device: e.from.device,
          mention: formatMention({
            agent: e.from.agent,
            device: e.from.device === selfDevice ? undefined : e.from.device,
          }),
        },
      ]),
    ).values(),
  );

  const onKeyDown = async (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      const body = draft;
      setDraft('');
      await send(body);
    }
  };

  return (
    <div className="h-full flex" data-testid="agent-chat-tab">
      <aside className="w-48 shrink-0 border-r border-[--border] p-3 flex flex-col gap-1 text-sm">
        <div className="text-[--text-muted] text-xs uppercase tracking-wide mb-1">Roster</div>
        {roster.length === 0 ? (
          <div className="text-[--text-muted] text-xs">No one yet.</div>
        ) : (
          roster.map((r) => (
            <button
              key={`${r.agent}#${r.shell}@${r.device}`}
              className="text-left px-2 py-1 rounded hover:bg-[--surface-hover] text-[--text]"
              onClick={() => setDraft((d) => (d ? `${d} ${r.mention} ` : `${r.mention} `))}
            >
              <span className="text-[--text]">{r.agent}</span>
              {r.device !== selfDevice && <span className="text-[--text-muted] text-xs"> ({r.device})</span>}
            </button>
          ))
        )}
      </aside>
      <section className="flex-1 flex flex-col">
        <div ref={listRef} className="flex-1 overflow-auto p-3 space-y-2">
          {entries.map((e) => (
            <div
              key={e.id}
              className={`text-sm ${e.meta?.cap_held || e.meta?.undelivered ? 'opacity-60 border-l-2 border-[--hue-red] pl-2' : ''}`}
            >
              <span className="text-[--text-muted] text-xs">
                {new Date(e.ts).toLocaleTimeString()}{' '}
              </span>
              <span className="text-[--accent-soft-text] font-medium">
                {formatMention({ agent: e.from.agent, device: e.from.device === selfDevice ? undefined : e.from.device })}
              </span>{' '}
              <span>{e.body}</span>
              {e.meta?.cap_held && (
                <span className="text-[--hue-red] text-xs ml-2">· cap held</span>
              )}
              {e.meta?.undelivered && !e.meta?.cap_held && (
                <span className="text-[--hue-red] text-xs ml-2">· not delivered (no matching agent online)</span>
              )}
            </div>
          ))}
        </div>
        <div className="p-3 border-t border-[--border]">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="@claude @codex … (Enter to send, Shift-Enter for newline)"
            rows={2}
            className="w-full bg-[--surface] border border-[--border] rounded px-2 py-1 text-sm resize-none focus:outline-none focus:border-[--accent]"
          />
        </div>
      </section>
    </div>
  );
}
