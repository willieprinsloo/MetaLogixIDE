/**
 * @-mention grammar for the chat bus.
 *
 *   @claude                  → { agent: 'claude' }
 *   @claude#2                → { agent: 'claude', shell: 2 }
 *   @claude@mac-mini         → { agent: 'claude', device: 'mac-mini' }
 *   @claude#1@laptop         → { agent: 'claude', shell: 1, device: 'laptop' }
 *   @all                     → { agent: 'all' } (broadcast marker)
 *   @human                   → { agent: 'human' } (addressable; never injected)
 *
 * The parser is deliberately small and permissive. Lowercase every
 * capture so the composer can roundtrip without worrying about case.
 */
import type { ChatMention } from './chat';

const MENTION_RE = /@([a-z][a-z0-9-]*)(?:#(\d+))?(?:@([a-z0-9][a-z0-9.-]*))?/gi;

export function parseMentions(body: string): ChatMention[] {
  const out: ChatMention[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(MENTION_RE)) {
    const agent = m[1]?.toLowerCase();
    if (!agent) continue;
    const mention: ChatMention = { agent };
    if (m[2]) mention.shell = Number(m[2]);
    if (m[3]) mention.device = m[3].toLowerCase();
    const key = formatMention(mention);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(mention);
  }
  return out;
}

export function formatMention(m: ChatMention): string {
  const agent = m.agent ?? '';
  const shell = m.shell != null ? `#${m.shell}` : '';
  const device = m.device ? `@${m.device}` : '';
  return `@${agent}${shell}${device}`;
}
