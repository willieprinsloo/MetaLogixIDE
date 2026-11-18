/** Reads what a pairing QR code holds: the desktop's `metaide://pair?code=…&relay=…&port=…` link, or a bare pair code. */
import { Schema } from 'effect';
import { ConnectCode } from './schemas';

const RelayHost = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9.-]{1,253}$|^\[[0-9A-Fa-f:]+\]$/));
/** A port as it appears in the link: digits only, 1 to 65535. */
const RelayPort = Schema.String.check(Schema.isPattern(/^\d{1,5}$/));

export type PairLink = { code: string; relayHost?: string; relayPort?: number };

const isCode = Schema.is(ConnectCode);
const isHost = Schema.is(RelayHost);
const isPort = Schema.is(RelayPort);

function decode(v: string): string {
  try { return decodeURIComponent(v.replace(/\+/g, ' ')); } catch { return ''; }
}

export function parsePairLink(text: string): PairLink | null {
  const s = text.trim();
  if (isCode(s)) return { code: s };
  const m = /^metaide:\/\/pair\/?\?([^#]*)/i.exec(s);
  if (!m) return null;
  const q = new Map<string, string>();
  for (const part of m[1]!.split('&')) {
    const i = part.indexOf('=');
    if (i > 0 && !q.has(part.slice(0, i))) q.set(part.slice(0, i), decode(part.slice(i + 1)));
  }
  const code = (q.get('code') ?? '').trim();
  if (!isCode(code)) return null;
  const out: PairLink = { code };
  const host = (q.get('relay') ?? '').trim();
  if (isHost(host)) out.relayHost = host;
  const port = q.get('port') ?? '';
  if (isPort(port) && Number(port) > 0 && Number(port) < 65536) out.relayPort = Number(port);
  return out;
}
