/**
 * Chat -> PTY injector. Watches `chat:changed`, matches each entry's
 * `to` list against the live roster, and writes a single
 * `[metaide-chat ...] <body>\n` line into every recipient shell on this
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
  admitWithRelease(entry: ChatEntry): { verdict: CapVerdict; released: string[] };
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
  /** Called when per-shell rate limiting drops delivery. The pane uses
   *  this to badge the row "rate-limited"; without it, the sender has no
   *  signal that the message vanished. Optional for backwards compat with
   *  tests that don't care about the badge. */
  onRateDropped?: (projectId: number, entry: ChatEntry) => void;
  /** Called after delivery resolved — the pane uses `delivered` to flag
   *  messages whose `to` list has no matching local shell. Not called for
   *  rate-dropped or cap-held entries (those have their own surfacing). */
  onDelivered?: (projectId: number, entry: ChatEntry, delivered: number) => void;
  /** Looks up an entry by id so released-from-cap messages can be replayed
   *  without any renderer round-trip. Called for each queued id a human
   *  post drains; a null return means the log doesn't have it any more. */
  lookupEntry?: (projectId: number, id: string) => ChatEntry | null;
  hooks: {
    onChatChanged(cb: (payload: ChatChangedPayload) => void): void;
  };
}

/** Mention segments must canonicalise cleanly; anything else is suspicious
 * (hostile peer, prompt-injected agent) and collapses to the literal safe
 * placeholder `unknown`. Keeps the injected prefix forgery-proof — a
 * crafted `from.agent` can never smuggle a second framed header into the
 * line. */
const SAFE_SEGMENT = /^[a-z][a-z0-9-]{0,31}$/;
function safeSeg(s: string | undefined): string {
  return s && SAFE_SEGMENT.test(s.toLowerCase()) ? s.toLowerCase() : 'unknown';
}

/** Reply-in must be a tame id-like string. Loose enough to accept both
 * the real id shape (ts-device-counter) and short test fixtures, strict
 * enough to keep brackets, spaces, and shell metachars out. */
const SAFE_REPLY_IN = /^[a-zA-Z0-9][a-zA-Z0-9.\-_]{0,63}$/;

// Built via RegExp() from a string so esbuild does not choke on the
// literal U+2028 / U+2029 line-separator chars in a regex literal.
const ESC_STRIPPER = new RegExp(
  '\\x1b(?:' +
    '\\[[\\x30-\\x3f]*[\\x20-\\x2f]*[\\x40-\\x7e]' +
    '|\\][\\s\\S]*?(?:\\x07|\\x1b\\\\)' +
    '|P[\\s\\S]*?\\x1b\\\\' +
    '|_[\\s\\S]*?\\x1b\\\\' +
    '|\\^[\\s\\S]*?\\x1b\\\\' +
    '|X[\\s\\S]*?\\x1b\\\\' +
    '|.' +
  ')',
  'g',
);
// Strip all C0 controls except tab (0x09), DEL, C1 controls, and Unicode
// line separators. The `+` collapses runs (e.g. CRLF -> one space) so a
// two-char line separator doesn't produce two spaces in the output.
const CONTROL_STRIPPER = new RegExp(
  '[\\x00-\\x08\\x0a-\\x1f\\x7f-\\x9f\\u2028\\u2029]+',
  'g',
);

/** Strip every ESC-prefixed control sequence (CSI/OSC/DCS/APC/PM/SOS/
 * single char), every C0/C1 control except tab, DEL, and Unicode line
 * separators. Leaves printable characters intact. */
function sanitiseBody(raw: string): string {
  return raw.replace(ESC_STRIPPER, '').replace(CONTROL_STRIPPER, ' ');
}

/** Wire format the injector writes into recipient PTYs. Sender's shell
 * index is deliberately omitted — the receiving agent only needs the
 * family + device to reply correctly.
 *
 * The protocol prefix is wrapped in SGR dim (`\x1b[2m` on, `\x1b[22m`
 * off) so the recipient's shell renders it as quiet framing against the
 * agent's own output. Dim is a pure rendering-state toggle: a TUI
 * either honours it or ignores it, and the LLM behind still
 * pattern-matches `[metaide-chat …]` either way. 22 (not 0) resets dim
 * without touching color, so a subsequent body color in the agent's
 * echo survives. */
