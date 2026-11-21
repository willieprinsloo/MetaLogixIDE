/**
 * The group panel's pure helpers (ported from BotOffice public/group-view.js):
 *   statusLine(group) → "Round 2 of 4 · waiting for X and Y" | the end reason | "Ready"
 *   lines(group)      → the transcript rows: you | reply | fail | round | note
 */
import type { GroupView, MemberEngine } from '@shared/group-chat';

export interface TranscriptLine {
  kind: 'you' | 'reply' | 'fail' | 'round' | 'note';
  /** The member's display name, for replies and failures. */
  who?: string;
  engine?: MemberEngine;
  text: string;
  at: string;
  round?: number;
}

const both = (names: string[]): string =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

export function statusLine(g: GroupView): string {
  if (g.status === 'running' && g.round) {
    const head = `Round ${g.k} of ${g.maxRounds}`;
    const waiting = g.round.waiting ?? [];
    const draft = waiting.find((m) => g.memberInfo[m]?.phase === 'waiting-draft');
    if (draft) return `${head} · waiting for you to send or clear your draft in ${g.memberInfo[draft]!.name}`;
    return waiting.length ? `${head} · waiting for ${both(waiting.map((m) => g.memberInfo[m]?.name ?? 'a former member'))}` : head;
  }
  const last = g.log[g.log.length - 1];
  return last?.kind === 'end' ? last.text : 'Ready';
}

const KIND: Record<string, TranscriptLine['kind']> = { start: 'you', you: 'you', reply: 'reply', fail: 'fail', round: 'round', member: 'note', end: 'note' };

export function lines(g: GroupView): TranscriptLine[] {
  const out: TranscriptLine[] = [];
  for (const e of g.log) {
    const kind = KIND[e.kind];
    if (!kind) continue;
    const line: TranscriptLine = { kind, text: e.text, at: e.at, round: e.round };
    if ((kind === 'reply' || kind === 'fail') && e.from) {
      const m = g.memberInfo[e.from];
      line.who = m?.name ?? 'A former member';
      if (m) line.engine = m.engine;
    }
    out.push(line);
  }
  return out;
}
