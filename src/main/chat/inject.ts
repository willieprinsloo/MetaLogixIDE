/**
 * Chat → PTY injector. Watches `chat:changed`, matches each entry's
 * `to` list against the live roster, and writes a single
 * `[metaide-chat …] <body>\n` line into every recipient shell on this
 * device. `@human` is never injected (humans read the pane); entries
 * with an empty `to` list are logged-only broadcasts.
 *
 * The cap gate runs before delivery. A `cap` verdict fires
 * `onCapHeld` so the UI can badge the thread; a `rate` verdict is
 * dropped with a debug log (the sending agent is already over budget
 * and shouldn't be funnelled through a queue).
 */
import type { ChatEntry } from '@shared/chat';
import type { RosterRow } from './roster';
import type { CapVerdict } from './cap';
import { formatMention } from '@shared/chat-mention';

export interface InjectPtyDep {
  write(projectId: number, shellIndex: number, data: string): void;
}

export interface InjectCapDep {
  admit(entry: ChatEntry): CapVerdict;
  release(threadRoot: string): string[];
}

export interface ChatChangedPayload {
  projectId: number;
  entry: ChatEntry;
}

export interface WireChatInjectorDeps {
  pty: InjectPtyDep;
  /** Called once per incoming entry; returns the current roster snapshot. */
  roster: () => RosterRow[];
  cap: InjectCapDep;
  selfDevice: string;
  /** Called when the cap gate holds delivery — the pane uses this to badge. */
  onCapHeld: (projectId: number, entry: ChatEntry) => void;
  hooks: {
    onChatChanged(cb: (payload: ChatChangedPayload) => void): void;
  };
}

/** Wire format the injector writes into recipient PTYs. Sender's shell
 * index is deliberately omitted — the receiving agent only needs the
 * family + device to reply correctly. */
export function formatInjectionLine(entry: ChatEntry, selfDevice: string): string {
  const from = formatMention({
    agent: entry.from.agent,
    device: entry.from.device ?? selfDevice,
  });
  const reply = entry.reply_in ?? '-';
  // Strip ANSI CSI sequences and any CR/LF so the whole message lands
  // on one PTY line. Collapse to spaces so adjacent words stay separable.
  const body = entry.body
    .replace(/\x1b\[[^m]*m/g, '')
    .replace(/[\r\n]+/g, ' ');
  return `[metaide-chat from=${from} reply=${reply} ] ${body}\n`;
}

/** Install the subscription; one call per main-process lifetime. */
export function wireChatInjector(deps: WireChatInjectorDeps): void {
  deps.hooks.onChatChanged(({ projectId, entry }) => {
    if (!entry.to || entry.to.length === 0) return; // logged-only broadcast
    const verdict = deps.cap.admit(entry);
    if (verdict === 'rate') {
      console.debug('[chat] rate-limited', { entry: entry.id });
      return;
    }
    if (verdict === 'cap') {
      deps.onCapHeld(projectId, entry);
      return;
    }
    const roster = deps.roster();
    const line = formatInjectionLine(entry, deps.selfDevice);
    const seen = new Set<number>();
    for (const mention of entry.to) {
      // @human is addressable but NEVER stdin-injected.
      if (mention.agent === 'human') continue;
      for (const row of roster) {
        if (row.agent === 'human') continue;
        if (row.device !== deps.selfDevice) continue;
        // Agent filter: 'all' matches everyone, otherwise strict equality.
        if (mention.agent && mention.agent !== 'all' && mention.agent !== row.agent) continue;
        if (mention.shell !== undefined && mention.shell !== row.shell) continue;
        if (mention.device && mention.device !== row.device) continue;
        // Never echo back to the sender's own shell.
        if (row.shell === entry.from.shell && row.device === entry.from.device) continue;
        if (seen.has(row.shell)) continue;
        seen.add(row.shell);
        deps.pty.write(projectId, row.shell, line);
      }
    }
  });
}