export function formatInjectionLine(entry: ChatEntry, selfDevice: string): string {
  const from = formatMention({
    agent: safeSeg(entry.from.agent),
    device: safeSeg(entry.from.device ?? selfDevice),
  });
  const reply = entry.reply_in && SAFE_REPLY_IN.test(entry.reply_in) ? entry.reply_in : '-';
  // Plain-text prefix, no SGR dim: TUI agents (Claude Code, Codex,
  // opencode, …) read stdin through Ink's input widget, where a bare
  // `\x1b` is the Escape key. The leading `\x1b[2m` wrapper used to get
  // interpreted as "ESC + unknown CSI", which cleared the input buffer
  // before the body ever made it, so the message sat in the prompt and
  // never submitted. Plain ASCII makes the TUI insert the whole line
  // verbatim. The Enter keystroke (CR) is NOT appended here — the caller
  // writes the body and CR as two separate PTY writes with a small gap
  // between them, so Ink's input handler sees text first, then an Enter
  // key event. Concatenating them made Ink treat the whole chunk as one
  // paste and skip submit.
  return `[metaide-chat from=${from} reply=${reply} ] ${sanitiseBody(entry.body)}`;
}

/** Common delivery path: resolve mentions against the roster and write
 * the formatted line into every matching local shell. Returns the number
 * of PTYs the entry was actually written to — 0 means every mention
 * resolved to an offline agent, which the pane surfaces as "not
 * delivered". Factored so a cap-release can replay a queued entry
 * through the same code path. */
function deliver(deps: WireChatInjectorDeps, projectId: number, entry: ChatEntry): number {
  if (!entry.to || entry.to.length === 0) return 0;
  const roster = deps.roster();
  const line = formatInjectionLine(entry, deps.selfDevice);
  const seen = new Set<number>();
  let delivered = 0;
  for (const mention of entry.to) {
    if (mention.agent === 'human') continue;
    for (const row of roster) {
      if (row.agent === 'human') continue;
      if (row.device !== deps.selfDevice) continue;
      if (mention.agent && mention.agent !== 'all' && mention.agent !== row.agent) continue;
      if (mention.shell !== undefined && mention.shell !== row.shell) continue;
      if (mention.device && mention.device !== row.device) continue;
      if (row.shell === entry.from.shell && row.device === entry.from.device) continue;
      if (seen.has(row.shell)) continue;
      seen.add(row.shell);
      // Explicit bracketed paste + separate Enter. Bracketed-paste
      // markers (ESC[200~ … ESC[201~) tell any VT-aware TUI "this chunk
      // is paste content, don't treat any byte inside it as a key event".
      // Claude Code and Codex both enable bracketed-paste mode on startup
      // (`\x1b[?2004h`), and both respect the brackets. Sending the body
      // this way removes the timing guesswork that broke Codex — different
      // agents disagree on paste-debounce windows, but they agree on the
      // brackets.
      //
      // After a 40 ms gap the CR arrives as a standalone keypress and
      // every tested TUI (Claude Code, Codex, plain bash readline, zsh,
      // opencode) treats it as Enter = submit.
      const bracketed = `\x1b[200~${line}\x1b[201~`;
      deps.pty.write(projectId, row.shell, bracketed);
      setTimeout(() => { deps.pty.write(projectId, row.shell, '\r'); }, 40);
      delivered++;
    }
  }
  return delivered;
}

/** Install the subscription; one call per main-process lifetime. */
export function wireChatInjector(deps: WireChatInjectorDeps): void {
  deps.hooks.onChatChanged(({ projectId, entry }) => {
    // Metadata re-broadcasts (cap_held, undelivered) travel the same bus
    // so the pane can badge the row. The injector must not re-enter the
    // cap for them — doing so would admit as 'cap' again and recurse
    // via `onCapHeld` until the stack blows, or trigger another
    // undelivered broadcast and loop the same way.
    if (entry.meta?.cap_held || entry.meta?.undelivered || entry.meta?.rate_dropped) return;
    const { verdict, released } = deps.cap.admitWithRelease(entry);
    // A human post releases every message queued behind the cap. Replay
    // them through the normal delivery path in insertion order — the
    // recipient sees the queued conversation before this human line.
    if (released.length && deps.lookupEntry) {
      for (const id of released) {
        const queued = deps.lookupEntry(projectId, id);
        if (queued) deliver(deps, projectId, queued);
      }
    }
    if (verdict === 'rate') {
      console.debug('[chat] rate-limited', { entry: entry.id });
      deps.onRateDropped?.(projectId, entry);
      return;
    }
    if (verdict === 'cap') {
      deps.onCapHeld(projectId, entry);
      return;
    }
    // Only non-broadcast, non-@human-only entries can meaningfully have
    // a delivery count. Humans are addressable but never injected, so if
    // every mention is @human the "0 delivered" signal is noise, not
    // information — skip the onDelivered call in that case.
    const hasAgentTarget = (entry.to ?? []).some((m) => m.agent !== 'human');
    const count = deliver(deps, projectId, entry);
    if (hasAgentTarget && deps.onDelivered) deps.onDelivered(projectId, entry, count);
  });
}
