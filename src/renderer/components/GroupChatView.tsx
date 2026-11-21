/**
 * The Group panel's markup (no state, no IPC): group picker and "+ New", member chips with
 * remove buttons and "+ Add", the status line with Stop and the rounds box, the transcript, and
 * the "Message everyone…" box. `GroupChatPanel` owns the state and passes it in.
 *
 * Model output is untrusted: replies go through the app's Markdown renderer, which has raw HTML
 * turned off, so a reply can format text but never inject markup.
 */
import { useMemo, type ReactNode } from 'react';
import { ENGINE_LABEL, type GroupView, type MemberEngine } from '@shared/group-chat';
import { api } from '@renderer/api';
import { renderMarkdown } from '@renderer/markdown/markdownRenderer';
import { resolvePreviewLink } from '@renderer/markdown/previewLinks';
import { lines, statusLine } from '@renderer/group-chat/group-view';

/** One colour per engine, for badges and the reply edge (matches the BotOffice column). */
export const ENGINE_COLOUR: Readonly<Record<MemberEngine, string>> = {
  claude: '#d97757',
  codex: '#10a37f',
  gemini: '#4285f4',
  ollama: '#8a8f98',
};

interface Props {
  groups: GroupView[];
  group: GroupView | null;
  draft: string;
  error: string | null;
  onPick: (id: string) => void;
  onNew: () => void;
  onRemoveMember: (member: string) => void;
  onOpenAdd: () => void;
  onStop: () => void;
  onDelete: () => void;
  onRounds: (raw: string) => void;
  onDraft: (text: string) => void;
  onSend: () => void;
  /** The "+ Add" menu, when open. */
  addMenu?: ReactNode;
  onClose?: () => void;
}

function EngineBadge({ engine }: { engine: MemberEngine }) {
  return (
    <span
      className="px-1.5 py-[1px] rounded text-[10px] font-semibold text-white shrink-0"
      style={{ background: ENGINE_COLOUR[engine] }}
    >
      {ENGINE_LABEL[engine]}
    </span>
  );
}

type ClickLike = { target: unknown; preventDefault(): void };
type AnchorLike = { getAttribute(name: string): string | null };

/**
 * A link in a reply never navigates the app window (a relative link like `src/x.ts` would resolve
 * inside the app and replace its UI). http(s) links open in the browser; anything else does nothing.
 */
export function handleReplyClick(e: ClickLike, open: (url: string) => void): void {
  const t = e.target as { closest?: (sel: string) => AnchorLike | null } | null;
  const anchor = t?.closest?.('a');
  if (!anchor) return;
  e.preventDefault();
  const action = resolvePreviewLink(anchor.getAttribute('href'), false);
  if (action.kind === 'external') open(action.url);
}

const openExternal = (url: string) => {
  void api.invoke('app:open-external', { url }).catch((err: unknown) => console.error(err));
};

