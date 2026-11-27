import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { api } from '@renderer/api';
import { useAgentChat } from '@renderer/hooks/useAgentChat';
import { useChatRoster } from '@renderer/hooks/useChatRoster';
import { useAgentIntent } from '@renderer/hooks/useAgentIntent';
import { useGroupChat } from '@renderer/hooks/useGroupChat';
import { formatMention } from '@shared/chat-mention';
import type { ChatEntry } from '@shared/chat';
import { ENGINE_LABEL, type GroupView, type LogEntry, type MemberEngine } from '@shared/group-chat';
import { toast } from '@renderer/hooks/useToasts';

/**
 * Merged-thread item: either a chat-bus entry or one log line from a
 * group chat (running or stopped). Sorted by `ts` in the component.
 */
type TimelineItem =
  | { kind: 'chat'; ts: number; chat: ChatEntry }
  | { kind: 'round'; ts: number; log: LogEntry; group: GroupView };

/** One colour per engine, for the round-transcript left edge and badges. Matches BotOffice. */
const ENGINE_COLOUR: Readonly<Record<MemberEngine, string>> = {
  claude: '#d97757',
  codex: '#10a37f',
  gemini: '#4285f4',
  ollama: '#8a8f98',
};

/**
 * Agents pane. Left column lists every agent you can @-mention: live
 * local shells + paired-peer shells, pulled from the main-process
 * roster (so Claude shows up the moment its shell spawns, not only
 * after its first chat message). Right column is the thread; the
 * composer at the bottom sends via useAgentChat.
 *
 * `focusTick` is a monotonic counter the parent bumps when the ⇧⌘A
 * shortcut fires — any change (including the first non-zero value) lands
 * focus in the composer without the user clicking the pane.
 *
 * Layout: the roster bar (pills, Start round) sits above the panel, outside
 * it, the way the Shell tabs sit above the Shell sheet. `panelClassName` and
 * `panelSheetContent` style the panel holding the thread and composer;
 * `barEnd` is appended to the bar (the dock's close button); `barMinHeight`
 * lets the parent match the bar to the workspace header row, so the panel
 * starts at the same height as the Shell sheet.
 */
