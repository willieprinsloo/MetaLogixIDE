/**
 * Reads a Claude tab's answer to a group-chat round from its transcript
 * (`~/.claude/projects/<folder>/<session>.jsonl`, one JSON event per line).
 *
 * The answer is the assistant text after the LAST user message that starts
 * with the round's header line, up to the next real user message (a prompt
 * the user typed themselves). `tool_result` user lines are part of Claude's
 * own turn and don't end the answer. A half-written last line is normal
 * while Claude is still writing, so unparseable lines are skipped.
 */
import { readFile } from 'node:fs/promises';

export type TranscriptAnswer = { status: 'answered'; text: string } | { status: 'not-yet' };

type Part = { type?: unknown; text?: unknown };
interface Line { type?: unknown; message?: { content?: unknown } }

function parse(raw: string): Line | null {
  try {
    const v = JSON.parse(raw) as unknown;
    return typeof v === 'object' && v !== null ? (v as Line) : null;
  } catch {
    return null;
  }
}

/** Text of a user line, or null when it is only tool results (not something a person typed). */
function userText(line: Line): string | null {
  const c = line.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return null;
  const texts = (c as Part[]).filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text as string);
  return texts.length ? texts.join('\n') : null;
}

function assistantText(line: Line): string {
  const c = line.message?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return (c as Part[]).filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text as string).join('');
}

export function findGroupAnswer(jsonl: string, header: string): TranscriptAnswer {
  const lines = jsonl.split(/\r?\n/).filter((l) => l.trim() !== '').map(parse).filter((l): l is Line => l !== null);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (l.type === 'user' && userText(l)?.startsWith(header)) { start = i; break; }
  }
  if (start < 0) return { status: 'not-yet' };
  const parts: string[] = [];
  for (const l of lines.slice(start + 1)) {
    if (l.type === 'user' && userText(l) !== null) break;
    if (l.type === 'assistant') {
      const t = assistantText(l).trim();
      if (t) parts.push(t);
    }
  }
  return parts.length ? { status: 'answered', text: parts.join('\n\n') } : { status: 'not-yet' };
}

export async function readGroupAnswer(path: string, header: string): Promise<TranscriptAnswer> {
  try {
    return findGroupAnswer(await readFile(path, 'utf8'), header);
  } catch {
    return { status: 'not-yet' };
  }
}