function Reply({ text }: { text: string }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div
      className="markdown text-sm leading-relaxed break-words"
      onClick={(e) => handleReplyClick(e, openExternal)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function GroupChatView(p: Props) {
  const g = p.group;
  const running = g?.status === 'running';
  return (
    <div className="h-full flex flex-col min-h-0 text-sm" data-testid="group-chat-panel">
      <div className="px-3 py-2 border-b border-[--border] bg-[--panel]/40 shrink-0 flex items-center gap-2">
        <span className="font-semibold">Group chat</span>
        <select
          value={g?.id ?? ''}
          onChange={(e) => p.onPick(e.target.value)}
          disabled={p.groups.length === 0}
          className="flex-1 min-w-0 bg-[--panel-strong] border border-[--border] rounded-md px-2 py-1 outline-none focus:ring-1 focus:ring-[--accent]/60"
          aria-label="Group chat"
        >
          {p.groups.length === 0 && <option value="">No group chats yet</option>}
          {p.groups.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        <button type="button" onClick={p.onNew} data-testid="group-new" className="px-2 py-1 rounded-md border border-[--border] hover:bg-[--accent-soft] pressable">
          + New
        </button>
        {p.onClose && (
          <button type="button" onClick={p.onClose} aria-label="Close group chat" title="Close" className="px-1.5 py-1 rounded-md text-[--text-muted] hover:text-[--text]">✕</button>
        )}
      </div>

      {!g && (
        <div className="flex-1 flex items-center justify-center px-6 text-center text-[--text-muted]">
          Start a group chat to have your Claude tab talk with GPT, Gemini or Ollama agents. Nothing runs until you send a message.
        </div>
      )}

      {g && (
        <>
          <div className="px-3 py-2 border-b border-[--border] shrink-0 flex flex-wrap gap-1.5 items-center">
            {g.members.map((m) => {
              const info = g.memberInfo[m];
              if (!info) return null;
              return (
                <span
                  key={m}
                  data-testid="group-member-chip"
                  title={info.available ? info.name : 'its Claude tab isn’t open'}
                  className={`flex items-center gap-1.5 pl-1 pr-1 py-0.5 rounded-md border border-[--border] bg-[--panel-strong] ${info.available ? '' : 'opacity-50'}`}
                >
                  <EngineBadge engine={info.engine} />
                  <span className="truncate max-w-[160px]">{info.name.replace(/ \([^)]*\)$/, '')}</span>
                  {!info.available && <span className="text-[10px] text-[--text-muted]">its Claude tab isn’t open</span>}
                  <button
                    type="button"
                    data-testid="group-remove-member"
                    aria-label={`Remove ${info.name}`}
                    onClick={() => p.onRemoveMember(m)}
                    className="px-1 text-[--text-muted] hover:text-[--text]"
                  >
                    ✕
                  </button>
                </span>
              );
            })}
            <span className="relative">
              <button type="button" data-testid="group-add" onClick={p.onOpenAdd} className="px-2 py-0.5 rounded-md border border-dashed border-[--border] text-[--text-muted] hover:text-[--text]">
                + Add
              </button>
              {p.addMenu}
            </span>
          </div>

          <div className="px-3 py-1.5 border-b border-[--border] shrink-0 flex items-center gap-2 text-xs">
            <span className="flex-1 min-w-0 truncate text-[--text-muted]" data-testid="group-status" title={statusLine(g)}>{statusLine(g)}</span>
            {running ? (
              <button type="button" data-testid="group-stop" onClick={p.onStop} className="px-2 py-0.5 rounded-md bg-red-600/80 text-white hover:bg-red-600">
                ■ Stop
              </button>
            ) : (
              <button type="button" data-testid="group-delete" onClick={p.onDelete} className="px-2 py-0.5 rounded-md text-[--text-muted] hover:text-[--text]" title="Delete this group chat">
                Delete
              </button>
            )}
            <label className="flex items-center gap-1 text-[--text-muted]">
              rounds
              <input
                type="number" min={1} max={10} defaultValue={g.maxRounds} key={`${g.id}:${g.maxRounds}`}
                onBlur={(e) => p.onRounds(e.target.value)}
                className="w-12 bg-[--panel-strong] border border-[--border] rounded px-1 py-0.5"
                aria-label="Rounds per message"
              />
            </label>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-3 py-2 flex flex-col gap-2" data-testid="group-transcript">
            {lines(g).map((l, i) => {
              if (l.kind === 'round') {
                return (
                  <div key={i} data-testid="group-round-divider" className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-[--text-muted]">
                    <span className="flex-1 border-t border-[--border]" />{l.text}<span className="flex-1 border-t border-[--border]" />
                  </div>
                );
              }
              if (l.kind === 'note') return <div key={i} className="text-xs text-center text-[--text-muted]">{l.text}</div>;
              if (l.kind === 'you') {
                return <div key={i} className="self-end max-w-[85%] rounded-lg px-3 py-2 bg-[--accent-soft] text-[--accent-soft-text] whitespace-pre-wrap break-words">{l.text}</div>;
              }
              const colour = l.engine ? ENGINE_COLOUR[l.engine] : '#8a8f98';
              return (
                <div key={i} className="rounded-lg px-3 py-2 bg-[--panel-strong] border-l-4" style={{ borderLeftColor: colour }}>
                  <div className="flex items-center gap-1.5 mb-1 text-xs">
                    {l.engine && <EngineBadge engine={l.engine} />}
                    <span className="font-semibold">{l.who}</span>
                  </div>
                  {l.kind === 'fail'
                    ? <div className="text-xs text-red-500">couldn’t answer: {l.text}</div>
                    : <Reply text={l.text} />}
                </div>
              );
            })}
          </div>

          {p.error && <div className="px-3 py-1 text-xs text-red-500 shrink-0" role="alert">{p.error}</div>}
          <div className="px-3 py-2 border-t border-[--border] shrink-0 flex gap-2 items-end">
            <textarea
              value={p.draft}
              onChange={(e) => p.onDraft(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); p.onSend(); } }}
              placeholder="Message everyone…"
              rows={3}
              className="flex-1 resize-none bg-[--panel-strong] border border-[--border] rounded-md px-2 py-1.5 outline-none focus:ring-1 focus:ring-[--accent]/60"
              aria-label="Message everyone"
            />
            <button type="button" onClick={p.onSend} disabled={!p.draft.trim() || g.members.length === 0} data-testid="group-send" className="px-3 py-1.5 rounded-md bg-[--accent] text-white disabled:opacity-40">
              Send
            </button>
          </div>
        </>
      )}
    </div>
  );
}