export function AgentChatTab({ projectId, selfDevice: selfDeviceProp, focusTick, panelClassName, panelSheetContent, barEnd, barMinHeight }: {
  projectId: number;
  selfDevice: string;
  focusTick?: number;
  panelClassName?: string;
  panelSheetContent?: string;
  barEnd?: ReactNode;
  barMinHeight?: number;
}) {
  const { entries, send } = useAgentChat(projectId);
  const { rows: liveRoster, selfDevice: rosterSelfDevice } = useChatRoster();
  const intent = useAgentIntent(projectId);
  const { groups, running: runningGroup } = useGroupChat(projectId);
  const [roundBusy, setRoundBusy] = useState(false);
  // Prefer the roster's canonical self device over the P2P hook: when
  // P2P is off the hook returns '', which never matches `row.device` and
  // leaks a "·device" suffix on every local pill.
  const selfDevice = rosterSelfDevice || selfDeviceProp;
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focusTick !== undefined && focusTick > 0) composerRef.current?.focus();
  }, [focusTick]);

  // Live roster first (every agent you can @ right now), augmented with
  // any extra posters that appeared in the thread but aren't currently
  // live (shown with a dim "offline" marker so the history stays legible).
  const roster = useMemo(() => {
    type Row = { projectId: number | null; agent: string; shell: number; device: string; mention: string; nickname: string | null; online: boolean };
    const map = new Map<string, Row>();
    for (const r of liveRoster) {
      map.set(`${r.agent}#${r.shell}@${r.device}`, {
        projectId: r.projectId, agent: r.agent, shell: r.shell, device: r.device, mention: r.mention, nickname: r.nickname, online: true,
      });
    }
    for (const e of entries) {
      const key = `${e.from.agent}#${e.from.shell}@${e.from.device}`;
      if (map.has(key)) continue;
      map.set(key, {
        projectId: null,
        agent: e.from.agent,
        shell: e.from.shell,
        device: e.from.device,
        mention: formatMention({ agent: e.from.agent, device: e.from.device === selfDevice ? undefined : e.from.device }),
        nickname: null,
        online: false,
      });
    }
    return Array.from(map.values());
  }, [liveRoster, entries, selfDevice]);

  /** Prompt for a new nickname, write via IPC — alive-shells:changed refreshes the roster. */
  const renameAgent = async (r: { projectId: number | null; device: string; shell: number; agent: string; nickname: string | null }) => {
    if (r.projectId == null || r.device !== selfDevice) {
      toast('Rename is only available for local shells', { kind: 'info', timeoutMs: 2000 });
      return;
    }
    const next = window.prompt(`Nickname for ${r.agent} #${r.shell} (letters, numbers, - _ ; empty to clear):`, r.nickname ?? '');
    if (next === null) return; // cancel
    try {
      await api.invoke('shells:set-nickname', { projectId: r.projectId, shellIndex: r.shell, nickname: next });
    } catch (e) {
      toast('Rename failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    }
  };

  /**
   * One-click "Start round" — the formal, turn-taking group chat ported from
   * Martin's `feat/group-chats` branch.
   *
   * The dock is the single place users talk to agents. Ambient chat bus is
   * the default; this button switches into round mode on demand: a prompt
   * for the opening message, then auto-seeds a new group with every
   * joinable Claude tab in the project and every ready headless engine
   * (Codex, Gemini, Ollama). Rounds run in the background; their log
   * entries render in this same thread, tagged with `R<n>` so they're
   * clearly round messages and not casual bus chatter.
   *
   * Callers of `groups:say` must never block the user's typing in the
   * composer — this whole function is kicked off from the start button
   * and awaits locally, only setting `roundBusy` so repeat clicks don't
   * race. Errors surface through toasts; partial failures (no Claude tabs,
   * no ready engines) still start a group with whatever is available and
   * Martin's service handles the degenerate <2-members case cleanly.
   */
  const startRound = async () => {
    if (roundBusy || runningGroup) return;
    const prompt = window.prompt('What should the agents discuss? (leave empty to cancel)', '');
    if (prompt === null || prompt.trim() === '') return;
    setRoundBusy(true);
    try {
      const { group } = await api.invoke('groups:create', { projectId });
      // Add every joinable Claude tab in the project.
      try {
        const { tabs } = await api.invoke('groups:joinable', { projectId, id: group.id });
        for (const t of tabs) {
          if (t.joinable) {
            try { await api.invoke('groups:add-claude', { id: group.id, shell: { projectId: t.projectId, shellIndex: t.shellIndex } }); } catch { /* best-effort */ }
          }
        }
      } catch { /* best-effort */ }
      // Add every ready headless engine, with a sensible display name.
      try {
        const engines = await api.invoke('groups:engines', {});
        for (const engine of ['codex', 'gemini', 'ollama'] as const) {
          if (engines[engine].ready) {
            try { await api.invoke('groups:add-headless', { id: group.id, engine, name: ENGINE_LABEL[engine] }); } catch { /* best-effort */ }
          }
        }
      } catch { /* best-effort */ }
      await api.invoke('groups:say', { id: group.id, text: prompt });
      toast('Round started', { kind: 'info', timeoutMs: 1500 });
    } catch (e) {
      toast('Could not start round', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    } finally {
      setRoundBusy(false);
    }
  };

  const stopRound = async () => {
    if (!runningGroup) return;
    setRoundBusy(true);
    try {
      await api.invoke('groups:stop', { id: runningGroup.id });
      toast('Round stopped', { kind: 'info', timeoutMs: 1500 });
    } catch (e) {
      toast('Stop failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    } finally {
      setRoundBusy(false);
    }
  };

  /**
   * Manual re-onboard for an already-running agent. Writes the stanza
   * (idempotent) and pushes the read-this nudge into the shell. Scoped
   * to local shells running one of the supported CLIs — remote peers and
   * unrecognised commands have no chat-bus story.
   */
  const onboardAgent = async (r: { projectId: number | null; device: string; shell: number; agent: string }) => {
    if (r.projectId == null || r.device !== selfDevice) {
      toast('Re-onboard is only available for local shells', { kind: 'info', timeoutMs: 2000 });
      return;
    }
    if (r.agent !== 'claude' && r.agent !== 'codex' && r.agent !== 'opencode') {
      toast(`No chat-bus onboarding for ${r.agent}`, { kind: 'info', timeoutMs: 2000 });
      return;
    }
    try {
      const res = await api.invoke('chat:onboard-agent', { projectId: r.projectId, shellIndex: r.shell, agent: r.agent });
      toast(res.appended ? `Wrote chat-bus stanza + nudged ${r.agent}` : `Nudged ${r.agent} to re-read stanza`, { kind: 'info', timeoutMs: 2500 });
    } catch (e) {
      toast('Onboard failed', { kind: 'error', detail: String(e).replace(/^Error:\s*/, '') });
    }
  };

  /**
   * Merged chronological timeline: ambient chat-bus entries + every
   * group's log entries (running and past), sorted by timestamp. The
   * display is the single source of truth for "what happened in this
   * project" so users don't have to track two threads — round messages
   * carry an `R<n>` chip and an engine-coloured left edge so it stays
   * obvious which are formal-round and which are casual-bus.
   */
  const timeline = useMemo<TimelineItem[]>(() => {
    const items: TimelineItem[] = [];
    for (const e of entries) items.push({ kind: 'chat', ts: new Date(e.ts).getTime(), chat: e });
    for (const g of groups) {
      for (const l of g.log) items.push({ kind: 'round', ts: new Date(l.at).getTime(), log: l, group: g });
    }
    items.sort((a, b) => a.ts - b.ts);
    return items;
  }, [entries, groups]);

  // @-autocomplete state. The dropdown is shown whenever the caret sits
  // inside an @word in the draft — same contract as ChatTab's composer.
  const [caret, setCaret] = useState(0);
  const [pickIdx, setPickIdx] = useState(0);
  const mention = useMemo(() => extractAgentMention(draft, caret), [draft, caret]);
  const candidates = useMemo(() => {
    if (!mention) return [] as typeof roster;
    const q = mention.query.toLowerCase();
    return roster
      .filter((r) => {
        const name = (r.nickname ?? r.agent).toLowerCase();
        return q === '' || name.startsWith(q) || r.agent.toLowerCase().startsWith(q);
      })
      .slice(0, 8);
  }, [mention, roster]);
  useEffect(() => { setPickIdx(0); }, [candidates.length, mention?.query]);

  const insertCandidate = (r: (typeof roster)[number]) => {
    if (!mention) return;
    const before = draft.slice(0, mention.start);
    const after  = draft.slice(mention.end);
    const replacement = `${r.mention} `;
    const next = before + replacement + after;
    setDraft(next);
    const newCaret = (before + replacement).length;
    requestAnimationFrame(() => {
      const el = composerRef.current;
      if (!el) return;
      el.selectionStart = el.selectionEnd = newCaret;
      el.focus();
      setCaret(newCaret);
    });
  };

  const onKeyDown = async (ev: KeyboardEvent<HTMLTextAreaElement>) => {
    if (candidates.length > 0 && mention) {
      if (ev.key === 'ArrowDown') { ev.preventDefault(); setPickIdx((i) => Math.min(candidates.length - 1, i + 1)); return; }
      if (ev.key === 'ArrowUp')   { ev.preventDefault(); setPickIdx((i) => Math.max(0, i - 1)); return; }
      if (ev.key === 'Enter' || ev.key === 'Tab') { ev.preventDefault(); insertCandidate(candidates[pickIdx]!); return; }
      if (ev.key === 'Escape')    { ev.preventDefault(); setCaret(-1); return; }
    }
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      const body = draft;
      setDraft('');
      await send(body);
    }
  };

  return (
    <div className="h-full min-h-0 flex flex-col" data-testid="agent-chat-tab">
      {/* Horizontal pill bar — compact, reclaims horizontal space for the thread. */}
      <div className="shrink-0 px-0 py-1.5 flex flex-wrap items-center gap-1.5" data-testid="agent-chat-bar"
        style={barMinHeight ? { minHeight: barMinHeight } : undefined}>
        {roster.length === 0 ? (
          <div className="text-[--text-muted] text-xs flex items-center gap-2">
            <span>No agents running.</span>
            <span className="opacity-70">Open a shell (⌘T) and run <code className="font-mono">claude</code> / <code className="font-mono">codex</code> / <code className="font-mono">opencode</code>.</span>
          </div>
        ) : (
          <>
            {roster.map((r) => {
              const display = r.nickname ?? r.agent;
              const canRename = r.projectId != null && r.device === selfDevice;
              // Pull the agent's "what I'm doing" line; only shown for
              // local, online rows — a stale intent on an offline shell
              // is noise, and a peer-posted intent isn't bus-wired yet.
              const intentView = r.online && r.device === selfDevice
                ? intent.get(`${r.agent}#${r.shell}`)
                : undefined;
              // Count duplicates of this family on this device — when there are
              // two+ `claude`s, the user NEEDS to nickname at least one, so the
              // pencil stays visible (not hover-only). Same for a nicknamed row
              // so they can refine the name without hunting for the gesture.
              const dup = roster.filter((o) => o.agent === r.agent && o.device === r.device && o.online).length > 1;
              const showPencilAlways = canRename && (dup || r.nickname !== null);
              const needsName = canRename && dup && !r.nickname;
              const tooltip = [
                r.mention,
                r.nickname ? `(${r.agent})` : '',
                r.online ? '' : '— offline',
                needsName ? '— click ✎ to give it a name so you can tell duplicate CLIs apart' : canRename ? '— click to insert, ✎ to rename' : '— click to insert',
              ].filter(Boolean).join(' ');
              return (
                <div
                  key={`${r.agent}#${r.shell}@${r.device}`}
                  className={`group inline-flex items-center rounded-full border text-xs shrink-0 ${r.online
                    ? 'bg-[--panel] text-[--text]'
                    : 'bg-transparent text-[--text-muted] opacity-70'
                  } ${needsName ? 'border-[--hue-amber]/60' : 'border-[--border] hover:border-[--accent]/40'}`}
                >
                  <button
                    title={tooltip}
                    className="pl-2 pr-1 py-0.5 flex items-center gap-1.5"
                    onClick={() => setDraft((d) => (d ? `${d} ${r.mention} ` : `${r.mention} `))}
                    onContextMenu={(e) => { e.preventDefault(); void renameAgent(r); }}
                    onDoubleClick={() => void renameAgent(r)}
                  >
                    <span className={`inline-block w-1.5 h-1.5 rounded-full ${r.online ? 'bg-[--accent]' : 'bg-[--text-muted]'}`} aria-hidden="true" />
                    <span className="truncate max-w-[10rem]">{display}</span>
                    {r.device !== selfDevice && <span className="text-[--text-muted] opacity-80">·{r.device}</span>}
                    {intentView && (
                      <span
                        className={`text-[--text-muted] truncate max-w-[14rem] ${intentView.kind === 'dim' ? 'opacity-60' : ''} ${intentView.kind === 'idle' ? 'opacity-40 italic' : ''}`}
                        title={intentView.kind === 'idle'
                          ? `${display} — no update for a while; last said: "${intentView.update.text}"`
                          : `${display}: ${intentView.update.text}`}
                      >
                        · {intentView.display}
                      </span>
                    )}
                  </button>
                  {canRename && (
                    <button
                      title={needsName ? `Nickname this ${r.agent} so you can tell it apart from the other ${r.agent} shells` : `Rename ${display}`}
                      aria-label={`Rename ${display}`}
                      onClick={() => void renameAgent(r)}
                      className={`${showPencilAlways ? 'opacity-70 hover:opacity-100' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'} pl-0.5 py-0.5 ${needsName ? 'text-[--hue-amber]' : 'text-[--text-muted] hover:text-[--text]'}`}
                    >
                      ✎
                    </button>
                  )}
                  {/* Re-onboard: writes the chat-bus stanza (idempotent) and pushes
                      the read-this nudge into this shell. Only for local shells
                      running a CLI the chat bus supports. Hidden until hover so
                      the pill stays compact. */}
                  {canRename && (r.agent === 'claude' || r.agent === 'codex' || r.agent === 'opencode') && (
                    <button
                      title={`Re-teach ${display} about the metaIDE chat bus (writes the stanza if missing and pushes "please read" into this shell)`}
                      aria-label={`Re-onboard ${display}`}
                      onClick={() => void onboardAgent(r)}
                      className="opacity-0 group-hover:opacity-100 focus:opacity-100 pr-2 pl-0.5 py-0.5 text-[--text-muted] hover:text-[--text]"
                    >
                      ↻
                    </button>
                  )}
                  {/* Keep the trailing pad consistent when the re-onboard button
                      is absent (non-supported CLI pills) — the pencil already
                      used pr-2, so swap it back in via a tiny spacer. */}
                  {canRename && !(r.agent === 'claude' || r.agent === 'codex' || r.agent === 'opencode') && (
                    <span className="pr-2" aria-hidden="true" />
                  )}
                </div>
              );
            })}
            {/* Round-mode affordance: a single button that flips the dock
                between the ambient chat bus (default) and Martin's formal
                round-based group chat. Only one group runs at a time in a
                project, so the button is either "⚙ Start round" (no group
                running) or "Round N/M · ■ Stop" (a round is live). */}
            {runningGroup ? (
              <div className="ml-auto flex items-center gap-1.5 text-xs shrink-0" title="A formal round-based group chat is running. Agents take turns; the thread below carries round messages tagged R<n>.">
                <span className="px-2 py-0.5 rounded-full bg-[--accent]/15 text-[--accent-soft-text] font-medium">
                  Round {runningGroup.k}/{runningGroup.maxRounds}
                </span>
                <button
                  onClick={() => void stopRound()}
                  disabled={roundBusy}
                  className="px-2 py-0.5 rounded-full border border-[--border] hover:border-[--hue-red] hover:text-[--hue-red] disabled:opacity-50"
                  title="Stop this round now. Members finish their current turn; new rounds don't start."
                >
                  ■ Stop
                </button>
              </div>
            ) : (
              <button
                onClick={() => void startRound()}
                disabled={roundBusy || roster.length < 2}
                className="ml-auto px-2 py-0.5 rounded-full border border-[--border] text-xs text-[--text-muted] hover:text-[--text] hover:border-[--accent]/40 disabled:opacity-40 shrink-0"
                title={roster.length < 2
                  ? 'Start a round-based group chat (needs at least 2 agents in the project — spawn another shell or run a headless engine)'
                  : 'Start a round-based group chat. Every joinable Claude tab and every ready headless engine (Codex, Gemini, Ollama) is added; you pose the question, they take turns answering.'}
              >
                ⚙ Start round
              </button>
            )}
            <span
              className="text-[--text-muted] text-xs cursor-help select-none shrink-0"
              title={'Click a pill to drop @mention into your message.\nPress Enter to send — the message appears in that agent\'s shell as a line it can read and reply to.\nRight-click (or hover-✎) to rename a local agent.\nGreen dot = online. Grey = seen before but not running now.'}
              aria-label="Roster help"
            >
              ⓘ
            </span>
          </>
        )}
        {barEnd && <div className={`${roster.length === 0 ? 'ml-auto ' : ''}shrink-0 flex items-center`}>{barEnd}</div>}
      </div>
      <section className={`flex-1 flex flex-col min-h-0 ${panelClassName ?? ''}`} data-testid="agent-chat-panel"
        {...(panelSheetContent ? { 'data-sheet-content': panelSheetContent } : {})}>
        <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2">
          {timeline.length === 0 ? (
            <div className="h-full flex items-center justify-center p-6 text-center">
              <div className="max-w-sm text-sm text-[--text-muted] leading-relaxed">
                <div className="text-[--text] font-medium mb-2">Message your agents</div>
                <div>
                  Tap an agent pill above (or type <code className="font-mono text-[--text]">@</code>)
                  to address them, then press <kbd className="px-1 py-0.5 text-[10px] rounded border border-[--border] font-mono">Enter</kbd> to send.
                </div>
                <div className="mt-3 opacity-80">
                  Your message appears in that agent&apos;s shell as a line it can read — it can reply the same way.
                </div>
                <div className="mt-3 opacity-80">
                  Or use <span className="font-medium text-[--text]">⚙ Start round</span> above to have every agent discuss something together, one turn at a time.
                </div>
              </div>
            </div>
          ) : timeline.map((item) => (
            item.kind === 'chat' ? renderChatRow(item.chat, selfDevice) : renderRoundRow(item.log, item.group)
          ))}
        </div>
      </section>
      <div className="shrink-0 pt-2 pb-2 relative" data-testid="agent-chat-composer">
          {candidates.length > 0 && mention && (
            <div className="absolute bottom-full left-0 right-0 mb-1 max-h-56 overflow-y-auto rounded-md border border-[--border] bg-[--panel-strong] shadow-xl z-10">
              {candidates.map((r, i) => {
                return (
                  <button
                    key={`${r.agent}#${r.shell}@${r.device}`}
                    onMouseDown={(e) => { e.preventDefault(); insertCandidate(r); }}
                    onMouseEnter={() => setPickIdx(i)}
                    className={`w-full text-left px-3 py-1.5 text-xs flex items-center gap-2 ${i === pickIdx ? 'bg-[color:var(--accent)]/25' : 'hover:bg-[--panel]'}`}
                  >
                    <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${r.online ? 'bg-[--accent]' : 'bg-[--text-muted]'}`} aria-hidden="true" />
                    <span className="font-medium">{r.mention}</span>
                    {r.nickname && <span className="text-[10px] text-[--text-muted]">({r.agent})</span>}
                    {r.device !== selfDevice && <span className="text-[10px] text-[--text-muted]">· {r.device}</span>}
                    {!r.online && <span className="text-[10px] text-[--text-muted] ml-auto">offline</span>}
                  </button>
                );
              })}
              {sameFamilyCount(roster) > 1 && (
                <div className="px-3 py-1.5 text-[10px] text-[--text-muted] border-t border-[--border] bg-[--panel]/60">
                  Tip: you have multiple shells of the same CLI — give each a nickname (hover a pill ✎) so you can @ them by name.
                </div>
              )}
            </div>
          )}
          <textarea
            ref={composerRef}
            value={draft}
            onChange={(e) => { setDraft(e.target.value); setCaret(e.target.selectionStart ?? 0); }}
            onSelect={(e) => setCaret((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
            onKeyDown={onKeyDown}
            placeholder={roster.length === 0
              ? 'Spawn an agent in a shell first (⌘T → run claude / codex / …)'
              : 'Tap an agent above or type @ · Enter sends · Shift-Enter for a new line'}
            rows={2}
            className="w-full bg-black/20 border border-[--border] rounded px-2 py-1 text-sm resize-none focus:outline-none focus:border-[--accent]"
          />
      </div>
    </div>
  );
}

/**
 * Chat-bus row renderer — ambient `[metaide-chat …]` traffic. Carries the
 * same delivery-status badges (cap-held / undelivered / rate-limited) the
 * chat log tracks; mentions in the body are highlighted so a line's
 * routing hints stand out from its prose.
 */
function renderChatRow(e: ChatEntry, selfDevice: string): ReactElement {
  const flagged = e.meta?.cap_held || e.meta?.undelivered || e.meta?.rate_dropped;
  return (
    <div
      key={e.id}
      className={`text-sm ${flagged ? 'opacity-60 border-l-2 border-[--hue-red] pl-2' : ''}`}
    >
      <span className="text-[--text-muted] text-xs">
        {new Date(e.ts).toLocaleTimeString()}{' '}
      </span>
      <span className="text-[--accent-soft-text] font-medium">
        {formatMention({ agent: e.from.agent, device: e.from.device === selfDevice ? undefined : e.from.device })}
      </span>{' '}
      <span>{renderBodyWithMentions(e.body)}</span>
      {e.meta?.cap_held && (
        <span className="text-[--hue-red] text-xs ml-2" title="The recipient agent is at its concurrent-reply cap; the message is queued and will deliver when it frees up.">· cap held</span>
      )}
      {e.meta?.undelivered && !e.meta?.cap_held && (
        <span className="text-[--hue-red] text-xs ml-2" title="No matching agent shell is running right now; the message is in the log but nobody received it.">· not delivered (no matching agent online)</span>
      )}
      {e.meta?.rate_dropped && !e.meta?.cap_held && !e.meta?.undelivered && (
        <span className="text-[--hue-red] text-xs ml-2" title="This agent is posting faster than the per-shell rate limit (3 messages per second); the injector dropped the message to protect the recipient.">· rate-limited (sender over budget)</span>
      )}
    </div>
  );
}

/**
 * Group-chat log row renderer — formal, turn-taking rounds from Martin's
 * `groups.ts`. Meta entries (`start`, `round`, `end`, `member`) render as
 * centred dividers so they anchor the eye without crowding the thread.
 * Reply / fail / you entries render like a chat row but with an engine-
 * coloured left edge and an `R<n>` chip so round messages read at a glance
 * as different from ambient chat.
 */
function renderRoundRow(l: LogEntry, g: GroupView): ReactElement {
  const key = `g-${g.id}-${l.at}-${l.kind}-${l.from ?? ''}-${l.round ?? ''}`;
  if (l.kind === 'start' || l.kind === 'round' || l.kind === 'end' || l.kind === 'member') {
    const label = l.kind === 'round' ? `Round ${l.round} of ${g.maxRounds}` : l.text;
    return (
      <div key={key} className="text-[11px] text-[--text-muted] text-center py-1 flex items-center gap-2">
        <span className="flex-1 border-t border-[--border]" />
        <span className="px-2 py-0.5 rounded-full bg-[--panel] border border-[--border]" title={`Group chat ${g.name}`}>
          {label}
        </span>
        <span className="flex-1 border-t border-[--border]" />
      </div>
    );
  }
  // reply / fail / you — render as a chat-like row with engine colour.
  const info = l.from ? g.memberInfo[l.from] : undefined;
  const engine = info?.engine ?? 'claude';
  const name = info?.name ?? l.from ?? 'You';
  const colour = ENGINE_COLOUR[engine];
  const engineLabel = ENGINE_LABEL[engine];
  const isUser = l.kind === 'you';
  const isFail = l.kind === 'fail';
  return (
    <div
      key={key}
      className={`text-sm pl-2 ${isFail ? 'opacity-70' : ''}`}
      style={{ borderLeft: `3px solid ${isUser ? 'var(--accent)' : colour}` }}
    >
      <span className="text-[--text-muted] text-xs">
        {new Date(l.at).toLocaleTimeString()}{' '}
      </span>
      {l.round != null && (
        <span className="px-1 py-0 rounded text-[10px] font-semibold bg-[--accent]/15 text-[--accent-soft-text] mr-1" title={`Round ${l.round} of ${g.maxRounds} in group ${g.name}`}>
          R{l.round}
        </span>
      )}
      {!isUser && (
        <span
          className="px-1 py-0 rounded text-[10px] font-semibold text-white mr-1"
          style={{ background: colour }}
          title={`${name} — running on ${engineLabel}`}
        >
          {engineLabel}
        </span>
      )}
      <span className={`font-medium ${isUser ? 'text-[--accent-soft-text]' : 'text-[--text]'}`}>
        {isUser ? 'You' : name}
      </span>{' '}
      <span className={isFail ? 'text-[--hue-red]' : ''}>{l.text}</span>
      {isFail && <span className="text-[--hue-red] text-xs ml-2" title="This member couldn't complete its turn; the round moves on without it.">· failed</span>}
    </div>
  );
}

/** Same grammar as shared/chat-mention.ts's MENTION_RE, kept separate so
 *  the body renderer owns its own matcher (and can keep the regex state
 *  it needs for split/exec without stomping on parseMentions callers). */
const BODY_MENTION_RE = /@([a-z][a-z0-9-]*)(?:#(\d+))?(?:@([a-z0-9][a-z0-9.-]*))?/gi;

/** Split a message body into plain-text and highlighted mention nodes so
 *  `@claude#0`, `@human`, `@codex@laptop` etc. embedded in prose read as
 *  routing hints, not opaque text. Highlighting matches the sender tag's
 *  accent-soft-text color but without the font-medium weight — the sender
 *  (left of the body) stays the strongest visual anchor in the row. */
function renderBodyWithMentions(body: string) {
  const out: Array<string | ReactElement> = [];
  let last = 0;
  let key = 0;
  // matchAll works because BODY_MENTION_RE is /g. Each match carries its
  // index, so slicing between index and index+match[0].length gives the
  // plain-text runs that frame the mentions.
  for (const m of body.matchAll(BODY_MENTION_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(body.slice(last, idx));
    out.push(
      <span key={key++} className="text-[--accent-soft-text]">{m[0]}</span>,
    );
    last = idx + m[0].length;
  }
  if (last < body.length) out.push(body.slice(last));
  return out;
}

/** Returns true if ≥2 agents share the same family on the same device —
 *  the "nickname them so you can tell apart" tip is only useful then. */
function sameFamilyCount(roster: readonly { agent: string; device: string; online: boolean }[]): number {
  const counts = new Map<string, number>();
  for (const r of roster) {
    if (!r.online) continue;
    const k = `${r.agent}@${r.device}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let max = 0;
  for (const n of counts.values()) if (n > max) max = n;
  return max;
}

/**
 * Find the @word around the caret. Returns `{ start, end, query }` where
 * `start` points at the `@` and `query` is the chars after it. Returns
 * null when the caret isn't inside a fresh @word.
 */
function extractAgentMention(text: string, caret: number): { start: number; end: number; query: string } | null {
  if (caret < 0 || caret > text.length) return null;
  let i = caret;
  while (i > 0) {
    const ch = text[i - 1]!;
    if (ch === '@') {
      const prev = i >= 2 ? text[i - 2]! : ' ';
      if (!/[\s(\[{,;:!?]/.test(prev)) return null;
      const query = text.slice(i, caret);
      if (!/^[a-zA-Z0-9._-]*$/.test(query)) return null;
      let j = caret;
      while (j < text.length && /[a-zA-Z0-9._-]/.test(text[j]!)) j++;
      return { start: i - 1, end: j, query };
    }
    if (!/[a-zA-Z0-9._-]/.test(ch)) return null;
    i--;
  }
  return null;
}
